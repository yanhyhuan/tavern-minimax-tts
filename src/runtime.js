export const MINIMAX_HOSTS = Object.freeze([
    'https://api.minimax.chat',
    'https://api.minimaxi.com',
    'https://api.minimax.io',
    'https://api.minimaxi.chat',
]);

export function miniMaxHost(value) {
    const url = new URL(value);
    if (!MINIMAX_HOSTS.includes(url.origin) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
        throw new Error('请选择扩展内置的 MiniMax API 地址');
    }
    return url.origin;
}

// Keep the signal alive through response.json()/blob(), not only until headers arrive.
export function fetchRemote(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('远程 API 必须使用不含用户名或密码的 HTTPS 地址');
    }
    const timeout = AbortSignal.timeout(45000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return fetch(parsed.href, { ...options, signal, redirect: 'error' });
}

export async function fetchRemoteWithRetry(url, options, { retryCount = 2, retryBaseDelay = 900 } = {}) {
    const retries = Math.max(0, Math.min(5, Math.trunc(Number(retryCount) || 0)));
    const delay = Math.max(0, Math.min(8000, Number(retryBaseDelay) || 0));
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await fetchRemote(url, options);
            const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
            if (!retryable || attempt >= retries) return response;
            await response.body?.cancel();
        } catch (error) {
            if (options.signal?.aborted || attempt >= retries || !['TypeError', 'AbortError', 'TimeoutError'].includes(error.name)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, delay * (attempt + 1))));
        options.signal?.throwIfAborted();
    }
}
