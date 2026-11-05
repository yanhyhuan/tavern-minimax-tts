import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostFileStore } from '../src/host-storage.js';
import { loadIndex, mockFiles, memoryTtStore } from './helpers/index-harness.mjs';

test('two ST browsers share favorites and audio with server plugins absent', async () => {
    const host = mockFiles();
    const first = await loadIndex(host);
    const audio = new Blob(['ID3-favorite']);
    const added = await Promise.all(Array.from({ length: 8 }, (_, i) => first.favoriteRequest('', {
        method: 'POST', body: { _blob: audio, title: `voice-${i}`, format: 'mp3' },
    })));
    const second = await loadIndex(host);
    assert.equal((await second.favoriteRequest()).length, 8);
    assert.equal(await (await second.getFavoriteAudioBlob(added[0].id)).text(), 'ID3-favorite');
    await second.favoriteRequest(`/${added[0].id}`, { method: 'PATCH', body: { note: 'another browser' } });
    assert.equal((await first.favoriteRequest()).find(item => item.id === added[0].id).note, 'another browser');
    await second.favoriteRequest(`/${added[0].id}`, { method: 'DELETE' });
    assert.equal((await first.favoriteRequest()).length, 7);
    assert.equal(host.requests.some(request => request.url.includes('/api/plugins/')), false);
});

test('parallel cache uploads retain every index entry and cleanup spares favorites', async () => {
    const host = mockFiles();
    const api = await loadIndex(host);
    const favorite = await api.favoriteRequest('', { method: 'POST', body: { _blob: new Blob(['fav']) } });
    await Promise.all(Array.from({ length: 5 }, (_, i) => api.uploadToSTServer(new Blob([`cache-${i}`]), `cache-${i}.mp3`)));
    assert.equal((await api.getAudioCacheStatsUnified()).files, 5);
    const meta = await api.localStoreGetJson('cache', 'index');
    for (const value of Object.values(meta)) value.mtimeMs = 1;
    await api.localStoreSetJson('cache', 'index', meta);
    const cleaned = await api.cleanupAudioCacheUnified({ maxAgeDays: 1 });
    assert.equal(cleaned.deletedFiles, 5);
    assert.equal(await (await api.getFavoriteAudioBlob(favorite.id)).text(), 'fav');
});

test('TT synchronization preserves both API keys, settings, favorites and model bytes', async () => {
    const host = mockFiles();
    const firstStore = memoryTtStore();
    const settings = { apiKey: 'fake-minimax-key', llmPresets: [{ key: 'fake-llm-key', model: 'test' }], bindings: [{ speaker: 'Alice' }] };
    const first = await loadIndex({ ...host, ttStore: firstStore, settings });
    const favorite = await first.favoriteRequest('', { method: 'POST', body: { _blob: new Blob(['audio']) } });
    const modelRef = await first.vrmServerUpload(new Blob(['glTF-model']));
    first.getSettings().vrmModelUrl = modelRef;
    const syncedStore = memoryTtStore();
    for (const [key, value] of firstStore.json) syncedStore.json.set(key, structuredClone(value));
    for (const [key, value] of firstStore.blobs) syncedStore.blobs.set(key, value);
    const second = await loadIndex({ ...host, ttStore: syncedStore, settings: structuredClone(first.getSettings()) });
    assert.equal(second.getSettings().apiKey, settings.apiKey);
    assert.equal(second.getSettings().llmPresets[0].key, settings.llmPresets[0].key);
    assert.equal(await (await second.getFavoriteAudioBlob(favorite.id)).text(), 'audio');
    assert.equal(await (await second.localStoreGetBlob('models', 'avatar.vrm')).text(), 'glTF-model');
    let modelLoaded = false;
    second.setVrmModule({ loadModel: async url => { assert.ok(url.startsWith('blob:')); modelLoaded = true; } });
    await second.loadConfiguredVrmModel(second.getSettings().vrmModelUrl);
    assert.ok(modelLoaded);
    assert.equal(host.requests.length, 0);
});

test('file API failures are reported and never silently become browser-only storage', async () => {
    const store = createHostFileStore({
        getHeaders: () => ({}), encodeBlob: async () => 'e30=',
        fetchImpl: async () => new Response('denied', { status: 403 }),
    });
    await assert.rejects(store.getJson('favorites', 'index', []), /403/);
    await assert.rejects(store.setJson('favorites', 'index', []), /403/);
    await assert.rejects(store.getBlob('models', '../secret'), /无效/);
});

test('legacy server favorites migrate resumably without depending on its runtime routes', async () => {
    const host = mockFiles();
    let failSecond = true;
    const fetchImpl = async (url, options) => {
        if (url.endsWith('/minimax-quote-tts/status')) return Response.json({ success: true });
        if (url.endsWith('/minimax-quote-tts/favorites')) return Response.json([{ id: 'old-a', text: 'x'.repeat(18000), note: 'n'.repeat(1800) }, { id: 'old-b' }]);
        if (url.includes('/minimax-quote-tts/favorites/')) {
            if (url.includes('old-b') && failSecond) return new Response('temporary error', { status: 503 });
            return new Response('legacy-audio');
        }
        return host.fetchImpl(url, options);
    };
    const api = await loadIndex({ fetchImpl });
    api.skipBrowserMigration();
    await assert.rejects(api.migrateLegacyStorage(), /503/);
    assert.equal((await api.favoriteRequest()).length, 1);
    failSecond = false;
    await api.migrateLegacyStorage();
    await api.migrateLegacyStorage();
    assert.equal((await api.favoriteRequest()).length, 2);
    const migrated = (await api.favoriteRequest()).find(item => item.legacyKey === 'server-v1:old-a');
    assert.equal(migrated.text.length, 18000);
    assert.equal(migrated.note.length, 1800);
    assert.equal(await api.localStoreGetJson('migration', 'server-plugin-v1'), true);
});
