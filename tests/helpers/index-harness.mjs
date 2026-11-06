import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHostFileStore } from '../../src/host-storage.js';
import { fetchLlmResponse } from '../../src/host-requests.js';
import { fetchRemote, miniMaxHost } from '../../src/runtime.js';

export function mockFiles() {
    const files = new Map();
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
        requests.push({ url, options });
        if (url === '/api/files/upload') {
            const { name, data } = JSON.parse(options.body);
            files.set(`/user/files/${name}`, Buffer.from(data, 'base64'));
            return Response.json({ path: `user/files/${name}` });
        }
        if (url === '/api/files/delete') {
            files.delete(JSON.parse(options.body).path);
            return new Response();
        }
        if (files.has(url)) return new Response(files.get(url));
        return new Response('Not found', { status: 404 });
    };
    return { files, requests, fetchImpl };
}

export async function loadIndex({
    fetchImpl, settings = {}, ttStore = null, fetchRemoteImpl = fetchRemote,
    hostContext = {}, AudioImpl = class {},
    documentImpl = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
} = {}) {
    const source = (await readFile(new URL('../../index.js', import.meta.url), 'utf8'))
        .replace(/^import .*;\r?\n/gm, '');
    const context = vm.createContext({
        Blob, Response, Headers, AbortSignal, URL, console, setTimeout, clearTimeout,
        fetch: fetchImpl,
        Audio: AudioImpl,
        document: documentImpl,
        window: ttStore ? { __TAURITAVERN__: { api: { extension: { store: ttStore } } } } : {},
        jQuery: () => {},
        getContext: () => hostContext,
        extension_settings: { minimax_quote_tts: settings },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token' }),
        saveSettingsDebounced: () => {},
        toastr: { warning() {}, success() {}, error() {} },
        fetchRemoteWithRetry: fetchRemoteImpl, miniMaxHost,
        fetchLlmResponse: (url, options, hostOptions) => fetchLlmResponse(
            url, options, fetchImpl ? { ...hostOptions, fetchImpl } : hostOptions,
        ),
        createHostFileStore: options => createHostFileStore({
            ...options, fetchImpl,
            encodeBlob: async blob => Buffer.from(await blob.arrayBuffer()).toString('base64'),
        }),
    });
    vm.runInContext(source + `
        loadSettings();
        globalThis.api = {
            localStoreGetJson, localStoreSetJson, localStoreGetBlob, localStoreSetBlob,
            favoriteRequest, getFavoriteAudioBlob, uploadToSTServer, getAudioCacheStatsUnified,
            cleanupAudioCacheUnified, migrateLegacyStorage, vrmServerUpload, loadConfiguredVrmModel,
            requestTtsAudioBlob, isBubbleCached, formatWithSecondaryApi, generateMessageSpeech,
            playBubbleSpeech: (...args) => playBubbleSpeech(...args),
            stopMessagePlayback, playGeneratedMessage, getMessageData,
            setCachedAudio(item, blob) { localAudioCache.set(audioCacheKey(item), blob); },
            getSettings: s,
            setVrmModule(module) { vrmModule = module; },
            skipBrowserMigration() { readLegacyBrowserValue = async () => true; },
        };
    `, context);
    return context.api;
}

export function memoryTtStore() {
    const json = new Map();
    const blobs = new Map();
    const key = input => `${input.namespace}/${input.table}/${input.key}`;
    return {
        json, blobs,
        tryGetJson: async input => ({ found: json.has(key(input)), value: structuredClone(json.get(key(input))) }),
        getJson: async input => structuredClone(json.get(key(input))),
        setJson: async input => { json.set(key(input), structuredClone(input.value)); },
        getBlob: async input => blobs.get(key(input)) || null,
        setBlob: async input => { blobs.set(key(input), input.data); },
        deleteBlob: async input => { blobs.delete(key(input)); },
    };
}
