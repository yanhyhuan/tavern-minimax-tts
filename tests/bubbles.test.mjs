import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex } from './helpers/index-harness.mjs';

test('speech with a leading pause still reports its generated audio as cached', async () => {
    const api = await loadIndex();
    const item = { text: '第二段台词。', pauseMs: 320, serverPath: 'tt-store://cache/test.wav' };
    assert.equal(api.isBubbleCached(item), true);
    assert.equal(api.isBubbleCached({ ...item, pauseMs: 0 }), true);
});

test('pause-only and blank segments do not report playable cached audio', async () => {
    const api = await loadIndex();
    for (const item of [null, { pauseMs: 320 }, { text: '', pauseMs: 320 },
        { text: '   ', serverPath: 'tt-store://cache/test.wav' }]) {
        assert.equal(api.isBubbleCached(item), false);
    }
    assert.equal(api.isBubbleCached({ text: '尚未合成。', pauseMs: 320, options: {} }), false);
});
