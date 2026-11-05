import test from 'node:test';
import assert from 'node:assert/strict';
import { hostLlmRequest, fetchLlmResponse } from '../src/host-requests.js';
import { loadIndex, mockFiles } from './helpers/index-harness.mjs';

test('plugin-free synthesis keeps emotion, language and Group ID in the official MiniMax payload', async () => {
    let captured;
    const api = await loadIndex({ ...mockFiles(), fetchRemoteImpl: async (url, options) => {
        captured = { url, body: JSON.parse(options.body) };
        return Response.json({ base_resp: { status_code: 0 }, data: { audio: '494433' } });
    } });
    const audio = await api.requestTtsAudioBlob({
        text: 'hello', apiKey: 'fake-test-key', apiHost: 'https://api.minimax.io', groupId: 'group-test',
        model: 'speech-2.8-hd', voiceId: 'test-voice', emotion: 'happy', language: 'English',
        speed: 0.9, volume: 1.1, pitch: 2,
    });
    assert.equal(await audio.text(), 'ID3');
    assert.equal(new URL(captured.url).searchParams.get('GroupId'), 'group-test');
    assert.deepEqual(captured.body.voice_setting, { voice_id: 'test-voice', speed: 0.9, vol: 1.1, pitch: 2, emotion: 'happy' });
    assert.equal(captured.body.language_boost, 'English');
});

test('secondary model and streaming use built-in ST routes without overwriting main provider keys', () => {
    const request = hostLlmRequest('https://llm.example/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer secondary-fake' },
        body: { model: 'secondary', messages: [{ role: 'user', content: 'test' }], stream: true, seed: 7 },
    }, { 'X-CSRF-Token': 'csrf-test' });
    assert.equal(request.url, '/api/backends/chat-completions/generate');
    const body = JSON.parse(request.options.body);
    assert.equal(body.stream, true);
    assert.equal(body.custom_url, 'https://llm.example/v1');
    assert.equal(JSON.parse(body.custom_include_headers).Authorization, 'Bearer secondary-fake');
    assert.equal(JSON.parse(body.custom_include_body).seed, 7);
    assert.equal(request.options.headers['X-CSRF-Token'], 'csrf-test');
    assert.equal(body.api_key, undefined);
    const unauthenticated = hostLlmRequest('https://llm.example/v1/models');
    assert.equal(JSON.parse(JSON.parse(unauthenticated.options.body).custom_include_headers).Authorization, '');
});

test('native Google model lists and responses keep the extension response format', async () => {
    const options = { native: true, getHeaders: () => ({}) };
    const models = await fetchLlmResponse('https://generativelanguage.googleapis.com/v1beta/models', {}, {
        ...options, fetchImpl: async (_url, request) => {
            assert.equal(JSON.parse(request.body).reverse_proxy, 'https://generativelanguage.googleapis.com');
            return Response.json({ data: [{ id: 'gemini-test' }] });
        },
    });
    assert.equal((await models.json()).models[0].name, 'gemini-test');
    const response = await fetchLlmResponse('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent', {
        method: 'POST', headers: { 'x-goog-api-key': 'fake-google-key' },
        body: { contents: [{ role: 'user', parts: [{ text: 'test' }] }] },
    }, { ...options, fetchImpl: async (_url, request) => {
        assert.equal(JSON.parse(request.body).proxy_password, 'fake-google-key');
        return Response.json({ choices: [{ message: { content: 'connected' } }] });
    } });
    assert.equal((await response.json()).candidates[0].content.parts[0].text, 'connected');
});

test('stream cancellation reaches the host and invalid remote destinations are rejected', async () => {
    const controller = new AbortController();
    let capturedSignal;
    const response = await fetchLlmResponse('https://llm.example/v1/chat/completions', {
        method: 'POST', body: { stream: true, messages: [] }, signal: controller.signal,
    }, { native: true, getHeaders: () => ({}), fetchImpl: async (_url, request) => {
        capturedSignal = request.signal;
        return new Response('data: [DONE]\n\n');
    } });
    assert.equal(await response.text(), 'data: [DONE]\n\n');
    controller.abort();
    assert.ok(capturedSignal.aborted);
    for (const url of ['http://llm.example/v1/models', 'https://user:pass@llm.example/v1/models', 'https://llm.example/v1/models#bad']) {
        assert.throws(() => hostLlmRequest(url), /HTTPS/);
    }
});

test('HTTP 200 provider errors are surfaced during voice calls and buffered replies remain readable', async () => {
    const options = { method: 'POST', body: { stream: true, messages: [] } };
    const native = { native: true, getHeaders: () => ({}) };
    await assert.rejects(fetchLlmResponse('https://llm.example/v1/chat/completions', options, {
        ...native, fetchImpl: async () => Response.json({ error: { message: 'Invalid fake API key' } }),
    }), /Invalid fake API key/);
    const buffered = await fetchLlmResponse('https://llm.example/v1/chat/completions', options, {
        ...native, fetchImpl: async () => Response.json({ choices: [{ message: { content: 'buffered reply' } }] }),
    });
    assert.match(buffered.headers.get('Content-Type'), /event-stream/);
    assert.match(await buffered.text(), /buffered reply/);
});
