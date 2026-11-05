import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('every extension-local static and dynamic module is included in the release', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])(\.\/[^'"]+)\1/g)];
    assert.ok(imports.length >= 2);
    for (const match of imports) await access(new URL('../' + match[2], import.meta.url));
    const runtime = await import('../vrm.js');
    for (const name of ['init', 'loadModel', 'resize', 'setPixelRatio', 'setAnalyser',
        'setState', 'setEmotion', 'playAction', 'setEmotionFromText', 'isReady', 'destroy']) {
        assert.equal(typeof runtime[name], 'function', name);
    }
    assert.equal(runtime.isReady(), false);
});
