import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { loadIndex } from './helpers/index-harness.mjs';

async function setup(t) {
    const players = [];
    class TestAudio {
        src = '';
        paused = true;
        playCalls = 0;
        onended = null;
        onerror = null;
        constructor() { players.push(this); }
        pause() { this.paused = true; }
        async play() { this.playCalls++; this.paused = false; }
        removeAttribute(name) { if (name === 'src') this.src = ''; }
    }
    const message = { name: '娱乐圈世界', mes: '“第一段。” “第二段。”', is_user: false };
    const chatContext = { chatId: 'playback-test', name1: '林鹿', name2: '娱乐圈世界', chat: [message] };
    const api = await loadIndex({ hostContext: chatContext, AudioImpl: TestAudio });
    const { key } = api.getMessageData(0);
    assert.ok(key.startsWith('playback-test:0:'));
    const items = ['第一段。', '第二段。'].map(text => ({ text, options: { voiceId: 'test', model: 'speech-2.8-hd' } }));
    api.getSettings().serverHistory[key] = { activeIndex: 0, versions: [{ items }] };
    items.forEach(item => api.setCachedAudio(item, new Blob([item.text])));
    t.after(() => api.stopMessagePlayback());
    return { api, audio: players[0], players, message,
        bubbles: items.map((_, segidx) => ({ dataset: { mesid: '0', segidx: String(segidx) } })) };
}

test('a second click on the same bubble stops its audio instead of ignoring the click', async t => {
    const { api, audio, bubbles } = await setup(t);
    await api.playBubbleSpeech(bubbles[0]);
    assert.equal(audio.paused, false);
    assert.equal(audio.playCalls, 1);
    await api.playBubbleSpeech(bubbles[0]);
    assert.equal(audio.paused, true);
    assert.equal(audio.src, '');
    assert.equal(audio.playCalls, 1);
});

test('the shared stop control also stops bubble playback', async t => {
    const { api, audio, bubbles } = await setup(t);
    await api.playBubbleSpeech(bubbles[0]);
    api.stopMessagePlayback();
    assert.equal(audio.paused, true);
    assert.equal(audio.src, '');
    assert.equal(audio.onended, null);
    assert.equal(audio.onerror, null);
});

test('stopping while a bubble is waiting for audio prevents late playback', async t => {
    const { api, audio, bubbles } = await setup(t);
    const pending = api.playBubbleSpeech(bubbles[0]);
    api.stopMessagePlayback();
    await pending;
    assert.equal(audio.playCalls, 0);
    assert.equal(audio.src, '');
});

test('switching bubbles discards the earlier pending play and uses one audio element', async t => {
    const { api, audio, players, bubbles } = await setup(t);
    await Promise.all([api.playBubbleSpeech(bubbles[0]), api.playBubbleSpeech(bubbles[1])]);
    assert.equal(players.length, 1);
    assert.equal(audio.playCalls, 1);
    assert.equal(await (await fetch(audio.src)).text(), '第二段。');
});

test('message playback replaces a bubble and a late old ended event cannot stop it', async t => {
    const { api, audio, bubbles } = await setup(t);
    await api.playBubbleSpeech(bubbles[0]);
    const oldEnded = audio.onended;
    await api.playGeneratedMessage(0);
    await setImmediate();
    oldEnded();
    assert.equal(audio.paused, false);
    assert.equal(audio.playCalls, 2);
    audio.onended();
    await setImmediate();
    assert.equal(audio.playCalls, 3);
    assert.equal(await (await fetch(audio.src)).text(), '第二段。');
});

test('changing the message before pending audio resolves prevents playback', async t => {
    const { api, audio, message, bubbles } = await setup(t);
    const pending = api.playBubbleSpeech(bubbles[0]);
    message.mes = '消息已切换。';
    await pending;
    assert.equal(audio.playCalls, 0);
    assert.equal(audio.src, '');
});

test('a rejected bubble play releases its audio and another click can retry', async t => {
    const { api, audio, bubbles } = await setup(t);
    const originalPlay = audio.play;
    audio.play = async () => { throw new Error('fixture playback failure'); };
    await api.playBubbleSpeech(bubbles[0]);
    assert.equal(audio.src, '');
    assert.equal(audio.paused, true);
    audio.play = originalPlay;
    await api.playBubbleSpeech(bubbles[0]);
    assert.equal(audio.playCalls, 1);
    assert.equal(audio.paused, false);
});

test('a media error and rejected play advance a queued segment only once', async t => {
    const { api, audio } = await setup(t);
    const originalPlay = audio.play;
    let rejectedUrl;
    audio.play = function () {
        if (!rejectedUrl) {
            rejectedUrl = this.src;
            this.onerror();
            return Promise.reject(new Error('fixture media error'));
        }
        return originalPlay.call(this);
    };
    await api.playGeneratedMessage(0);
    await setImmediate();
    assert.equal(audio.playCalls, 1);
    assert.equal(await (await fetch(audio.src)).text(), '第二段。');
    await assert.rejects(fetch(rejectedUrl));
});
