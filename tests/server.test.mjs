import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { init } from '../legacy/server-plugin/index.js';

test('server rejects private targets and persists concurrent favorites', async t => {
    const previousDirectory = process.cwd();
    const directory = await mkdtemp(path.join(tmpdir(), 'minimax-tts-test-'));
    process.chdir(directory);
    t.after(async () => { process.chdir(previousDirectory); await rm(directory, { recursive: true, force: true }); });
    const routes = new Map();
    const router = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [
        method, (route, handler) => routes.set(`${method} ${route}`, handler),
    ]));
    await init(router);
    async function call(method, route, body = {}, params = {}) {
        const result = {
            code: 200, body: null, headers: {},
            status(value) { this.code = value; return this; },
            json(value) { this.body = value; return this; },
            send(value) { this.body = value; return this; },
            setHeader(key, value) { this.headers[key] = value; return this; },
        };
        await routes.get(`${method} ${route}`)({ body, params }, result);
        return result;
    }
    const blocked = await call('post', '/generate-voice', {
        apiKey: 'test-only-not-a-real-secret', apiHost: 'https://attacker.example',
        voiceId: 'test-voice', text: 'test',
    });
    assert.equal(blocked.code, 400);
    assert.match(blocked.body.error, /MiniMax/);
    const privateProxy = await call('post', '/proxy', { url: 'https://[::ffff:127.0.0.1]' });
    assert.equal(privateProxy.code, 400);
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => call('post', '/favorites', {
        title: `test-${i}`, text: '测试音频', audioBase64: Buffer.from('ID3-test-audio').toString('base64'),
    })));
    assert.ok(created.every(result => result.code === 201));
    const list = await call('get', '/favorites');
    assert.equal(list.body.length, 12);
    assert.equal(new Set(list.body.map(item => item.id)).size, 12);
    const persisted = JSON.parse(await readFile(path.join(directory, 'data/minimax-quote-tts/metadata/favorites.json'), 'utf8'));
    assert.equal(persisted.length, 12);
    const exported = await call('get', '/favorites/export');
    const backup = JSON.parse(exported.body);
    assert.equal(backup.items.length, 12);
    assert.ok(backup.items.every(item => item.audioBase64));
    const status = await call('get', '/status');
    assert.equal(status.body.success, true);
    assert.equal(status.body.missingAudio, 0);
    assert.ok(!JSON.stringify(status.body).includes('test-only-not-a-real-secret'));
});
