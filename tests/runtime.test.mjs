import test from 'node:test';
import assert from 'node:assert/strict';
import { miniMaxHost, fetchRemote, fetchRemoteWithRetry, MINIMAX_HOSTS } from '../src/runtime.js';
import { isPublicAddress, resolvePublicHttps } from '../legacy/server-plugin/network.js';

test('MiniMax credentials may only be sent to built-in HTTPS origins', () => {
    for (const host of MINIMAX_HOSTS) assert.equal(miniMaxHost(host), host);
    for (const host of ['https://example.com', 'http://api.minimax.chat',
        'https://api.minimax.chat.evil.example', 'https://user:pass@api.minimax.chat',
        'https://api.minimax.chat/another-path', 'https://api.minimax.chat?redirect=1']) {
        assert.throws(() => miniMaxHost(host));
    }
});

test('API fetch disallows redirects, applies timeout and preserves cancellation', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let captured;
    globalThis.fetch = async (url, options) => { captured = { url, options }; return new Response('{}'); };
    const controller = new AbortController();
    await fetchRemote('https://api.minimax.chat/v1/t2a_v2', { method: 'POST', signal: controller.signal });
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.method, 'POST');
    controller.abort();
    assert.equal(captured.options.signal.aborted, true);
    assert.throws(() => fetchRemote('http://example.com'));
    assert.throws(() => fetchRemote('https://user:secret@example.com'));
});

test('direct synthesis retries transient failures but not authentication failures or cancellation', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let attempts = 0;
    globalThis.fetch = async () => new Response('', { status: ++attempts < 3 ? 429 : 200 });
    assert.equal((await fetchRemoteWithRetry('https://api.minimax.io/v1/t2a_v2', {}, { retryCount: 2, retryBaseDelay: 0 })).status, 200);
    assert.equal(attempts, 3);
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response('', { status: 401 }); };
    assert.equal((await fetchRemoteWithRetry('https://api.minimax.io/v1/t2a_v2', {}, { retryCount: 5 })).status, 401);
    assert.equal(attempts, 1);
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = async () => { throw controller.signal.reason; };
    await assert.rejects(fetchRemoteWithRetry('https://api.minimax.io/v1/t2a_v2', { signal: controller.signal }), /abort/i);
});

test('proxy blocks private/reserved IPs, mapped IPv6 and alternative loopback spellings', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1',
        '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1',
        '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    for (const url of ['https://127.0.0.1', 'https://2130706433', 'https://0x7f000001',
        'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://localhost', 'https://private.local']) {
        await assert.rejects(resolvePublicHttps(url), /禁止/, url);
    }
    assert.equal(isPublicAddress('1.1.1.1'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('DNS rejects mixed public/private records and returns one pinned IP', async () => {
    let calls = 0;
    const resolver = async () => { calls++; return [{ address: '1.1.1.1', family: 4 }]; };
    const result = await resolvePublicHttps('https://api.example.com/v1', resolver);
    assert.equal(calls, 1);
    assert.deepEqual(result.address, { address: '1.1.1.1', family: 4 });
    assert.equal(result.url.hostname, 'api.example.com');
    await assert.rejects(resolvePublicHttps('https://api.example.com', async () => [
        { address: '1.1.1.1', family: 4 }, { address: '192.168.0.1', family: 4 },
    ]), /禁止/);
});
