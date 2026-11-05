import { fetchRemote } from './runtime.js';

// Use ST's existing provider routes without changing the user's main LLM or its keys.
export function hostLlmRequest(url, options = {}, hostHeaders = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) {
        throw new Error('副模型 API 必须使用不含用户名、密码、查询或片段的 HTTPS 地址');
    }
    const headers = new Headers(options.headers);
    const data = typeof options.body === 'string' ? JSON.parse(options.body) : (options.body || {});
    let route;
    let body;
    let google = false;
    if (/\/chat\/completions\/?$/.test(target.pathname)) {
        if ((options.method || 'GET').toUpperCase() !== 'POST') throw new Error('副模型生成需要 POST 请求');
        route = 'generate';
        body = {
            ...data,
            chat_completion_source: 'custom',
            custom_url: target.href.replace(/\/chat\/completions\/?$/, ''),
            custom_include_headers: JSON.stringify({ Authorization: headers.get('Authorization') || '' }),
            custom_include_body: JSON.stringify(data),
        };
    } else if (/\/v1beta\/models(?:\/[^/]+:generateContent)?$/.test(target.pathname)) {
        google = true;
        const match = target.pathname.match(/^(.*)\/v1beta\/models(?:\/(.+):generateContent)?$/);
        route = match[2] ? 'generate' : 'status';
        body = {
            chat_completion_source: 'makersuite',
            reverse_proxy: target.origin + match[1],
            proxy_password: headers.get('x-goog-api-key') || '',
            ...(match[2] ? {
                model: decodeURIComponent(match[2]),
                messages: (data.contents || []).map(content => ({
                    role: content.role === 'model' ? 'assistant' : 'user',
                    content: (content.parts || []).map(part => part.text || '').join('\n'),
                })),
                stream: false,
                temperature: data.generationConfig?.temperature,
                max_tokens: data.generationConfig?.maxOutputTokens,
            } : {}),
        };
    } else if (/\/models\/?$/.test(target.pathname)) {
        if ((options.method || 'GET').toUpperCase() !== 'GET') throw new Error('模型列表需要 GET 请求');
        route = 'status';
        body = {
            chat_completion_source: 'custom',
            custom_url: target.href.replace(/\/models\/?$/, ''),
            custom_include_headers: JSON.stringify({ Authorization: headers.get('Authorization') || '' }),
        };
    } else {
        throw new Error('不支持的副模型 API 路径，请填写 OpenAI 兼容或 Google API 地址');
    }
    return {
        url: `/api/backends/chat-completions/${route}`,
        options: {
            method: 'POST',
            headers: { ...hostHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: options.signal,
        },
        google,
        models: route === 'status',
    };
}

export async function fetchLlmResponse(url, options, { native = false, getHeaders, fetchImpl = (...args) => fetch(...args) }) {
    if (!native) return fetchRemote(url, options);
    const request = hostLlmRequest(url, options, getHeaders());
    const response = await fetchImpl(request.url, {
        ...request.options,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(45000),
    });
    if (response.ok && JSON.parse(request.options.body).stream && response.headers.get('Content-Type')?.includes('application/json')) {
        const data = await response.json();
        if (data.error) throw new Error(data.error.message || data.message || (typeof data.error === 'string' ? data.error : '副模型请求失败'));
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('副模型未返回可读取的文本或流式响应');
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
            headers: { 'Content-Type': 'text/event-stream' },
        });
    }
    if (!request.google || !response.ok) return response;
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || data.message || 'Google 副模型请求失败');
    const converted = request.models
        ? { models: (data.data || []).map(model => ({ name: model.id || model.name || model })) }
        : { candidates: [{ content: { parts: [{ text: data.choices?.[0]?.message?.content || '' }] } }] };
    return new Response(JSON.stringify(converted), { headers: { 'Content-Type': 'application/json' } });
}
