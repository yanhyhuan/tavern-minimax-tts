import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requestPublicHttps } from './network.js';

const fetchImpl = requestPublicHttps;
const PLUGIN_ID = 'minimax-quote-tts';
const DEFAULT_HOST = 'https://api.minimax.io';
const FALLBACK_HOSTS = ['https://api.minimax.io', 'https://api.minimaxi.chat', 'https://api.minimax.chat'];
const ALLOWED_HOSTS = new Set([...FALLBACK_HOSTS, 'https://api.minimaxi.com']);
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm', flac: 'audio/flac', aac: 'audio/aac' };
const SAFE_FORMATS = new Set(Object.keys(MIME));
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
let dataRoot;
let indexWriteQueue = Promise.resolve();
let indexMutationQueue = Promise.resolve();

function jsonError(res, status, message) { return res.status(status).json({ error: String(message || '请求失败') }); }
function cleanHost(value) {
    const u = new URL(value || DEFAULT_HOST);
    if (u.protocol !== 'https:') throw new Error('MiniMax API 地址必须使用 HTTPS');
    if (u.username || u.password) throw new Error('API 地址不能包含用户名或密码');
    if (!ALLOWED_HOSTS.has(u.origin)) throw new Error('仅允许内置的 MiniMax 官方 API 地址');
    return u.origin;
}
function numberIn(value, min, max, fallback, name) {
    const n = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 必须在 ${min} 到 ${max} 之间`);
    return n;
}
function safeId(id) { return typeof id === 'string' && /^[a-f0-9-]{16,64}$/i.test(id); }
function safeFilename(name, format) {
    const base = String(name || 'voice').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'voice';
    return `${base}.${format}`;
}
async function ensureDirs() {
    for (const p of ['favorites/audio', 'metadata', 'cache']) await fs.mkdir(path.join(dataRoot, p), { recursive: true });
}
const indexPath = () => path.join(dataRoot, 'metadata', 'favorites.json');
async function readIndex() {
    try { const x = JSON.parse(await fs.readFile(indexPath(), 'utf8')); return Array.isArray(x) ? x : []; }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function writeIndex(items) {
    const snapshot = JSON.stringify(items, null, 2);
    const write = async () => {
        const target = indexPath(), temp = `${target}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temp, snapshot, { mode: 0o600 });
        await fs.rename(temp, target);
    };
    // Serialize metadata commits so simultaneous favorite operations cannot
    // interleave their atomic rename operations.
    indexWriteQueue = indexWriteQueue.then(write, write);
    return indexWriteQueue;
}
async function mutateIndex(mutator) {
    const run = async () => {
        const items = await readIndex();
        const result = await mutator(items);
        await writeIndex(items);
        return result;
    };
    indexMutationQueue = indexMutationQueue.then(run, run);
    return indexMutationQueue;
}
function audioPath(id, format) { return path.join(dataRoot, 'favorites', 'audio', `${id}.${format}`); }
function decodeAudio(input) {
    if (typeof input !== 'string' || input.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 16) throw new Error('音频数据无效或过大');
    const raw = input.replace(/^data:audio\/[\w.+-]+;base64,/i, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('音频 Base64 格式无效');
    const b = Buffer.from(raw, 'base64');
    if (!b.length || b.length > MAX_AUDIO_BYTES) throw new Error('音频文件为空或超过 40MB');
    return b;
}
function cacheFileName(input) {
    const name = path.basename(String(input || '')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140);
    if (!/^tts_[a-f0-9_-]+\.(mp3|wav|pcm|flac|aac)$/i.test(name)) throw new Error('缓存文件名无效');
    return name;
}
async function cacheStats() {
    const dir = path.join(dataRoot, 'cache'); const names = await fs.readdir(dir).catch(() => []);
    let bytes = 0, files = 0;
    for (const name of names) { if (!/\.(mp3|wav|pcm|flac|aac)$/i.test(name)) continue; try { const st = await fs.stat(path.join(dir, name)); if (st.isFile()) { bytes += st.size; files++; } } catch {} }
    return { bytes, files };
}
async function cleanupAudioCache(maxAgeDays = 7, maxMB = 1024) {
    const dir = path.join(dataRoot, 'cache'); const names = await fs.readdir(dir).catch(() => []);
    const rows = [];
    for (const name of names) {
        if (!/\.(mp3|wav|pcm|flac|aac)$/i.test(name)) continue;
        try { const file = path.join(dir, name), st = await fs.stat(file); if (st.isFile()) rows.push({ file, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
    const now = Date.now(), maxAge = Math.max(1, Math.min(365, Number(maxAgeDays) || 7)) * 86400000;
    const limit = Math.max(100, Math.min(20480, Number(maxMB) || 1024)) * 1048576;
    let total = rows.reduce((n, x) => n + x.size, 0), deletedFiles = 0, freedBytes = 0;
    // First remove expired items, then oldest items until under the configured cap.
    const expired = rows.filter(x => now - x.mtime > maxAge);
    const remove = async x => { await fs.unlink(x.file).catch(() => {}); total -= x.size; deletedFiles++; freedBytes += x.size; };
    for (const x of expired) await remove(x);
    const remaining = rows.filter(x => !expired.includes(x)).sort((a,b) => a.mtime-b.mtime);
    for (const x of remaining) { if (total <= limit) break; await remove(x); }
    return { deletedFiles, freedBytes, ...(await cacheStats()) };
}
export const info = { id: PLUGIN_ID, name: 'MINIMAX TTS', description: 'MINIMAX TTS V1.1 server plugin: API proxy, managed audio cache and persistent favorites', version: '1.1.0', author: 'Local' };
export async function init(router) {
    dataRoot = path.join(process.cwd(), 'data', PLUGIN_ID);
    await ensureDirs();

    // Read-only diagnostics: never exposes API credentials or message text.
    router.get('/status', async (_req, res) => {
        try {
            const items = await readIndex();
            let audioBytes = 0, missingAudio = 0;
            for (const item of items) {
                try { audioBytes += (await fs.stat(audioPath(item.id, item.format))).size; }
                catch { missingAudio++; }
            }
            return res.json({
                success: true,
                version: 'V1.1',
                node: process.version,
                favorites: items.length,
                audioBytes,
                missingAudio,
                checkedAt: new Date().toISOString(),
            });
        } catch (e) { return jsonError(res, 500, e.message); }
    });

    // 普通 TTS 缓存与收藏分开保存；缓存可按保留天数和容量自动清理。
    router.get('/cache/status', async (_req, res) => { try { return res.json(await cacheStats()); } catch (e) { return jsonError(res, 500, e.message); } });
    router.post('/cache/cleanup', async (req, res) => { try { return res.json(await cleanupAudioCache(req.body?.maxAgeDays, req.body?.maxMB)); } catch (e) { return jsonError(res, 500, e.message); } });
    router.post('/cache', async (req, res) => {
        try {
            const filename = cacheFileName(req.body?.filename);
            const format = filename.split('.').pop().toLowerCase();
            const audio = decodeAudio(req.body?.audioBase64);
            const target = path.join(dataRoot, 'cache', filename);
            await fs.writeFile(target, audio, { mode: 0o600 });
            await cleanupAudioCache(req.body?.maxAgeDays, req.body?.maxMB);
            return res.status(201).json({ success: true, path: `/api/plugins/${PLUGIN_ID}/cache/${encodeURIComponent(filename)}`, size: audio.length, format });
        } catch (e) { return jsonError(res, 400, e.message); }
    });
    router.get('/cache/:filename', async (req, res) => {
        try {
            const filename = cacheFileName(req.params.filename);
            const file = path.join(dataRoot, 'cache', filename);
            const format = filename.split('.').pop().toLowerCase();
            res.setHeader('Content-Type', MIME[format] || MIME.mp3);
            res.setHeader('Cache-Control', 'private, max-age=3600');
            return res.sendFile(file);
        } catch (e) { return jsonError(res, 404, '缓存文件不存在'); }
    });

    router.post('/generate-voice', async (req, res) => {
        try {
            const { text, voiceId, model = 'speech-2.8-hd', speed = 1, volume = 1, pitch = 0, audioSampleRate = 32000, bitrate = 128000, format = 'mp3', emotion, language } = req.body || {};
            const apiKey = String(req.body?.apiKey || process.env.MINIMAX_API_KEY || '').trim();
            const groupId = String(req.body?.groupId || process.env.MINIMAX_GROUP_ID || '').trim();
            if (typeof text !== 'string' || !text.trim() || text.length > 10000 || !voiceId || !apiKey) return jsonError(res, 400, '缺少文本、音色或 MiniMax API Key');
            if (!SAFE_FORMATS.has(format)) return jsonError(res, 400, '不支持的音频格式');
            const body = {
                model, text, stream: false,
                voice_setting: { voice_id: String(voiceId), speed: numberIn(speed, 0.5, 2, 1, 'speed'), vol: numberIn(volume, 0.1, 10, 1, 'volume'), pitch: numberIn(pitch, -12, 12, 0, 'pitch') },
                audio_setting: { sample_rate: numberIn(audioSampleRate, 8000, 48000, 32000, 'sample rate'), bitrate: numberIn(bitrate, 32000, 512000, 128000, 'bitrate'), format },
            };
            if (emotion) {
                const allowedEmotions = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper']);
                if (!allowedEmotions.has(String(emotion))) return jsonError(res, 400, '不支持的情绪值');
                body.voice_setting.emotion = String(emotion);
            }
            if (language) body.language_boost = String(language);
            const requested = cleanHost(req.body?.apiHost || DEFAULT_HOST);
            const hosts = [...new Set([requested, ...FALLBACK_HOSTS])];
            let lastError;
            for (const host of hosts) {
                try {
                    const query = groupId ? `?GroupId=${encodeURIComponent(groupId)}` : '';
                    const upstream = await fetchImpl(`${host}/v1/t2a_v2${query}`, {
                        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'MM-API-Source': 'SillyTavern-TTS' }, body: JSON.stringify(body),
                    });
                    const data = await upstream.json().catch(() => ({}));
                    const code = data?.base_resp?.status_code;
                    if (upstream.status === 404 || code === 2049) { lastError = new Error(data?.base_resp?.status_msg || `MiniMax ${upstream.status || code}`); continue; }
                    if (!upstream.ok || (code !== undefined && code !== 0)) return jsonError(res, 502, data?.base_resp?.status_msg || data?.message || `MiniMax HTTP ${upstream.status}`);
                    let audio;
                    if (data?.data?.audio) {
                        const hex = String(data.data.audio).replace(/^0x/i, '').replace(/\s/g, '');
                        if (!/^(?:[a-f0-9]{2})+$/i.test(hex)) throw new Error('MiniMax 返回了无效的十六进制音频');
                        audio = Buffer.from(hex, 'hex');
                    } else if (data?.data?.url) {
                        const u = new URL(data.data.url);
                        if (u.protocol !== 'https:') throw new Error('音频下载地址不是 HTTPS');
                        const file = await fetchImpl(u, { redirect: 'error' });
                        if (!file.ok) throw new Error(`音频下载失败：HTTP ${file.status}`);
                        const ab = await file.arrayBuffer(); audio = Buffer.from(ab);
                    } else throw new Error('MiniMax 未返回音频数据');
                    if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new Error('返回音频为空或超过 40MB');
                    res.setHeader('Content-Type', MIME[format]);
                    res.setHeader('Cache-Control', 'no-store');
                    return res.send(audio);
                } catch (e) { lastError = e; }
            }
            return jsonError(res, 502, lastError?.message || '无法连接 MiniMax 服务');
        } catch (e) { return jsonError(res, 400, e.message); }
    });

    router.post('/proxy', async (req, res) => {
        try {
            const { url, method = 'POST', headers = {}, body } = req.body || {};
            if (!url) return jsonError(res, 400, '缺少代理 URL');
            const target = url;
            const verb = String(method).toUpperCase();
            if (!['GET', 'POST'].includes(verb)) return jsonError(res, 400, '代理仅允许 GET / POST');
            const safeHeaders = {};
            for (const [k, v] of Object.entries(headers || {})) {
                if (/^(authorization|content-type|accept|anthropic-version|x-api-key)$/i.test(k) && typeof v === 'string' && v.length < 4096) safeHeaders[k] = v;
            }
            const upstream = await fetchImpl(target, { method: verb, headers: safeHeaders, body: verb === 'GET' || body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'error' });
            const data = await upstream.text();
            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
            return res.send(data);
        } catch (e) { return jsonError(res, 400, e.message); }
    });

    router.get('/favorites', async (_req, res) => { try { return res.json(await readIndex()); } catch (e) { return jsonError(res, 500, e.message); } });
    // Portable backup: metadata and audio are packed into one JSON file.
    router.get('/favorites/export', async (_req, res) => {
        try {
            const items = await readIndex();
            if (items.length > 200) return jsonError(res, 413, '收藏超过 200 条，请分批整理后再导出');
            let total = 0;
            const packed = [];
            for (const item of items) {
                const audio = await fs.readFile(audioPath(item.id, item.format));
                total += audio.length;
                if (total > 80 * 1024 * 1024) return jsonError(res, 413, '收藏音频总量超过 80MB，请分批导出');
                packed.push({ ...item, audioBase64: audio.toString('base64') });
            }
            const backup = { format: 'minimax-quote-tts-favorites', version: 1, exportedAt: new Date().toISOString(), items: packed };
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''minimax-quote-tts-favorites-${new Date().toISOString().slice(0,10)}.json`);
            return res.send(JSON.stringify(backup));
        } catch (e) { return jsonError(res, 500, e.message); }
    });
    router.post('/favorites/import', async (req, res) => {
        const createdFiles = [];
        try {
            const backup = req.body || {};
            if (backup.format !== 'minimax-quote-tts-favorites' || !Array.isArray(backup.items)) return jsonError(res, 400, '不是有效的 MiniMax 收藏备份文件');
            if (backup.items.length > 200) return jsonError(res, 413, '单次最多恢复 200 条收藏');
            let total = 0;
            const imported = [];
            for (const raw of backup.items) {
                if (!raw || !SAFE_FORMATS.has(raw.format)) continue;
                const audio = decodeAudio(raw.audioBase64);
                total += audio.length;
                if (total > 80 * 1024 * 1024) throw new Error('备份音频总量超过 80MB');
                const id = crypto.randomUUID();
                await fs.writeFile(audioPath(id, raw.format), audio, { flag: 'wx', mode: 0o600 });
                createdFiles.push(audioPath(id, raw.format));
                imported.push({
                    id, filename: safeFilename(raw.title || raw.speaker || 'voice', raw.format), format: raw.format, size: audio.length,
                    title: String(raw.title || '导入的语音').slice(0,160), text: String(raw.text || '').slice(0,20000),
                    speaker: String(raw.speaker || '').slice(0,160), voiceId: String(raw.voiceId || '').slice(0,256),
                    model: String(raw.model || '').slice(0,100), emotion: String(raw.emotion || '').slice(0,40),
                    speed: Number.isFinite(Number(raw.speed)) ? Number(raw.speed) : 1, pitch: Number.isFinite(Number(raw.pitch)) ? Number(raw.pitch) : 0,
                    tags: Array.isArray(raw.tags) ? raw.tags.filter(x => typeof x === 'string').slice(0,30).map(x => x.slice(0,64)) : [],
                    note: String(raw.note || '').slice(0,2000), source: {}, createdAt: new Date().toISOString(),
                });
            }
            await mutateIndex(all => { all.unshift(...imported); return imported.length; });
            return res.json({ success: true, imported: imported.length });
        } catch (e) {
            await Promise.all(createdFiles.map(file => fs.unlink(file).catch(() => {})));
            return jsonError(res, 400, e.message);
        }
    });
    router.post('/favorites/batch-delete', async (req, res) => {
        try {
            const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids)] : [];
            if (!ids.length || ids.length > 200 || ids.some(id => !safeId(id))) return jsonError(res, 400, '请选择 1 到 200 条有效收藏');
            const removed = await mutateIndex(all => {
                const gone = all.filter(item => ids.includes(item.id));
                const goneIds = new Set(gone.map(item => item.id));
                for (let i = all.length - 1; i >= 0; i--) if (goneIds.has(all[i].id)) all.splice(i, 1);
                return gone;
            });
            await Promise.all(removed.map(item => fs.unlink(audioPath(item.id, item.format)).catch(() => {})));
            return res.json({ success: true, deleted: removed.length });
        } catch (e) { return jsonError(res, 500, e.message); }
    });
    router.post('/favorites', async (req, res) => {
        try {
            const { audioBase64, format = 'mp3', title = '', text = '', speaker = '', voiceId = '', model = '', emotion = '', speed = 1, pitch = 0, tags = [], note = '', source = {} } = req.body || {};
            if (!SAFE_FORMATS.has(format)) return jsonError(res, 400, '不支持的音频格式');
            const audio = decodeAudio(audioBase64);
            const id = crypto.randomUUID();
            const file = audioPath(id, format);
            await fs.writeFile(file, audio, { flag: 'wx', mode: 0o600 });
            const safeSource = source && typeof source === 'object' && !Array.isArray(source) ? { character: String(source.character || '').slice(0, 160), messageId: String(source.messageId || '').slice(0, 80) } : {};
            const item = { id, filename: safeFilename(title || speaker || 'voice', format), format, size: audio.length, title: String(title).slice(0, 160), text: String(text).slice(0, 20000), speaker: String(speaker).slice(0, 160), voiceId: String(voiceId).slice(0, 256), model: String(model).slice(0, 100), emotion: String(emotion).slice(0, 40), speed: Number.isFinite(Number(speed)) ? Number(speed) : 1, pitch: Number.isFinite(Number(pitch)) ? Number(pitch) : 0, tags: Array.isArray(tags) ? tags.filter(x => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 64)) : [], note: String(note).slice(0, 2000), source: safeSource, createdAt: new Date().toISOString() };
            await mutateIndex(all => { all.unshift(item); return item; });
            return res.status(201).json(item);
        } catch (e) { return jsonError(res, 400, e.message); }
    });
    router.get('/favorites/:id', async (req, res) => { if (!safeId(req.params.id)) return jsonError(res, 400, '收藏 ID 无效'); const item = (await readIndex()).find(x => x.id === req.params.id); return item ? res.json(item) : jsonError(res, 404, '收藏不存在'); });
    router.get('/favorites/:id/audio', async (req, res) => {
        try { if (!safeId(req.params.id)) return jsonError(res, 400, '收藏 ID 无效'); const item = (await readIndex()).find(x => x.id === req.params.id); if (!item) return jsonError(res, 404, '收藏不存在'); res.setHeader('Content-Type', MIME[item.format] || MIME.mp3); res.setHeader('Cache-Control', 'private, max-age=3600'); return res.sendFile(audioPath(item.id, item.format)); }
        catch (e) { return jsonError(res, 404, e.message); }
    });
    router.get('/favorites/:id/download', async (req, res) => {
        try { if (!safeId(req.params.id)) return jsonError(res, 400, '收藏 ID 无效'); const item = (await readIndex()).find(x => x.id === req.params.id); if (!item) return jsonError(res, 404, '收藏不存在'); res.setHeader('Content-Type', MIME[item.format] || MIME.mp3); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`); return res.sendFile(audioPath(item.id, item.format)); }
        catch (e) { return jsonError(res, 404, e.message); }
    });
    router.patch('/favorites/:id', async (req, res) => {
        try { if (!safeId(req.params.id)) return jsonError(res, 400, '收藏 ID 无效'); const item = await mutateIndex(all => { const found = all.find(x => x.id === req.params.id); if (!found) return null; for (const k of ['title', 'note', 'tags']) if (req.body?.[k] !== undefined) found[k] = k === 'tags' ? (Array.isArray(req.body[k]) ? req.body[k].filter(x => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 64)) : []) : String(req.body[k]).slice(0, k === 'note' ? 2000 : 160); return found; }); if (!item) return jsonError(res, 404, '收藏不存在'); return res.json(item); }
        catch (e) { return jsonError(res, 400, e.message); }
    });
    router.delete('/favorites/:id', async (req, res) => {
        try { if (!safeId(req.params.id)) return jsonError(res, 400, '收藏 ID 无效'); const item = await mutateIndex(all => { const i = all.findIndex(x => x.id === req.params.id); return i < 0 ? null : all.splice(i, 1)[0]; }); if (!item) return jsonError(res, 404, '收藏不存在'); await fs.unlink(audioPath(item.id, item.format)).catch(() => {}); return res.json({ success: true }); }
        catch (e) { return jsonError(res, 500, e.message); }
    });
}
