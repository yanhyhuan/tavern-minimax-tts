import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const forbiddenV4 = new BlockList();
for (const [ip, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) forbiddenV4.addSubnet(ip, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const forbiddenV6 = new BlockList();
for (const [ip, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]]) {
    forbiddenV6.addSubnet(ip, bits, 'ipv6');
}

export function isPublicAddress(address) {
    const family = isIP(address);
    if (family === 4) return !forbiddenV4.check(address, 'ipv4');
    if (family === 6) return globalV6.check(address, 'ipv6') && !forbiddenV6.check(address, 'ipv6');
    return false;
}

export async function resolvePublicHttps(raw, lookup = dns.lookup) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('代理仅允许不含凭据的 HTTPS URL');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || /\.(localhost|local)$/i.test(hostname)) {
        throw new Error('禁止访问本地地址');
    }
    let timer;
    try {
        const records = isIP(hostname)
            ? [{ address: hostname, family: isIP(hostname) }]
            : await Promise.race([
                lookup(hostname, { all: true, verbatim: true }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS 解析超时')), 10000); }),
            ]);
        if (!records.length || records.some(record => !isPublicAddress(record.address))) {
            throw new Error('禁止访问内网、保留或非公网地址');
        }
        return { url, address: records.find(record => record.family === 4) || records[0] };
    } finally { clearTimeout(timer); }
}

// Connect to the exact address already checked, preventing a second DNS lookup
// from rebinding a public hostname to loopback/private IPs. TLS still verifies the URL host.
export async function requestPublicHttps(raw, options = {}) {
    const { url, address } = await resolvePublicHttps(raw);
    return new Promise((resolve, reject) => {
        let timer;
        const request = https.request(url, {
            method: options.method || 'GET',
            headers: options.headers,
            agent: false,
            lookup: (_host, lookupOptions, callback) => lookupOptions?.all
                ? callback(null, [address]) : callback(null, address.address, address.family),
        }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > 40 * 1024 * 1024) request.destroy(new Error('上游响应超过 40MB'));
                else chunks.push(chunk);
            });
            response.on('error', fail);
            response.on('aborted', () => fail(new Error('上游响应中断')));
            response.on('end', () => {
                clearTimeout(timer);
                const status = response.statusCode || 502;
                if (status >= 300 && status < 400) return reject(new Error('代理禁止跟随重定向'));
                const headers = new Headers();
                if (response.headers['content-type']) headers.set('content-type', response.headers['content-type']);
                resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
            });
        });
        function fail(error) { clearTimeout(timer); reject(error); }
        request.on('error', fail);
        timer = setTimeout(() => request.destroy(new Error('上游请求超时（45秒）')), 45000);
        if (options.body != null) request.write(options.body);
        request.end();
    });
}
