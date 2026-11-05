const PREFIX = 'minimax-quote-tts-';

function filename(kind, table, key) {
    for (const value of [table, key]) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)) throw new Error('无效的扩展存储名称');
    }
    const name = `${PREFIX}${kind}-${table.length}-${table}-${key}${kind === 'json' ? '.json' : ''}`;
    if (name.length > 240) throw new Error('扩展存储文件名过长');
    return name;
}

export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
        reader.onabort = () => reject(new Error('文件读取已取消'));
        reader.readAsDataURL(blob);
    });
}

// SillyTavern and TT both expose the user-scoped Files API. No Node plugin is needed.
export function createHostFileStore({ getHeaders, fetchImpl = (...args) => fetch(...args), encodeBlob = blobToBase64 }) {
    async function request(url, options = {}) {
        return fetchImpl(url, {
            ...options,
            headers: { ...getHeaders(), ...options.headers },
            signal: options.signal || AbortSignal.timeout(120000),
            credentials: 'same-origin',
            cache: 'no-store',
        });
    }

    function filePath(name) { return `/user/files/${encodeURIComponent(name)}`; }

    async function read(name) {
        const response = await request(filePath(name));
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`酒馆文件读取失败 (HTTP ${response.status})`);
        return response;
    }

    async function upload(name, blob) {
        const response = await request('/api/files/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, data: await encodeBlob(blob) }),
        });
        if (!response.ok) throw new Error(`酒馆文件保存失败 (HTTP ${response.status})`);
        const result = await response.json();
        const returnedPath = String(result.path || '').replace(/^\/?/, '/');
        if (returnedPath !== filePath(name)) throw new Error('酒馆返回了不匹配的文件路径');
        return returnedPath;
    }

    return {
        async getJson(table, key, fallback = null) {
            const result = await this.tryGetJson(table, key);
            return result.found ? result.value : fallback;
        },
        async tryGetJson(table, key) {
            const response = await read(filename('json', table, key));
            if (!response) return { found: false };
            return { found: true, value: await response.json() };
        },
        async setJson(table, key, value) {
            await upload(filename('json', table, key), new Blob([JSON.stringify(value)], { type: 'application/json' }));
        },
        async getBlob(table, key) {
            const response = await read(filename('blob', table, key));
            return response ? response.blob() : null;
        },
        async setBlob(table, key, blob) {
            if (!(blob instanceof Blob)) throw new Error('待保存的文件必须是 Blob');
            return upload(filename('blob', table, key), blob);
        },
        async deleteBlob(table, key) {
            const response = await request('/api/files/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath(filename('blob', table, key)) }),
            });
            if (!response.ok && response.status !== 404) throw new Error(`酒馆文件删除失败 (HTTP ${response.status})`);
        },
    };
}
