import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex } from './helpers/index-harness.mjs';

const userLine = '佳凝，你上个月去百子湾跑组的时候，听说过这家星锐选角工作室吗？';
const characterLine = '星锐啊，苹果社区北区那栋楼里叫这个名字的选角工作室不少。';
const segments = [
    { text: userLine, speaker: '林鹿', emotion: 'calm', style: 'neutral', speed: 1, vol: 1, pitch: 0 },
    { text: characterLine, speaker: '孟佳凝', emotion: 'calm', style: 'neutral', speed: 1, vol: 1, pitch: 0 },
];

function makeChat() {
    return {
        chatId: 'formatter-test', characterId: 'world-1', name1: '林鹿', name2: '娱乐圈世界',
        powerUserSettings: { persona_description: '林鹿是用户扮演的演员。' },
        characters: { 'world-1': { description: '孟佳凝和林鹿在交谈。' } },
        chat: [
            { name: '林鹿', is_user: true, mes: '比选中消息更早的对话' },
            { name: '娱乐圈世界', is_user: false, mes: '选中消息之前的上下文' },
            { name: '娱乐圈世界', is_user: false, mes: `林鹿问：“${userLine}”\n孟佳凝答：“${characterLine}”` },
            { name: '娱乐圈世界', is_user: false, mes: '选中消息之后的未来内容' },
        ],
    };
}

function makeSettings(format = 'openai') {
    return {
        formatterEnabled: true, formatterPresetIdx: 0, emotionDirectorEnabled: false,
        formatterSystemPrompt: '保留实际说出的台词并输出 JSON。', directorContextCount: 2,
        llmPresets: [{ format, url: 'https://llm.example/v1', model: 'fixture-model' }],
        characterBindingsMap: { 'world-1': [
            { targetType: 'current_user', voiceId: 'voice-user', model: 'speech-2.8-hd' },
            { targetType: 'custom', customName: '孟佳凝', voiceId: 'voice-character', model: 'speech-2.8-hd' },
        ] },
    };
}

function makeFormatterFetch(responses = [segments]) {
    const requests = [];
    const fetchImpl = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        requests.push(JSON.parse(options.body));
        const items = responses[Math.min(requests.length - 1, responses.length - 1)];
        return Response.json({ choices: [{ message: { content: JSON.stringify({ segments: items }) } }] });
    };
    return { fetchImpl, requests };
}

test('AI message keeps user and character dialogue with their own bound voices', async () => {
    const hostContext = makeChat();
    const settings = makeSettings();
    const { fetchImpl, requests } = makeFormatterFetch();
    const api = await loadIndex({ fetchImpl, settings, hostContext });

    assert.equal(await api.generateMessageSpeech(2), true);
    assert.equal(requests.length, 1);
    const system = requests[0].messages[0].content;
    const input = requests[0].messages[1].content;
    assert.match(system, /用户角色（user）名.*林鹿/);
    assert.match(system, /林鹿是用户扮演的演员/);
    assert.match(system, /完整提取当前消息中所有实际说出的台词，包括用户角色的台词/);
    assert.match(system, /不要仅凭引号将标题、名称或心理活动视为说出的台词/);
    assert.match(input, /选中消息之前的上下文/);
    assert.doesNotMatch(input, /选中消息之后的未来内容/);
    const version = settings.serverHistory[api.getMessageData(2).key].versions[0];
    assert.equal(version.items.length, 2);
    assert.equal(version.items[0].text, userLine);
    assert.equal(version.items[0].speaker, '林鹿');
    assert.equal(version.items[0].options.voiceId, 'voice-user');
    assert.equal(version.items[1].text, characterLine);
    assert.equal(version.items[1].options.voiceId, 'voice-character');
    assert.equal(await api.generateMessageSpeech(0), false);
    assert.equal(requests.length, 1);
});

test('retry re-requests formatting and keeps the prior version when cached extraction missed a line', async () => {
    const hostContext = makeChat();
    const settings = makeSettings();
    const { fetchImpl, requests } = makeFormatterFetch([[segments[1]], segments]);
    const api = await loadIndex({ fetchImpl, settings, hostContext });

    assert.equal(await api.generateMessageSpeech(2), true);
    assert.equal(await api.generateMessageSpeech(2), true);
    assert.equal(requests.length, 1);
    assert.equal(await api.generateMessageSpeech(2, true), true);
    assert.equal(requests.length, 2);
    const history = settings.serverHistory[api.getMessageData(2).key];
    assert.equal(history.versions.length, 2);
    assert.equal(history.versions[0].items.length, 1);
    assert.equal(history.activeIndex, 1);
    assert.equal(history.versions[1].items[0].text, userLine);
    assert.equal(history.versions[1].items[0].options.voiceId, 'voice-user');
});

test('formatter cache follows user identity, template, model and selected prior context', async () => {
    const hostContext = makeChat();
    const settings = makeSettings();
    const { fetchImpl, requests } = makeFormatterFetch();
    const api = await loadIndex({ fetchImpl, settings, hostContext });
    const message = hostContext.chat[2];

    await api.formatWithSecondaryApi(message, { messageId: 2 });
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 1);
    hostContext.chat[3].mes = '未来消息已变化';
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 1);
    hostContext.name1 = '林鹿的新名字';
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 2);
    hostContext.powerUserSettings.persona_description = '更新后的用户设定';
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 3);
    settings.formatterSystemPrompt = '新的格式化模板';
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 4);
    settings.llmPresets[0].model = 'different-model';
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 5);
    hostContext.chat[1].mes = '上一条对话发生变化';
    await api.formatWithSecondaryApi(message, { messageId: 2 });
    assert.equal(requests.length, 6);
});

test('Google-format requests include user dialogue instructions even with a custom template and director off', async () => {
    const hostContext = makeChat();
    const settings = makeSettings('google');
    const { fetchImpl, requests } = makeFormatterFetch();
    const api = await loadIndex({ fetchImpl, settings, hostContext });

    const result = await api.formatWithSecondaryApi(hostContext.chat[2], { messageId: 2 });
    assert.equal(result.length, 2);
    assert.match(requests[0].messages[0].content, /用户角色（user）名.*林鹿/);
    assert.match(requests[0].messages[0].content, /完整提取当前消息中所有实际说出的台词，包括用户角色的台词/);
});

test('quoted names or thoughts are not turned into dialogue when the formatter returns no segments', async () => {
    const hostContext = makeChat();
    hostContext.chat[2].mes = '林鹿打开“星锐选角工作室”，心想：“这个名字有些熟悉。”';
    const settings = makeSettings();
    const { fetchImpl, requests } = makeFormatterFetch([[]]);
    const api = await loadIndex({ fetchImpl, settings, hostContext });

    assert.equal(await api.generateMessageSpeech(2), true);
    assert.equal(requests.length, 1);
    const version = settings.serverHistory[api.getMessageData(2).key].versions[0];
    assert.equal(version.items.length, 0);
});
