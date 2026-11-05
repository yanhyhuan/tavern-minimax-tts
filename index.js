import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced, addOneMessage, saveChatDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { fetchRemoteWithRetry, miniMaxHost } from './src/runtime.js';
import { createHostFileStore } from './src/host-storage.js';
import { fetchLlmResponse } from './src/host-requests.js';

const MODULE_NAME = 'minimax_quote_tts';
const SERVER_API = '/api/plugins/minimax-quote-tts';
const DEFAULT_API_HOST = 'https://api.minimax.chat';
const API_HOST_OPTIONS = [
    { value: 'https://api.minimax.chat',   label: '国内源 (api.minimax.chat)' },
    { value: 'https://api.minimaxi.com',   label: '国内源2 (api.minimaxi.com)' },
    { value: 'https://api.minimax.io',     label: '国际源 (api.minimax.io)' },
    { value: 'https://api.minimaxi.chat',  label: '备用源 (api.minimaxi.chat)' },
];

const LEGACY_SHORT_FORMATTER_PROMPT = '请以严格的 JSON 格式返回：{"segments":[{"text":"...","speaker":"...","emotion":"...","speed":1.0,"vol":1.0,"pitch":0,"pauseMs":180}]}. 仅保留可朗读的内容。';
const BUILTIN_DIRECTOR_SYSTEM_PROMPT = "# 专业 AI 角色配音导演与语音参数标注器\n\n你是一名专业的 AI 角色配音导演、剧情情绪分析师和语音表演参数标注器。\n\n你的任务不是简单地给台词贴上情绪标签，而是结合角色性格、角色声音人格、人物关系、最近对话和当前剧情，理解角色真正想表达的情感，并将台词转换成自然、连贯、有层次、有表现力的语音表演参数。\n\n你的目标是让每个角色听起来像一个真正参与剧情、具有稳定个性和连续情绪状态的人，而不是每句话都重新开始表演的朗读机器。\n\n必须严格遵守以下规则。\n\n---\n\n## 一、输出格式与数据结构\n\n1. 只输出合法 JSON，不得输出解释、Markdown、代码围栏或其他文字。\n2. JSON 顶层结构必须为：\n\n{\n  \"segments\": [\n    {\n      \"text\": \"角色实际需要朗读的台词\",\n      \"speaker\": \"角色名\",\n      \"emotion\": \"calm\",\n      \"style\": \"gentle\",\n      \"speed\": 1.0,\n      \"vol\": 1.0,\n      \"pitch\": 0,\n      \"pauseMs\": 180\n    }\n  ]\n}\n\n3. 每个 segment 必须包含全部八个字段：\n   - text\n   - speaker\n   - emotion\n   - style\n   - speed\n   - vol\n   - pitch\n   - pauseMs\n\n4. 不允许添加 voiceId、model 或其他未定义字段。角色音色由插件的手动绑定和自动分配系统处理。\n5. 所有数值字段必须输出数字，不能输出字符串、NaN、Infinity 或 null。\n6. 无法识别有效朗读内容时返回：\n\n{\"segments\":[]}\n\n7. JSON 必须可以通过标准 JSON.parse() 解析。\n8. 不得在 JSON 前后添加任何说明。\n\n---\n\n## 二、剧情上下文与情绪连续性\n\n在处理当前消息之前，必须先理解最近对话所处的剧情状态。\n\n重点判断：\n\n1. 当前场景处于什么状态：日常、紧张、暧昧、争执、悲伤、和解、亲密交流或其他状态。\n2. 当前角色在前几轮对话中表现出的情绪。\n3. 当前台词是情绪延续、情绪加强、情绪减弱，还是发生了明显转折。\n4. 当前角色说话的真实目的：解释、拒绝、试探、撒娇、安慰、责备、掩饰、讽刺、表达关心等。\n5. 角色与对话对象之间的关系，以及这种关系对表达方式的影响。\n\n连续性原则：\n\n- 同一场景中，相同角色的情绪应该自然延续。\n- 不要因为每次收到新消息就把情绪重置为 neutral 或 calm。\n- 情绪发生变化时，应当根据剧情逐渐过渡。\n- 愤怒转为委屈、紧张转为安心、害羞转为主动等情绪变化，应符合上下文。\n- 表面语气与真实情绪可能不同，应理解角色是否在掩饰情绪。\n- 不要把普通对话强行演绎成戏剧化表演。\n- 最近上下文只用于理解当前台词，不允许把历史消息重新输出为当前台词。\n\n如果缺少足够上下文，应当以当前台词和角色设定为主要依据，不得编造剧情。\n\n---\n\n## 三、角色声音人格与一致性\n\n优先参考角色卡、角色声音人格以及已有的角色表达习惯。\n\n每个角色都应保持相对稳定的声音表现：\n\n1. 说话速度倾向。\n2. 音调高低倾向。\n3. 说话方式，例如温柔、活泼、冷淡、成熟、克制、傲娇。\n4. 情绪激动时的表现特点。\n5. 害羞、撒娇、生气、悲伤时的表达特点。\n\n必须区分：\n\n- 角色声音人格：相对长期稳定。\n- 当前情绪：随剧情变化。\n- 当前表演风格：由具体台词和场景决定。\n\n不得因为角色突然生气，就让角色变成完全不同的声音人格。\n\n不得仅凭角色名字、性别或外貌臆测声音特点。\n\n角色声音人格优先于一般的表演习惯，但不得覆盖插件已经配置的角色音色绑定。\n\n---\n\n## 四、多角色识别与对话关系\n\n当一条消息中出现多个角色的台词时，必须尽可能识别每一段台词的真实说话者。\n\n规则：\n\n1. 不同角色的台词必须分开。\n2. 每段台词的 speaker 应填写真实角色名称。\n3. 同一角色连续表达、没有明显情绪或语气转折时，可以合并。\n4. 不同角色之间切换时必须分段。\n5. 识别对话中的回应、打断、抢话和情绪变化。\n6. 不要把被提及的人物误认为正在说话的人。\n7. 不要把旁白、动作描写或心理活动误认为角色台词。\n8. 无法确定说话者时，speaker 必须使用空字符串。\n9. 不得因为自动配音功能存在，就随意猜测 NPC 身份。\n10. 不要把同一角色的名字写成多个不同形式，尽量沿用角色卡或原文中的名称。\n\n---\n\n## 五、台词提取与分段\n\n只提取真正需要朗读的角色台词。\n\n应当删除：\n\n- 纯旁白。\n- 动作描写。\n- 环境描写。\n- 不需要朗读的括号说明。\n- 纯心理活动。\n- 系统说明和非剧情文本。\n\n必须遵守：\n\n1. 保留原文语言和文字，不翻译。\n2. 不改写、不续写、不补充原文没有的台词。\n3. 保留必要标点。\n4. 保留原文中的语气词。\n5. 不得为了表现情绪而擅自增加笑声、叹气、呼吸声或其他声音文字。\n6. 同一角色一句话中出现明显情绪转折时，可以拆分。\n7. 不要过度拆分，避免把一句自然台词切成大量短片段。\n8. 只有在说话者、情绪或表达方式发生明显变化时，才有必要拆段。\n\n每个 segment 的 text 必须是可以独立交给 TTS 合成的实际文本。\n\n---\n\n## 六、情绪识别 emotion\n\nemotion 只能使用以下值：\n\n- happy：开心、喜悦、兴奋、愉快。\n- sad：悲伤、失落、委屈、难过、低落。\n- angry：愤怒、不满、恼火、强烈责备。\n- fearful：害怕、紧张、担忧、不安。\n- disgusted：厌恶、嫌弃、反感。\n- surprised：惊讶、震惊、意外。\n- calm：平静、温柔、安慰、克制。\n- fluent：自然流畅、轻松交流、日常表达。\n- whisper：低声、耳语、刻意压低声音。\n\n选择原则：\n\n1. 根据真实情绪选择，不要单纯根据标点判断。\n2. 傲娇不等于 angry。\n3. 害羞不等于 sad 或 fearful。\n4. 温柔、宠溺、调侃、认真不一定是独立情绪。\n5. 不确定时优先选择 calm 或 fluent。\n6. 不要每句话都使用强烈情绪。\n7. 情绪应与上下文保持连续。\n\n---\n\n## 七、表演风格 style\n\nstyle 是独立于 emotion 的表演方式，用来表达角色如何说话。\n\n只能使用以下值：\n\n- gentle：温柔、轻柔。\n- shy：害羞、羞涩、略带拘谨。\n- tsundere：傲娇、嘴硬、外冷内热。\n- teasing：调侃、逗弄、戏谑。\n- comforting：安慰、宠溺、给予安全感。\n- serious：认真、严肃、郑重。\n- excited：兴奋、热情、充满活力。\n- whisper：耳语、轻声表达。\n- neutral：普通、自然、不刻意表演。\n\n规则：\n\n1. style 表示表达方式，不代替 emotion。\n2. 例如傲娇角色可以是 angry + tsundere，也可以是 shy + tsundere。\n3. 安慰角色可以是 calm + comforting。\n4. 开心地调侃可以是 happy + teasing。\n5. 只有确实需要时才使用特殊风格。\n6. 不确定时使用 neutral。\n7. 不要让 style 频繁变化，避免角色声音表现不稳定。\n\n---\n\n## 八、语音参数 speed、vol、pitch\n\nspeed：语速，范围 0.6～1.3，默认 1.0。\n\n参考：\n\n- 温柔、平静：0.90～1.00。\n- 害羞、犹豫：0.85～0.95。\n- 悲伤、低落：0.80～0.95。\n- 普通交流：0.95～1.05。\n- 兴奋、急切：1.05～1.20。\n- 强烈情绪：根据台词适度调整。\n\nvol：音量，范围 0.6～1.4，默认 1.0。\n\n参考：\n\n- 轻声、耳语：0.75～0.90。\n- 普通交流：0.95～1.05。\n- 强调、激动：1.05～1.20。\n- 悲伤不代表必须大幅降低音量。\n\npitch：音调，范围 -6～6，默认 0。\n\n参考：\n\n- 温柔、低沉：可适当降低。\n- 开心、惊讶：可适当提高。\n- 傲娇、害羞：细微调整。\n- 不得过度改变音调，避免角色声音人格漂移。\n\n参数应当相互协调，不要同时大幅改变语速、音量和音调。\n\n除非台词确实需要，否则尽量接近角色平时的表达参数。\n\n---\n\n## 九、对话节奏与停顿 pauseMs\n\npauseMs 用于控制当前 segment 播放前的等待时间，单位为毫秒。\n\n插件会对第一段自动忽略前置停顿，因此第一段 pauseMs 必须输出 0。\n\n后续 segment 根据前一段台词结束后的语义关系设置停顿。\n\n建议范围：\n\n- 轻微连续表达：100～180。\n- 普通句间停顿：180～350。\n- 句号后的正常停顿：300～500。\n- 重要情绪转折：400～700。\n- 犹豫、迟疑、沉默：500～1000。\n- 场景或人物情绪明显变化：600～1200。\n\n规则：\n\n1. 不要每段都使用相同停顿。\n2. 连续表达时停顿应较短。\n3. 角色换人时可适当增加停顿。\n4. 争执、抢话等场景应减少不必要的停顿。\n5. 悲伤、犹豫、试探等场景可适当增加停顿。\n6. 不要把普通逗号都处理成很长的停顿。\n7. pauseMs 必须是 0～2500 的整数。\n8. 第一段固定为 0。\n9. 不要输出 <#0.4#> 这类停顿标记，停顿统一使用 pauseMs 字段。\n\n---\n\n## 十、自然语音表演原则\n\n1. 让角色像真实的人一样交流，而不是机械朗读。\n2. 允许克制、犹豫、迟疑、停顿和自然语气变化。\n3. 重要词语可以通过分段、语速和音调变化突出。\n4. 句尾应根据语义自然收束。\n5. 不要每句话都刻意提高情绪强度。\n6. 不得改变原文含义。\n7. 不得凭空增加台词。\n8. 不得擅自添加亲密、暧昧或夸张情绪。\n9. 不得把角色动作或心理描写变成朗读内容。\n10. 不要为了追求所谓的真人感而滥用笑声、呼吸声和叹气声。\n\n---\n\n## 十一、发音纠错与专有名词\n\n1. 保留原文中的人名、地名、角色名和专有名词。\n2. 不得自行改写文字来猜测发音。\n3. 不得把发音纠错结果当成剧情原文。\n4. 自定义发音词典由插件负责处理，不需要你自行创造替换规则。\n5. 遇到生僻词时，保持原始文字，不得擅自翻译或替换。\n6. 对于不确定的读音，不要通过修改原文来掩盖不确定性。\n\n---\n\n## 十二、输出前检查\n\n输出 JSON 前必须自行检查：\n\n- 是否理解最近剧情和当前场景？\n- 情绪是否与前后对话连贯？\n- 角色声音人格是否稳定？\n- 是否识别了真实说话者？\n- 多角色台词是否正确分段？\n- 是否删除旁白、动作和心理描写？\n- 是否完整保留需要朗读的原文？\n- emotion 是否为允许值？\n- style 是否为允许值？\n- speed、vol、pitch 是否在规定范围？\n- pauseMs 是否为 0～2500 的整数？\n- 第一段 pauseMs 是否为 0？\n- 是否存在不必要的情绪变化或过度拆分？\n- 是否包含全部八个字段？\n- JSON 是否可以通过标准 JSON.parse() 解析？\n\n最终只输出合法 JSON，不输出任何其他内容。";

const TARGET_TYPE = { CURRENT_CHARACTER: 'current_character', CURRENT_USER: 'current_user', CUSTOM: 'custom' };
const API_FORMATS = { OAI: 'openai', GOOGLE: 'google' };
const MODEL_OPTIONS = [
    { value: 'speech-2.8-hd', label: 'Speech 2.8 HD (高画质)' },
    { value: 'speech-2.8-turbo', label: 'Speech 2.8 Turbo (极速)' },
    { value: 'speech-2.6-hd', label: 'Speech 2.6 HD' },
    { value: 'speech-2.6-turbo', label: 'Speech 2.6 Turbo' },
    { value: 'speech-02-hd', label: 'Speech 02 HD (兼容旧配置)' },
    { value: 'speech-02-turbo', label: 'Speech 02 Turbo (兼容旧配置)' },
    { value: 'speech-01', label: 'Speech 01 (兼容旧配置)' },
];

const defaults = {
    enabled: true, autoPlay: true, onlyCharacter: true,
    apiKey: '', groupId: '', apiHost: DEFAULT_API_HOST, model: 'speech-2.8-hd', voiceId: 'male-qn-qingse',
    speed: 1, vol: 1, pitch: 0, emotion: '', audioFormat: 'mp3', ttsLanguage: '',
    maxQuotesPerMessage: 4, minLength: 1, maxLength: 300, ignoreCodeBlocks: true,
    characterBindingsMap: {}, llmPresets: [], formatterTemplates: [],
    formatterEnabled: false, formatterPresetIdx: -1,
    emotionDirectorEnabled: true, emotionDirectorIntensity: 'balanced',
    performanceMode: 'hybrid', directorContextCount: 4, directorCacheEnabled: true,
    characterVoiceProfiles: {}, directorCache: {},
    autoVoiceCasting: true, autoVoiceCastingMax: 20, autoVoiceAssignments: {},
    pronunciationDictionary: '', retryCount: 2, retryBaseDelay: 900, segmentGapMs: 180, smartAudioCache: true, audioCacheMaxAgeDays: 7, audioCacheMaxMB: 1024,
    formatterSystemPrompt: BUILTIN_DIRECTOR_SYSTEM_PROMPT,
    serverHistory: {},
    voiceLibrary: [],          // [{name, voiceId}] 语音库
    regexRules: [],            // [{id, enabled, name, pattern, flags, mode}] mode:'extract'|'exclude'
    regexPresets: [],          // [{name, rules:[...]}]
    vcPromptBlocks: null,      // null = 默认顺序
    vcPromptTemplates: [],     // [{name, blocks:[...], systemPrompt:''}]
    llmPreProcessRules: [],    // [{id, enabled, name, pattern, mode}] 发送前预处理（剔除think等）
    showBubbles: false,        // 在台词旁或消息底部显示可点击语音气泡
    vrmEnabled: false,         // 是否启用视频通话功能（显示视频悬浮球）
    vrmModelUrl: '',           // 远程 URL 或可随宿主同步的模型存储引用
    vrmFilename: '',           // 上传的 VRM 文件名（显示用）
    vrmBg: 'transparent',      // VRM 帧背景：transparent | dark | light
    vrmLlmPresetIdx: -1,       // 视频通话专用 LLM 预设索引
    vrmPixelRatio: 1,          // 渲染像素比（0.5~3；手机建议 1，PC 建议 1.5~2）
};

let playbackQueue = [], isPlaying = false;
let playbackToken = 0;
let activeAudio = new Audio();
const localAudioCache = new Map();

function s() { return extension_settings[MODULE_NAME]; }

function escHtml(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 支持 /pattern/ 和 /pattern/flags 两种写法，也支持直接输入 pattern
function parsePattern(str) {
    const s = (str || '').trim();
    if (s.startsWith('/')) {
        const last = s.lastIndexOf('/');
        if (last > 0) return s.slice(1, last);
    }
    return s;
}

// 加载当前角色/聊天所关联的所有世界书条目
async function loadAllWbEntries() {
    const ctx = getContext();
    const worlds = new Set();
    const charWorld = ctx.characters?.[ctx.characterId]?.data?.extensions?.world;
    if (charWorld) worlds.add(charWorld);
    const chatWorld = ctx.chatMetadata?.world_info;
    if (chatWorld) worlds.add(chatWorld);
    const allEntries = [];
    for (const worldName of worlds) {
        const data = await ctx.loadWorldInfo(worldName);
        if (data?.entries) {
            for (const entry of Object.values(data.entries)) {
                if (!entry.disable) {
                    allEntries.push({
                        key: `${worldName}::${entry.uid}`,
                        title: entry.comment || `条目 ${entry.uid}`,
                        content: entry.content || '',
                        worldName,
                        uid: entry.uid,
                    });
                }
            }
        }
    }
    return allEntries;
}

// 对文本应用预处理规则（发送给 LLM 前清洗，如剔除思维链标签）
function applyPreProcessRules(text) {
    const rules = (s().llmPreProcessRules || []).filter(r => r.enabled && r.pattern);
    if (!rules.length) return text;
    for (const rule of rules) {
        let re;
        try { re = new RegExp(parsePattern(rule.pattern), 'gs'); } catch(e) { continue; }
        if (rule.mode === 'extract') {
            const matches = [];
            let m;
            while ((m = re.exec(text)) !== null) {
                const t = (m[1] !== undefined ? m[1] : m[0]).trim();
                if (t) matches.push(t);
            }
            if (matches.length) text = matches.join('\n');
        } else {
            text = text.replace(re, '');
        }
    }
    return text.trim();
}

function getBuiltinQuoteRule() {
    return {
        id: 'builtin-quotes', enabled: true, name: '引号内容',
        pattern: '[\\u0022\\u201c\\u300c\\u300e\\u2018]([^\\u0022\\u201c\\u201d\\u300c\\u300d\\u300e\\u300f\\u2018\\u2019]{1,500}?)[\\u0022\\u201d\\u300d\\u300f\\u2019]',
        flags: 'g', mode: 'extract',
    };
}

function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];
    for (const key in defaults) { if (settings[key] === undefined) settings[key] = JSON.parse(JSON.stringify(defaults[key])); }
    // 迁移：旧版 formatterPresets → llmPresets
    if (settings.formatterPresets?.length > 0 && settings.llmPresets.length === 0) {
        settings.llmPresets = settings.formatterPresets.map(p => ({ name: p.name, url: p.url || '', key: p.key || '', format: p.format || API_FORMATS.OAI, model: p.model || '' }));
    }
    // 迁移：旧版独立字段 → 第一个预设
    if (!settings.llmPresets.length && (settings.formatterApiUrl || settings.vcLlmApiUrl)) {
        const url = settings.formatterApiUrl || settings.vcLlmApiUrl || '';
        const key = settings.formatterApiKey || settings.vcLlmApiKey || '';
        const model = settings.formatterModel || settings.vcLlmModel || '';
        if (url || model) {
            settings.llmPresets.push({ name: '迁移预设', url, key, format: settings.formatterFormat || API_FORMATS.OAI, model });
            settings.formatterPresetIdx = 0;
        }
    }
    // 迁移：初始化 regexRules（新安装 or 旧版升级）
    if (!Array.isArray(settings.regexRules) || settings.regexRules.length === 0) {
        settings.regexRules = [getBuiltinQuoteRule()];
        // 如果旧版有自定义正则，迁移为第二条规则
        if (settings.customRegexPattern && settings.regexMode === 'custom') {
            settings.regexRules.push({
                id: 'migrated-' + Date.now(), enabled: true, name: '迁移正则',
                pattern: settings.customRegexPattern, flags: settings.customRegexFlags || 'g', mode: 'extract',
            });
        }
    }
    // 迁移：为已存储的 vcPromptBlocks 补充缺失的 worldBook 块
    if (Array.isArray(settings.vcPromptBlocks) && !settings.vcPromptBlocks.some(b => b.id === 'worldBook')) {
        const worldBookBlock = { id: 'worldBook', enabled: false, label: '世界书', editable: false, hint: '（世界书注入内容' };
        const afterIdx = settings.vcPromptBlocks.findIndex(b => b.id === 'charDesc');
        if (afterIdx >= 0) settings.vcPromptBlocks.splice(afterIdx + 1, 0, worldBookBlock);
        else settings.vcPromptBlocks.unshift(worldBookBlock);
    }
    // 迁移：为已存储的 vcPromptBlocks 补充缺失的 vrmActions 块
    if (Array.isArray(settings.vcPromptBlocks) && !settings.vcPromptBlocks.some(b => b.id === 'vrmActions')) {
        const vrmActionsBlock = { id: 'vrmActions', enabled: false, label: 'VRM表情/动作', editable: false, hint: '（视频通话时让 AI 输出表情动作标签，语音通话无效）' };
        settings.vcPromptBlocks.push(vrmActionsBlock);
    }
    // 自动升级旧版简短系统提示词并注入内置模板
    if (!settings.formatterSystemPrompt || settings.formatterSystemPrompt.trim() === LEGACY_SHORT_FORMATTER_PROMPT || settings.formatterSystemPrompt.includes('{"segments":[{"text":"..."')) {
        settings.formatterSystemPrompt = BUILTIN_DIRECTOR_SYSTEM_PROMPT;
    }
    if (!Array.isArray(settings.formatterTemplates)) settings.formatterTemplates = [];
    if (!settings.formatterTemplates.some(t => t && t.name === '内置·专业AI配音导演（推荐）')) {
        settings.formatterTemplates.unshift({ name: '内置·专业AI配音导演（推荐）', content: BUILTIN_DIRECTOR_SYSTEM_PROMPT });
    }
    if (!settings.formatterTemplates.some(t => t && t.name === '内置·极简JSON提取')) {
        settings.formatterTemplates.push({ name: '内置·极简JSON提取', content: LEGACY_SHORT_FORMATTER_PROMPT });
    }
    // 清理旧字段
    delete settings.quoteOnly;
    delete settings.regexMode;
    delete settings.customRegexPattern;
    delete settings.customRegexFlags;
    delete settings.customRegexPresets;
}

function simpleHash(t) {
    if (!t) return 0;
    let h = 0; for (let i = 0; i < t.length; i++) h = ((h << 5) - h) + t.charCodeAt(i), h |= 0;
    return Math.abs(h);
}

function buildMessageKey(ctx, id, m) {
    return `${ctx.chatId || 'no-chat'}:${id}:${m?.swipe_id || 0}:${simpleHash(m?.mes)}`;
}

function getMessageData(id) {
    const ctx = getContext(); const m = ctx?.chat?.[id];
    return { ctx, message: m, key: m ? buildMessageKey(ctx, id, m) : '' };
}

function normalizeOaiUrl(url) {
    let u = (url || '').trim().replace(/\/+$/, ''); if (!u) return '';
    if (!u.endsWith('/chat/completions')) u += '/chat/completions';
    return u;
}

// --- Host persistence: TT extension store / ST's built-in, user-scoped Files API ---
const TT_STORE_NAMESPACE = 'minimax-quote-tts';
const hostFileStore = createHostFileStore({ getHeaders: getRequestHeaders });
let serverPluginStatus = null;
let serverPluginCheckPromise = null;

function isTauriTavernHost() {
    return Boolean(window.__TAURITAVERN__ || window.__TAURI_RUNNING__ || window.location?.hostname === 'tauri.localhost');
}

function getTtExtensionStore() {
    return window.__TAURITAVERN__?.api?.extension?.store || null;
}

async function isServerPluginAvailable() {
    if (isTauriTavernHost()) { serverPluginStatus = false; return false; }
    if (serverPluginStatus !== null) return serverPluginStatus;
    if (serverPluginCheckPromise) return serverPluginCheckPromise;
    serverPluginCheckPromise = (async () => {
        try {
            const res = await fetch(`${SERVER_API}/status`, { headers: getRequestHeaders(), signal: AbortSignal.timeout(10000) });
            if (res.status === 404) { serverPluginStatus = false; return false; }
            if (!res.ok) throw new Error(`旧服务端状态读取失败 (HTTP ${res.status})`);
            const data = await res.json().catch(() => null);
            serverPluginStatus = Boolean(data && data.success);
            return serverPluginStatus;
        } finally {
            serverPluginCheckPromise = null;
        }
    })();
    return serverPluginCheckPromise;
}

let localStoreDbPromise = null;
function openLocalFallbackDb() {
    if (localStoreDbPromise) return localStoreDbPromise;
    localStoreDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('mm_tts_local_store_v1', 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('json')) db.createObjectStore('json');
            if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
    return localStoreDbPromise;
}

async function localStoreGetJson(table, key, fallback = null) {
    const ttStore = getTtExtensionStore();
    if (ttStore?.getJson) {
        try {
            if (ttStore.tryGetJson) {
                const result = await ttStore.tryGetJson({ namespace: TT_STORE_NAMESPACE, table, key });
                return result.found ? result.value : fallback;
            }
            const val = await ttStore.getJson({ namespace: TT_STORE_NAMESPACE, table, key });
            return val === undefined || val === null ? fallback : val;
        } catch (e) {
            if (/not found/i.test(e.message)) return fallback;
            throw new Error('TT 存储读取失败：' + e.message);
        }
    }
    return hostFileStore.getJson(table, key, fallback);
}

async function localStoreSetJson(table, key, value) {
    const ttStore = getTtExtensionStore();
    if (ttStore?.setJson) {
        try {
            await ttStore.setJson({ namespace: TT_STORE_NAMESPACE, table, key, value });
            return true;
        } catch (e) { throw new Error('TT 存储写入失败：' + e.message); }
    }
    await hostFileStore.setJson(table, key, value);
    return true;
}

async function localStoreGetBlob(table, key) {
    const ttStore = getTtExtensionStore();
    if (ttStore?.getBlob) {
        try {
            const blob = await ttStore.getBlob({ namespace: TT_STORE_NAMESPACE, table, key });
            if (blob) return blob;
        } catch (e) {
            if (/not found/i.test(e.message)) return null;
            throw new Error('TT 音频读取失败：' + e.message);
        }
    }
    return hostFileStore.getBlob(table, key);
}

async function localStoreSetBlob(table, key, blob, mimeType = 'audio/mpeg') {
    const ttStore = getTtExtensionStore();
    if (ttStore?.setBlob) {
        try {
            await ttStore.setBlob({ namespace: TT_STORE_NAMESPACE, table, key, data: blob, mimeType: blob?.type || mimeType });
            return true;
        } catch (e) { throw new Error('TT 音频保存失败：' + e.message); }
    }
    await hostFileStore.setBlob(table, key, blob);
    return true;
}

async function localStoreDeleteBlob(table, key) {
    const ttStore = getTtExtensionStore();
    if (ttStore?.deleteBlob) {
        await ttStore.deleteBlob({ namespace: TT_STORE_NAMESPACE, table, key });
        return;
    }
    await hostFileStore.deleteBlob(table, key);
}

function safeAudioFilename(filename = '') {
    const base = String(filename || '').split(/[\\/]/).pop() || '';
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    return /^\.?$/.test(cleaned) ? `audio_${Date.now()}.mp3` : cleaned;
}

let cacheWriteQueue = Promise.resolve();
function queueCacheWrite(operation) {
    const task = cacheWriteQueue.then(operation);
    cacheWriteQueue = task.catch(() => {});
    return task;
}

async function cleanupLocalAudioCache(options = {}) {
    return queueCacheWrite(() => performCacheCleanup(options));
}

async function performCacheCleanup(options = {}) {
    const maxAgeDays = Math.max(1, Math.min(365, Number(options.maxAgeDays ?? s().audioCacheMaxAgeDays ?? 7) || 7));
    const maxMB = Math.max(50, Math.min(20480, Number(options.maxMB ?? s().audioCacheMaxMB ?? 1024) || 1024));
    const maxBytes = maxMB * 1024 * 1024;
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const meta = (await localStoreGetJson('cache', 'index', {})) || {};
    const entries = Object.entries(meta).map(([name, info]) => ({
        name,
        size: Number(info?.size || 0),
        mtimeMs: Number(info?.mtimeMs || Date.now()),
    }));
    let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
    let deletedFiles = 0;
    let freedBytes = 0;
    const removeEntry = async (entry) => {
        await localStoreDeleteBlob('cache-audio', entry.name);
        delete meta[entry.name];
        totalBytes = Math.max(0, totalBytes - entry.size);
        deletedFiles += 1;
        freedBytes += entry.size;
    };
    for (const entry of entries.filter(e => e.mtimeMs < cutoff)) {
        await removeEntry(entry);
    }
    if (totalBytes > maxBytes) {
        const remaining = Object.entries(meta)
            .map(([name, info]) => ({ name, size: Number(info?.size || 0), mtimeMs: Number(info?.mtimeMs || 0) }))
            .sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const entry of remaining) {
            if (totalBytes <= maxBytes) break;
            await removeEntry(entry);
        }
    }
    await localStoreSetJson('cache', 'index', meta);
    const finalEntries = Object.values(meta);
    return {
        files: finalEntries.length,
        bytes: finalEntries.reduce((sum, e) => sum + Number(e?.size || 0), 0),
        deletedFiles,
        freedBytes,
        maxAgeDays,
        maxMB,
    };
}

async function getAudioCacheStatsUnified() {
    await cacheWriteQueue;
    const meta = (await localStoreGetJson('cache', 'index', {})) || {};
    const entries = Object.values(meta);
    return {
        files: entries.length,
        bytes: entries.reduce((sum, e) => sum + Number(e?.size || 0), 0),
        mode: isTauriTavernHost() ? 'tauritavern' : 'host',
    };
}

async function cleanupAudioCacheUnified(options = {}) {
    return cleanupLocalAudioCache(options);
}

async function uploadToSTServer(blob, filename) {
    return queueCacheWrite(() => persistAudioCache(blob, filename));
}

async function persistAudioCache(blob, filename) {
    const safeName = safeAudioFilename(filename);
    try {
        const ok = await localStoreSetBlob('cache-audio', safeName, blob, blob?.type || 'audio/mpeg');
        if (!ok) return null;
        const meta = (await localStoreGetJson('cache', 'index', {})) || {};
        meta[safeName] = { size: Number(blob?.size || 0), mtimeMs: Date.now() };
        await localStoreSetJson('cache', 'index', meta);
        await performCacheCleanup({ maxAgeDays: s().audioCacheMaxAgeDays ?? 7, maxMB: s().audioCacheMaxMB ?? 1024 });
        return `tt-store://cache/${safeName}`;
    } catch (e) {
        console.warn('[MiniMax] 酒馆缓存写入失败：', e);
        toastr.warning('语音已生成，但缓存保存失败：' + e.message);
        return null;
    }
}

async function getAudioFromSTServer(path) {
    if (!path) return null;
    if (String(path).startsWith('tt-store://cache/')) {
        const key = safeAudioFilename(String(path).slice('tt-store://cache/'.length));
        const blob = await localStoreGetBlob('cache-audio', key);
        if (blob) {
            queueCacheWrite(async () => {
                const meta = (await localStoreGetJson('cache', 'index', {})) || {};
                if (meta[key]) { meta[key].mtimeMs = Date.now(); await localStoreSetJson('cache', 'index', meta); }
            }).catch(error => console.warn('[MiniMax] 缓存访问时间更新失败：', error));
        }
        return blob;
    }
    try {
        const res = await fetch(path, { headers: getRequestHeaders() });
        return res.ok ? await res.blob() : null;
    } catch (e) { return null; }
}

async function proxyFetch(url, options = {}) {
    const fetchOpts = {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    };
    if (options.body && fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
        fetchOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    const directRes = await fetchLlmResponse(url, fetchOpts, { native: !isTauriTavernHost(), getHeaders: getRequestHeaders });
    const directText = await directRes.text();
    let directData;
    try { directData = JSON.parse(directText); } catch (_) { directData = directText; }
    if (!directRes.ok || directData?.error) {
        throw new Error(directData?.error?.message || directData?.message || (typeof directData?.error === 'string' ? directData.error : '') || (typeof directData === 'string' ? directData : `副模型请求失败 (HTTP ${directRes.status})`));
    }
    return directData;
}

function applyPronunciationDictionary(text) {
    let output = String(text ?? '');
    const lines = String(s().pronunciationDictionary || '').split(/\r?\n/);
    for (const line of lines) {
        const idx = line.indexOf('=>');
        if (idx <= 0) continue;
        const from = line.slice(0, idx).trim(), to = line.slice(idx + 2).trim();
        if (!from) continue;
        try { output = output.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to); } catch (_) {}
    }
    return output;
}

function audioCacheKey(item) {
    return `tts_v6_${simpleHash(applyPronunciationDictionary(item.text))}_${simpleHash(JSON.stringify(item.options || {}))}`;
}

function hexToUint8Array(hexString) {
    const clean = String(hexString || '').trim();
    const len = clean.length >> 1;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
}

const VALID_MINIMAX_EMOTIONS = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper']);
const EMOTION_SUPPORTED_MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo']);

async function synthesizeDirectMiniMax(payload) {
    const {
        text,
        apiKey,
        groupId,
        apiHost = DEFAULT_API_HOST,
        model = 'speech-2.8-hd',
        voiceId = 'male-qn-qingse',
        speed = 1,
        volume = 1,
        pitch = 0,
        format = 'mp3',
        sampleRate = 32000,
        bitrate = 128000,
        emotion = '',
        language = '',
    } = payload || {};
    if (!text || !String(text).trim()) throw new Error('Text is required');
    if (!apiKey || !String(apiKey).trim()) throw new Error('请先在 TTS 配置中填写 MiniMax API Key');

    const voiceSetting = {
        voice_id: String(voiceId || 'male-qn-qingse').trim(),
        speed: Number(speed) || 1,
        vol: Number(volume) || 1,
        pitch: Math.round(Number(pitch) || 0),
    };
    const normalizedEmotion = String(emotion || '').trim().toLowerCase();
    if (normalizedEmotion && VALID_MINIMAX_EMOTIONS.has(normalizedEmotion) && EMOTION_SUPPORTED_MODELS.has(model)) {
        voiceSetting.emotion = normalizedEmotion;
    }

    const requestBody = {
        model,
        text: String(text),
        stream: false,
        voice_setting: voiceSetting,
        audio_setting: {
            sample_rate: Number(sampleRate) || 32000,
            bitrate: Number(bitrate) || 128000,
            format: format || 'mp3',
            channel: 1,
        },
    };
    if (language && String(language).trim()) {
        requestBody.language_boost = String(language).trim();
    }

    const allHosts = API_HOST_OPTIONS.map(o => o.value);
    const primaryHost = miniMaxHost(apiHost);
    const hostsToTry = [primaryHost, ...allHosts.filter(h => h !== primaryHost)];
    const gid = String(groupId || '').trim();
    const querySuffix = gid ? `?GroupId=${encodeURIComponent(gid)}` : '';

    let lastError = null;
    for (const host of hostsToTry) {
        try {
            const response = await fetchRemoteWithRetry(`${host}/v1/t2a_v2${querySuffix}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${String(apiKey).trim()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            }, { retryCount: s().retryCount ?? 2, retryBaseDelay: s().retryBaseDelay ?? 900 });
            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`MiniMax HTTP ${response.status}: ${errText.slice(0, 180)}`);
            }
            const data = await response.json();
            if (data.base_resp && data.base_resp.status_code !== 0) {
                throw new Error(`MiniMax API Error (${data.base_resp.status_code}): ${data.base_resp.status_msg || 'Unknown error'}`);
            }
            if (!data.data || !data.data.audio) {
                throw new Error('MiniMax API 未返回有效音频数据');
            }
            const bytes = hexToUint8Array(data.data.audio);
            const mime = format === 'wav' ? 'audio/wav' : format === 'flac' ? 'audio/flac' : 'audio/mpeg';
            return new Blob([bytes], { type: mime });
        } catch (err) {
            lastError = err;
            console.warn(`[MiniMax Direct] Host ${host} failed:`, err.message);
        }
    }
    throw lastError || new Error('所有 MiniMax API 节点请求均失败');
}

async function requestTtsAudioBlob(payload) {
    return await synthesizeDirectMiniMax(payload);
}

async function getAudioBlob(item) {
    const cacheKey = audioCacheKey(item);
    if (localAudioCache.has(cacheKey)) return localAudioCache.get(cacheKey);
    const expectedFilename = `${cacheKey}.${item.options?.audioFormat || 'mp3'}`;
    if (item.serverPath) {
        const cachedBlob = await getAudioFromSTServer(item.serverPath);
        if (cachedBlob) { localAudioCache.set(cacheKey, cachedBlob); return cachedBlob; }
    } else {
        const cachedBlob = await getAudioFromSTServer(`tt-store://cache/${expectedFilename}`);
        if (cachedBlob) {
            item.serverPath = `tt-store://cache/${expectedFilename}`;
            localAudioCache.set(cacheKey, cachedBlob);
            return cachedBlob;
        }
    }
    const set = s();
    const blob = await requestTtsAudioBlob({
        text: applyPronunciationDictionary(item.text),
        apiKey: set.apiKey,
        groupId: set.groupId,
        apiHost: set.apiHost,
        model: item.options.model,
        voiceId: item.options.voiceId,
        speed: item.options.speed,
        volume: item.options.vol,
        pitch: item.options.pitch,
        format: item.options.audioFormat,
        emotion: item.options.emotion,
        language: item.options.language || undefined,
    });
    localAudioCache.set(cacheKey, blob);
    uploadToSTServer(blob, expectedFilename).then(path => { if (path) { item.serverPath = path; saveSettingsDebounced(); } });
    return blob;
}


// ── Persistent favorites (ST user files / TT's synchronized extension store) ──
const bubbleItems = new WeakMap();
let favoriteItemsCache = [];
let favoriteFilterText = '';
let favoritePlaybackToken = 0;
let currentFavoriteAudio = null;
let currentFavoriteAudioDone = null;
let favoriteCacheLoaded = false;
let favoriteCacheLoading = null;

function base64ToBlob(base64, mimeType = 'audio/mpeg') {
    const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
}

async function ensureFavoriteCache(force = false) {
    if (favoriteCacheLoaded && !force) return favoriteItemsCache;
    if (favoriteCacheLoading) return favoriteCacheLoading;
    favoriteCacheLoading = favoriteRequest().then(items => {
        favoriteItemsCache = Array.isArray(items) ? items : [];
        favoriteCacheLoaded = true;
        refreshAllFavoriteButtons();
        return favoriteItemsCache;
    }).catch(err => { console.warn('[MiniMax TTS] 收藏状态读取失败：', err); return favoriteItemsCache; })
      .finally(() => { favoriteCacheLoading = null; });
    return favoriteCacheLoading;
}
function favoriteMatchForBubble(item, mesid) {
    const ctx = getContext();
    const character = String(ctx.name || '');
    const options = item?.options || {};
    return favoriteItemsCache.find(f =>
        String(f.text || '') === String(item?.text || '') &&
        String(f.speaker || '') === String(item?.speaker || '') &&
        String(f.voiceId || '') === String(options.voiceId || '') &&
        String(f.model || '') === String(options.model || '') &&
        String(f.source?.messageId || '') === String(mesid) &&
        (!f.source?.character || f.source.character === character)
    ) || null;
}
function updateBubbleFavoriteButton(bubble) {
    const item = bubbleItems.get(bubble);
    const button = bubble.querySelector('.mm-bubble-fav');
    if (!button || !item) return;
    const match = favoriteMatchForBubble(item, bubble.dataset.mesid);
    button.dataset.favoriteId = match?.id || '';
    button.classList.toggle('is-favorited', !!match);
    button.textContent = match ? '★' : '☆';
    button.title = match ? '取消收藏' : '收藏这段语音';
    button.setAttribute('aria-label', button.title);
}
function refreshAllFavoriteButtons() {
    document.querySelectorAll('.mm-bubble').forEach(updateBubbleFavoriteButton);
}

let localFavoriteQueue = Promise.resolve();
function localFavoriteRequest(path = '', options = {}) {
    const task = localFavoriteQueue.then(() => performLocalFavoriteRequest(path, options));
    localFavoriteQueue = task.catch(() => {});
    return task;
}
async function performLocalFavoriteRequest(path = '', options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : {};
    let items = await localStoreGetJson('favorites', 'index', []);
    if (!Array.isArray(items)) items = [];

    if (path === '' && method === 'GET') {
        return items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    }
    if (path === '' && method === 'POST') {
        const format = ['mp3', 'wav', 'flac'].includes(String(body.format || '').toLowerCase()) ? String(body.format).toLowerCase() : 'mp3';
        const mime = format === 'wav' ? 'audio/wav' : format === 'flac' ? 'audio/flac' : 'audio/mpeg';
        const blob = body._blob || base64ToBlob(body.audioBase64 || '', mime);
        if (!blob || !blob.size) throw new Error('Empty audio');
        const id = `fav_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const fileName = `${id}.${format}`;
        await localStoreSetBlob('favorites-audio', fileName, blob, mime);
        const item = {
            id,
            createdAt: Date.now(),
            title: String(body.title || body.speaker || 'MiniMax 语音').slice(0, 120),
            text: String(body.text || '').slice(0, 5000),
            speaker: String(body.speaker || '').slice(0, 80),
            voiceId: String(body.voiceId || '').slice(0, 120),
            model: String(body.model || '').slice(0, 80),
            emotion: String(body.emotion || '').slice(0, 40),
            speed: Number(body.speed) || 1,
            pitch: Number(body.pitch) || 0,
            tags: Array.isArray(body.tags) ? body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 20) : [],
            note: String(body.note || '').slice(0, 1000),
            source: body.source && typeof body.source === 'object' ? {
                character: String(body.source.character || '').slice(0, 120),
                chatId: String(body.source.chatId || '').slice(0, 160),
                messageId: String(body.source.messageId ?? '').slice(0, 40),
            } : {},
            fileName,
            format,
            size: blob.size,
        };
        items.unshift(item);
        await localStoreSetJson('favorites', 'index', items);
        return item;
    }
    if (path === '/batch-delete' && method === 'POST') {
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(x => String(x)));
        const removed = items.filter(x => ids.has(String(x.id)));
        const kept = items.filter(x => !ids.has(String(x.id)));
        for (const item of removed) {
            await localStoreDeleteBlob('favorites-audio', item.fileName || `${item.id}.${item.format || 'mp3'}`);
        }
        await localStoreSetJson('favorites', 'index', kept);
        return { success: true, deleted: removed.length };
    }
    if (path === '/import' && method === 'POST') {
        const incoming = Array.isArray(body.items) ? body.items : [];
        let imported = 0;
        for (const raw of incoming) {
            const legacyKey = body.migrationSource && raw?.id ? `${body.migrationSource}:${raw.id}` : '';
            if (legacyKey && items.some(item => item.legacyKey === legacyKey)) continue;
            if (!raw?.audioBase64 && !raw?._blob) {
                if (body.migrationSource) throw new Error('旧收藏缺少音频，尚未完成迁移');
                continue;
            }
            const format = ['mp3', 'wav', 'flac'].includes(String(raw.format || '').toLowerCase()) ? String(raw.format).toLowerCase() : 'mp3';
            const mime = format === 'wav' ? 'audio/wav' : format === 'flac' ? 'audio/flac' : 'audio/mpeg';
            const blob = raw._blob || base64ToBlob(raw.audioBase64, mime);
            if (!blob.size) {
                if (body.migrationSource) throw new Error('旧收藏音频为空，尚未完成迁移');
                continue;
            }
            const id = `fav_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            const fileName = `${id}.${format}`;
            await localStoreSetBlob('favorites-audio', fileName, blob, mime);
            items.unshift({
                id,
                ...(legacyKey ? { legacyKey } : {}),
                createdAt: Number(raw.createdAt) || Date.parse(raw.createdAt) || Date.now(),
                ...(raw.updatedAt ? { updatedAt: Number(raw.updatedAt) || Date.parse(raw.updatedAt) || undefined } : {}),
                title: String(raw.title || raw.speaker || '导入语音').slice(0, 160),
                text: String(raw.text || '').slice(0, 20000),
                speaker: String(raw.speaker || '').slice(0, 160),
                voiceId: String(raw.voiceId || '').slice(0, 256),
                model: String(raw.model || '').slice(0, 100),
                emotion: String(raw.emotion || '').slice(0, 40),
                speed: Number(raw.speed) || 1,
                pitch: Number(raw.pitch) || 0,
                tags: Array.isArray(raw.tags) ? raw.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 30) : [],
                note: String(raw.note || '').slice(0, 2000),
                source: raw.source && typeof raw.source === 'object' ? {
                    character: String(raw.source.character || '').slice(0, 160),
                    chatId: String(raw.source.chatId || '').slice(0, 160),
                    messageId: String(raw.source.messageId ?? '').slice(0, 40),
                } : {},
                fileName,
                format,
                size: blob.size,
            });
            // Commit each migrated item so a later failure can resume without duplicates.
            if (body.migrationSource) await localStoreSetJson('favorites', 'index', items);
            imported += 1;
        }
        await localStoreSetJson('favorites', 'index', items);
        return { success: true, imported };
    }
    const idMatch = path.match(/^\/([^/]+)$/);
    if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const idx = items.findIndex(x => String(x.id) === String(id));
        if (idx < 0) throw new Error('Favorite not found');
        if (method === 'PATCH') {
            if (body.title !== undefined) items[idx].title = String(body.title || '').slice(0, 120);
            if (body.note !== undefined) items[idx].note = String(body.note || '').slice(0, 1000);
            if (body.tags !== undefined) {
                items[idx].tags = Array.isArray(body.tags)
                    ? body.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 20)
                    : String(body.tags || '').split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 20);
            }
            items[idx].updatedAt = Date.now();
            await localStoreSetJson('favorites', 'index', items);
            return items[idx];
        }
        if (method === 'DELETE') {
            const [removed] = items.splice(idx, 1);
            await localStoreDeleteBlob('favorites-audio', removed.fileName || `${removed.id}.${removed.format || 'mp3'}`);
            await localStoreSetJson('favorites', 'index', items);
            return { success: true };
        }
    }
    throw new Error(`Unsupported favorite operation: ${method} ${path}`);
}

async function favoriteRequest(path = '', options = {}) {
    return localFavoriteRequest(path, options);
}

async function readLegacyBrowserValue(store, key) {
    const db = await openLocalFallbackDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readonly');
        const request = transaction.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('旧浏览器存储读取失败'));
    });
}

async function migrateLegacyStorage() {
    if (!(await readLegacyBrowserValue('json', 'migration:host-storage-v1'))) {
        const items = await readLegacyBrowserValue('json', 'favorites:index');
        for (const item of (Array.isArray(items) ? items : [])) {
            const blob = await readLegacyBrowserValue('blobs', `favorites-audio:${item.fileName || `${item.id}.${item.format || 'mp3'}`}`);
            await performLocalFavoriteRequest('/import', {
                method: 'POST', body: { migrationSource: 'browser-v1', items: [{ ...item, _blob: blob }] },
            });
        }
        const oldCache = await readLegacyBrowserValue('json', 'cache:index');
        const cache = await localStoreGetJson('cache', 'index', {});
        for (const [key, meta] of Object.entries(oldCache || {})) {
            if (cache[key]) continue;
            const blob = await readLegacyBrowserValue('blobs', `cache-audio:${key}`);
            if (!blob) continue;
            await localStoreSetBlob('cache-audio', key, blob);
            cache[key] = meta;
            await localStoreSetJson('cache', 'index', cache);
        }
        const db = await openLocalFallbackDb();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction('json', 'readwrite');
            transaction.objectStore('json').put(true, 'migration:host-storage-v1');
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error || new Error('旧存储迁移标记保存失败'));
        });
    }
    if (!isTauriTavernHost() && !(await localStoreGetJson('migration', 'server-plugin-v1', false)) && await isServerPluginAvailable()) {
        const response = await fetch(`${SERVER_API}/favorites`, { headers: getRequestHeaders(), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`旧服务端收藏读取失败 (HTTP ${response.status})`);
        const items = await response.json();
        if (!Array.isArray(items)) throw new Error('旧服务端收藏列表无效');
        for (const item of items) {
            const current = await localStoreGetJson('favorites', 'index', []);
            if (current.some(saved => saved.legacyKey === `server-v1:${item.id}`)) continue;
            const audio = await fetch(`${SERVER_API}/favorites/${encodeURIComponent(item.id)}/audio`, {
                headers: getRequestHeaders(), signal: AbortSignal.timeout(120000),
            });
            if (!audio.ok) throw new Error(`旧收藏音频读取失败 (HTTP ${audio.status})`);
            await performLocalFavoriteRequest('/import', {
                method: 'POST', body: { migrationSource: 'server-v1', items: [{ ...item, _blob: await audio.blob() }] },
            });
        }
        await localStoreSetJson('migration', 'server-plugin-v1', true);
    }
    favoriteCacheLoaded = false;
}

async function getFavoriteAudioBlob(id) {
    const items = await localStoreGetJson('favorites', 'index', []);
    const item = (Array.isArray(items) ? items : []).find(x => String(x.id) === String(id));
    if (!item) throw new Error('未找到该收藏记录');
    const blob = await localStoreGetBlob('favorites-audio', item.fileName || `${item.id}.${item.format || 'mp3'}`);
    if (!blob) throw new Error('收藏音频文件缺失');
    return blob;
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('读取音频失败'));
        reader.readAsDataURL(blob);
    });
}
async function saveFavorite(item, mesid = null) {
    const blob = await getAudioBlob(item);
    const options = item.options || {};
    const ctx = getContext();
    const speaker = item.speaker || '';
    return favoriteRequest('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        audioBase64: await blobToBase64(blob), format: options.audioFormat || 'mp3',
        title: `${speaker || 'MiniMax'} · ${(item.text || '').slice(0, 32)}`,
        text: item.text || '', speaker, voiceId: options.voiceId || '', model: options.model || '',
        emotion: options.emotion || '', speed: options.speed ?? 1, pitch: options.pitch ?? 0,
        source: { character: ctx.name || '', messageId: mesid == null ? '' : String(mesid) },
    }) });
}
async function renderFavorites() {
    const root = document.getElementById('mm_favorites_list');
    if (!root) return;
    root.innerHTML = '<p class="mm-desc">正在读取语音收藏…</p>';
    try {
        favoriteItemsCache = await favoriteRequest();
        favoriteCacheLoaded = true;
        refreshAllFavoriteButtons();
        renderFavoriteCards();
    } catch (e) { root.innerHTML = `<p class="mm-desc">读取收藏失败：${escHtml(e.message)}</p>`; }
}

function renderFavoriteCards() {
    const root = document.getElementById('mm_favorites_list');
    if (!root) return;
    const q = favoriteFilterText.trim().toLocaleLowerCase();
    const items = favoriteItemsCache.filter(item => !q || [item.title, item.text, item.speaker, item.voiceId, item.model, item.note, ...(item.tags || []), item.source?.character].join(' ').toLocaleLowerCase().includes(q));
    if (!favoriteItemsCache.length) { root.innerHTML = '<p class="mm-desc">还没有收藏。点击聊天语音气泡旁边的 ☆ 即可收藏。</p>'; }
    else if (!items.length) { root.innerHTML = '<p class="mm-desc">没有匹配的收藏。</p>'; }
    else root.innerHTML = items.map(item => `<div class="mm-fav-card" data-fav-id="${escHtml(item.id)}">
      <label class="mm-fav-select"><input type="checkbox" class="mm-fav-check" aria-label="选择此收藏"></label>
      <div class="mm-fav-main"><strong>${escHtml(item.title || '未命名语音')}</strong><small>${escHtml(item.speaker || item.voiceId || '未知音色')} · ${escHtml(item.model || '')} · ${escHtml(item.format || 'mp3').toUpperCase()}</small>
      <p>${escHtml(item.text || '')}</p><small>${escHtml(new Date(item.createdAt).toLocaleString())} · ${(Number(item.size || 0) / 1024).toFixed(1)} KB${item.source?.character ? ' · 角色：' + escHtml(item.source.character) : ''}</small>
      <small class="mm-fav-tags">${(item.tags || []).map(t => `<span>${escHtml(t)}</span>`).join(' ')}</small>${item.note ? `<small>备注：${escHtml(item.note)}</small>` : ''}</div>
      <div class="mm-fav-actions"><button class="menu_button mm-fav-play" type="button">试听</button><button class="menu_button mm-fav-download" type="button">下载</button><button class="menu_button mm-fav-edit" type="button">编辑</button><button class="menu_button mm-fav-delete" type="button">删除</button><small class="mm-fav-play-status" role="status" aria-live="polite"></small></div>
    </div>`).join('');
    const counter = document.getElementById('mm_favorites_count');
    if (counter) counter.textContent = `显示 ${items.length} / 共 ${favoriteItemsCache.length} 条`;
}
async function playSelectedFavorites() {
    const ids = [...document.querySelectorAll('#mm_favorites_list .mm-fav-card')].filter(card => card.querySelector('.mm-fav-check')?.checked).map(card => card.dataset.favId);
    if (!ids.length) { toastr.info('请先勾选要播放的收藏'); return; }
    const token = ++favoritePlaybackToken;
    toastr.info(`开始连续播放 ${ids.length} 条收藏；再次点击可停止`);
    for (const id of ids) {
        if (token !== favoritePlaybackToken) break;
        await new Promise(async resolve => {
            try {
                const blob = await getFavoriteAudioBlob(id);
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                currentFavoriteAudio = audio;
                const done = () => {
                    URL.revokeObjectURL(url);
                    audio.onended = audio.onerror = null;
                    if (currentFavoriteAudio === audio) { currentFavoriteAudio = null; currentFavoriteAudioDone = null; }
                    resolve();
                };
                currentFavoriteAudioDone = done;
                audio.onended = done; audio.onerror = done;
                audio.play().catch(done);
            } catch (_) { resolve(); }
        });
    }
    if (token === favoritePlaybackToken) { favoritePlaybackToken = 0; toastr.success('选中收藏播放完毕'); }
}

async function exportFavorites() {
    let blob;
    {
        const items = await localStoreGetJson('favorites', 'index', []);
        const exported = [];
        for (const item of (Array.isArray(items) ? items : [])) {
            const audioBlob = await localStoreGetBlob('favorites-audio', item.fileName || `${item.id}.${item.format || 'mp3'}`);
            if (!audioBlob) continue;
            exported.push({ ...item, audioBase64: await blobToBase64(audioBlob) });
        }
        const payload = { format: 'minimax-quote-tts-favorites', version: 1, exportedAt: new Date().toISOString(), count: exported.length, items: exported };
        blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json; charset=utf-8' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `minimax-quote-tts-favorites-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function importFavorites(file) {
    const backup = JSON.parse(await file.text());
    const result = await favoriteRequest('/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup) });
    return result.imported || 0;
}

// --- Player ---
async function playNext(token = playbackToken) {
    if (token !== playbackToken) return;
    if (playbackQueue.length === 0) { isPlaying = false; refreshSpeechPanelStatus(); return; }
    isPlaying = true; const item = playbackQueue.shift();
    if (item.pauseMs) await new Promise(r => setTimeout(r, Math.max(0, Math.min(2500, Number(item.pauseMs)))));
    if (token !== playbackToken) return;
    try {
        const blob = await getAudioBlob(item);
        if (token !== playbackToken) return;
        const url = URL.createObjectURL(blob);
        activeAudio.src = url;
        activeAudio.onended = () => { URL.revokeObjectURL(url); playNext(token); };
        activeAudio.onerror = () => { URL.revokeObjectURL(url); playNext(token); };
        await activeAudio.play();
    } catch (e) {
        if (token !== playbackToken) return;
        toastr.warning?.(`语音片段播放失败：${e.message}`); playNext(token);
    }
}

async function formatWithSecondaryApi(m) {
    const set = s();
    const preset = (set.llmPresets || [])[set.formatterPresetIdx];
    if (!preset) throw new Error('请先在「LLM 预设管理」中选择一个预设');
    const format = preset.format || API_FORMATS.OAI;
    const ctx = getContext();
    const characterName = ctx.name2 || m.name || '角色';
    const characterDescription = String(ctx.characters?.[ctx.characterId]?.description || '').slice(0, 1800);
    const characterKey = String(ctx.characterId ?? ctx.character_id ?? characterName);
    const voiceProfile = String(set.characterVoiceProfiles?.[characterKey] || '').slice(0, 1200);
    const contextCount = Math.max(0, Math.min(8, Number(set.directorContextCount ?? 4)));
    const recentContext = Array.isArray(ctx.chat) ? ctx.chat.slice(-contextCount - 1, -1).map(x => `${String(x.name || (x.is_user ? '用户' : '角色')).slice(0, 40)}：${String(x.mes || '').replace(/<[^>]*>/g, ' ').slice(0, 350)}`).join('\n') : '';
    const currentText = applyPreProcessRules(m.mes);
    const mode = set.performanceMode || 'hybrid';
    const cacheKey = String(simpleHash([characterKey, currentText, recentContext, mode, voiceProfile, set.emotionDirectorIntensity].join('\n')));
    if (set.directorCacheEnabled && set.directorCache?.[cacheKey]) return JSON.parse(JSON.stringify(set.directorCache[cacheKey]));
    const modeInstruction = mode === 'natural'
      ? '模式：真人自然聊天。优先克制、口语化、少量停顿；除非文本明确要求，不添加笑声、叹气等音效。'
      : mode === 'immersive'
        ? '模式：动漫角色沉浸演绹。允许更鲜明的情绪转折、声优式强调和适量语气词，但必须符合原文和角色性格。'
        : '模式：双模式融合。日常信息自然克制；只有在亲密互动、剧情转折、强烈情绪或明确语气线索出现时，才增强表演。';
    const baseSysPrompt = String(set.formatterSystemPrompt || BUILTIN_DIRECTOR_SYSTEM_PROMPT);
    const usesBuiltinDirectorSpec = baseSysPrompt.includes('专业 AI 角色配音导演与语音参数标注器');
    const directorContextBlock = `\n\n---\n## 当前会话上下文与导演设定（动态注入）\n- **当前主要角色名**：${characterName}\n- **角色卡核心设定**：${characterDescription || '遵循聊天中的角色设定'}\n- **角色专属声音人格（最高优先级）**：${voiceProfile || '未单独设置，依据角色卡自然演绎'}\n- **当前演绎模式**：${mode}（${modeInstruction}）\n- **当前演绎强度**：${set.emotionDirectorIntensity || 'balanced'}`;
    const legacyDirectorRules = (!usesBuiltinDirectorSpec && set.emotionDirectorEnabled)
      ? `\n- **输出结构要求**：只返回合法 JSON：{"segments":[{"text":"角色实际需要朗读的台词","speaker":"角色名","emotion":"happy|sad|angry|fearful|disgusted|surprised|calm|fluent|whisper","style":"gentle|shy|tsundere|teasing|comforting|serious|excited|whisper|neutral","speed":1.0,"vol":1.0,"pitch":0,"pauseMs":180}]}。`
      : '';
    const prompt = `${baseSysPrompt}${set.emotionDirectorEnabled || usesBuiltinDirectorSpec ? directorContextBlock + legacyDirectorRules : ''}`;
    try {
        let text;
        if (format === API_FORMATS.OAI) {
            const url = normalizeOaiUrl(preset.url);
            const data = await proxyFetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...(preset.key ? { 'Authorization': `Bearer ${preset.key.trim()}` } : {}) },
                body: { model: preset.model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: `最近对话上下文（仅用于理解情绪，不得续写）：\n${recentContext}\n\n当前消息：\n${currentText}` }], temperature: 0.1 }
            });
            text = data.choices?.[0]?.message?.content;
        } else {
            const baseUrl = (preset.url || '').trim().replace(/\/+$/, '');
            const gUrl = `${baseUrl}/v1beta/models/${preset.model}:generateContent`;
            const gHeaders = { 'Content-Type': 'application/json', ...(preset.key ? { 'x-goog-api-key': preset.key.trim() } : {}) };
            const data = await proxyFetch(gUrl, { method: 'POST', headers: gHeaders, body: { contents: [{ role: 'user', parts: [{ text: `System Prompt: ${prompt}\n\nRecent Context (for emotion only):\n${recentContext}\n\nCurrent Message:\n${currentText}` }] }] } });
            text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        }
        const match = text.match(/\{[\s\S]*\}/); if (!match) throw new Error('AI 无有效 JSON');
        const segments = JSON.parse(match[0])?.segments || null;
        if (segments && set.directorCacheEnabled) {
            set.directorCache = set.directorCache || {};
            set.directorCache[cacheKey] = segments;
            const keys = Object.keys(set.directorCache);
            while (keys.length > 100) delete set.directorCache[keys.shift()];
            saveSettingsDebounced();
        }
        return segments;
    } catch (e) { throw e; }
}

function findCharacterBinding(speakerName) {
    if (!speakerName) return null;
    const set = s(), ctx = getContext(), name = speakerName.toLowerCase();
    const id = ctx.characterId || ctx.character_id || ctx.name2 || 'global';
    const bindings = set.characterBindingsMap[id] || [];
    return bindings.find(b => {
        const bName = (b.targetType === TARGET_TYPE.CUSTOM ? b.customName : (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 : ctx.name1))?.toLowerCase();
        return bName === name;
    });
}

function resolvePerformanceStyle(style, base = {}) {
    const presets = {
        gentle: { speed: 0.94, vol: 0.94, pitch: 0, emotion: 'calm' },
        shy: { speed: 0.90, vol: 0.84, pitch: 1, emotion: 'calm' },
        tsundere: { speed: 1.02, vol: 1.02, pitch: 1, emotion: 'fluent' },
        teasing: { speed: 1.02, vol: 0.98, pitch: 1, emotion: 'fluent' },
        comforting: { speed: 0.92, vol: 0.92, pitch: -1, emotion: 'calm' },
        serious: { speed: 0.94, vol: 1.02, pitch: -1, emotion: 'calm' },
        excited: { speed: 1.10, vol: 1.10, pitch: 2, emotion: 'happy' },
        whisper: { speed: 0.88, vol: 0.78, pitch: -1, emotion: 'whisper' },
        neutral: {},
    };
    const preset = presets[String(style || 'neutral').toLowerCase()] || {};
    return { ...preset, ...base };
}

function resolveAutoVoice(speakerName, message) {
    const set = s();
    if (!set.autoVoiceCasting || !speakerName || !Array.isArray(set.voiceLibrary) || !set.voiceLibrary.length) return null;
    const ctx = getContext();
    const characterId = String(ctx.characterId ?? ctx.character_id ?? ctx.name2 ?? 'global');
    const speaker = String(speakerName).trim();
    if (!speaker || speaker === String(message?.name || '')) return null;
    const library = set.voiceLibrary.filter(v => String(v?.voiceId || '').trim());
    if (!library.length) return null;
    const max = Math.max(1, Math.min(100, Number(set.autoVoiceCastingMax || 20)));
    const mapKey = `${characterId}:${String(ctx.chatId || 'chat')}`;
    set.autoVoiceAssignments = set.autoVoiceAssignments || {};
    const assignments = set.autoVoiceAssignments[mapKey] || (set.autoVoiceAssignments[mapKey] = {});
    if (assignments[speaker]?.voiceId) {
        const existing = library.find(v => v.voiceId === assignments[speaker].voiceId);
        if (existing) return existing;
    }
    const assignedNames = Object.keys(assignments);
    if (assignedNames.length >= max) {
        const reusable = library[simpleHash(speaker) % library.length];
        return reusable || null;
    }
    // Stable deterministic assignment: same speaker + chat gets the same voice after reload.
    const voice = library[simpleHash(`${mapKey}:${speaker}`) % library.length];
    assignments[speaker] = { voiceId: voice.voiceId, name: voice.name || voice.voiceId, createdAt: Date.now() };
    saveSettingsDebounced();
    return voice;
}

function buildSynthesisOptions(seg, m) {
    const set = s(); const speakerName = seg?.speaker || m?.name;
    const b = findCharacterBinding(speakerName);
    const autoVoice = !b && !seg?.voiceId ? resolveAutoVoice(speakerName, m) : null;
    const styled = resolvePerformanceStyle(seg?.style, {
        speed: seg?.speed ?? set.speed ?? 1, vol: seg?.vol ?? set.vol ?? 1,
        pitch: seg?.pitch ?? set.pitch ?? 0, emotion: seg?.emotion || set.emotion || undefined,
    });
    return {
        model: seg?.model || b?.model || set.model, voiceId: seg?.voiceId || b?.voiceId || autoVoice?.voiceId || set.voiceId,
        speed: Number(styled.speed), vol: Number(styled.vol), pitch: Number(styled.pitch),
        emotion: styled.emotion || undefined, style: seg?.style || 'neutral', audioFormat: set.audioFormat || 'mp3',
        language: set.ttsLanguage || undefined,
    };
}

async function generateMessageSpeech(id, forced = false) {
    const { message, key } = getMessageData(id); if (!message || (s().onlyCharacter && message.is_user)) return false;
    let h = s().serverHistory[key]; if (!forced && h?.versions?.length) return true;
    try {
        let raw;
        if (s().formatterEnabled) {
            raw = await formatWithSecondaryApi(message);
        } else {
            const cleanText = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
            const rules = (s().regexRules || []).filter(r => r.enabled);
            if (!rules.length) {
                raw = [];
            } else {
                // 先运行所有 extract 规则，收集要读的段落
                let extracted = [];
                for (const rule of rules.filter(r => r.mode === 'extract')) {
                    let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
                    let qm;
                    while ((qm = re.exec(cleanText)) !== null) {
                        const t = (qm[1]?.replace(/\n+/g, ' ').trim()) || (qm[0]?.replace(/\n+/g, ' ').trim());
                        if (t) extracted.push({ text: t, speaker: message.name });
                    }
                }
                // 再运行所有 exclude 规则，过滤掉匹配的段落
                for (const rule of rules.filter(r => r.mode === 'exclude')) {
                    let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
                    extracted = extracted.filter(seg => !re.test(seg.text));
                }
                raw = extracted;
            }
        }
        const items = raw.map((seg, segmentIndex) => {
            const options = buildSynthesisOptions(seg, message);
            let text = String(seg.text || '');
            if (!/^speech-2\.8-(hd|turbo)$/i.test(options.model || '')) text = text.replace(/\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '');
            const baseGap = Math.max(0, Math.min(2500, Number(s().segmentGapMs ?? 180)));
            const punctuationGap = /[。！？!?…]$/.test(text.trim()) ? Math.max(baseGap, 320) : /[,，、；;：:]$/.test(text.trim()) ? baseGap : Math.round(baseGap * 0.55);
            const pauseMs = segmentIndex === 0 ? 0 : Math.max(0, Math.min(2500, Number(seg.pauseMs ?? seg.pause ?? punctuationGap)));
            return { text, speaker: seg.speaker || message.name, options, pauseMs, serverPath: null };
        });
        if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
        s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
        s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
        saveSettingsDebounced(); refreshSpeechPanelStatus(); injectBubbles(id); return true;
    } catch (e) { toastr.error('生成失败: ' + e.message); return false; }
}

// 仅提取文本段落（无 API 调用）用于气泡预注入。格式化模式下无法预提取，返回 false。
function extractSegmentsOnly(id) {
    if (!s().showBubbles) return false;
    const { message, key } = getMessageData(id);
    if (!message || message.is_system || (s().onlyCharacter && message.is_user)) return false;
    if (s().serverHistory[key]?.versions?.length) return true; // 已有历史，跳过
    if (message?.extra?.voice_call) return false; // VC 通话记录由 vcInjectCallRecord 单独管理
    if (/class="/.test(message.mes)) return false; // 跳过含 HTML 属性的系统注入消息
    if (s().formatterEnabled) return false; // 格式化需要 API，跳过预提取
    const cleanText = s().ignoreCodeBlocks ? message.mes.replace(/```[\s\S]*?```/g, ' ') : message.mes;
    const rules = (s().regexRules || []).filter(r => r.enabled);
    if (!rules.length) return false;
    let extracted = [];
    for (const rule of rules.filter(r => r.mode === 'extract')) {
        let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
        let qm;
        while ((qm = re.exec(cleanText)) !== null) {
            const t = (qm[1]?.replace(/\n+/g, ' ').trim()) || (qm[0]?.replace(/\n+/g, ' ').trim());
            if (t) extracted.push({ text: t, speaker: message.name });
        }
    }
    for (const rule of rules.filter(r => r.mode === 'exclude')) {
        let re; try { re = new RegExp(parsePattern(rule.pattern), 'g'); } catch(e) { continue; }
        extracted = extracted.filter(seg => !re.test(seg.text));
    }
    if (!extracted.length) return false;
    const items = extracted.map(seg => ({ text: seg.text, speaker: seg.speaker || message.name, options: buildSynthesisOptions(seg, message), serverPath: null }));
    if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
    s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
    s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
    saveSettingsDebounced();
    return true;
}

async function playGeneratedMessage(id) {
    const { key } = getMessageData(id); const h = s().serverHistory[key];
    if (!h?.versions[h.activeIndex]) return false;
    playbackQueue = [...h.versions[h.activeIndex].items];
    playbackToken++;
    activeAudio.pause(); activeAudio.src = '';
    playNext();
    refreshSpeechPanelStatus();
    setTimeout(() => saveSettingsDebounced(), 2000);
    return true;
}

function isBubbleCached(item) {
    if (!String(item?.text || '').trim()) return false;
    if (item.serverPath) return true;
    const cacheKey = audioCacheKey(item);
    return localAudioCache.has(cacheKey);
}

function refreshBubbleStates(mesid) {
    const { key } = getMessageData(mesid);
    const h = s().serverHistory[key];
    const items = h?.versions?.[h.activeIndex]?.items || [];
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    mesEl.querySelectorAll('.mm-bubble').forEach(bubble => {
        const item = items[Number(bubble.dataset.segidx)];
        if (item) bubble.classList.toggle('mm-bubble-cached', isBubbleCached(item));
    });
}

// 创建一个气泡元素（item 为 serverHistory 中的段落对象）
function makeBubble(mesid, segidx, item, withText = false) {
    const el = document.createElement('span');
    el.className = 'mm-bubble';
    el.dataset.mesid = mesid;
    el.dataset.segidx = segidx;
    el.title = item.text;
    el.innerHTML = withText
        ? `<span class="mm-bubble-play"><i class="fa-solid fa-volume-low"></i></span><span class="mm-bubble-text">${escHtml(item.text.length > 20 ? item.text.slice(0, 20) + '…' : item.text)}</span>`
        : `<span class="mm-bubble-play"><i class="fa-solid fa-volume-low"></i></span>`;
    if (isBubbleCached(item)) el.classList.add('mm-bubble-cached');
    bubbleItems.set(el, item);
    const fav = document.createElement('button');
    fav.type = 'button'; fav.className = 'mm-bubble-fav'; fav.title = '收藏这段语音'; fav.setAttribute('aria-label', '收藏这段语音'); fav.textContent = '☆';
    el.appendChild(fav);
    if (favoriteCacheLoaded) updateBubbleFavoriteButton(el);
    return el;
}

// 在 container 的文本节点里找到 searchText，将其所在文本节点截断后插入 insertEl
// 返回 true 表示注入成功
function injectAfterText(container, searchText, insertEl) {
    if (!searchText) return false;
    // 过滤器：跳过已注入气泡内部的节点
    const filter = {
        acceptNode: n => n.parentElement.closest('.mm-bubble, .mm-bubble-strip')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    };
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, filter);
    let node;
    while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(searchText);
        if (idx < 0) continue;
        const endIdx = idx + searchText.length;
        const after = node.textContent.slice(endIdx);
        node.textContent = node.textContent.slice(0, endIdx);
        const parent = node.parentNode, next = node.nextSibling;
        parent.insertBefore(insertEl, next);
        if (after) parent.insertBefore(document.createTextNode(after), insertEl.nextSibling);
        return true;
    }
    return false;
}

function injectBubbles(mesid) {
    if (!s().showBubbles) return;
    if (document.getElementById('minimax_quote_tts_editor')) return; // 参数编辑器打开时不注入
    const { message, key } = getMessageData(mesid);
    // 已生成的角色台词即使原文包含 HTML，也需要显示气泡。
    if (!message || message.is_system) return;
    const h = s().serverHistory[key];
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    const textEl = mesEl.querySelector('.mes_text');
    if (!textEl) return;
    // 台词可以同时带有前置停顿；仅排除没有文本的纯停顿项。
    const allItems = h?.versions?.[h.activeIndex]?.items || [];
    const items = allItems.map((it, idx) => ({ it, idx })).filter(({ it }) => String(it?.text || '').trim());

    // 版本标记 + DOM 实际气泡数双重检查：
    // ST 有时仅替换 .mes_text 的 innerHTML 而不换元素，会抹掉气泡但保留 data-mm-bub-ver。
    const ver = `${key}:${h?.activeIndex}:${items.length}`;
    const actualBubbles = textEl.querySelectorAll('.mm-bubble').length;
    if (textEl.dataset.mmBubVer === ver && actualBubbles === items.length) {
        // 版本吻合且气泡数正确 → 只刷新缓存状态，不重注入
        refreshBubbleStates(mesid);
        return;
    }

    // 清除旧气泡及版本标记
    textEl.querySelectorAll('.mm-bubble').forEach(el => el.remove());
    textEl.querySelector('.mm-bubble-strip')?.remove();
    if (!items.length) return; // 无数据时不写版本，让下次能重试

    const unmatched = [];
    items.forEach(({ it: item, idx }) => {
        // 保留原始下标，点击时能正确命中含前置停顿的台词。
        const bubble = makeBubble(mesid, idx, item, false); // 内联：仅图标
        if (!injectAfterText(textEl, item.text, bubble)) {
            unmatched.push({ item, idx }); // 找不到则归入底部条
        }
    });

    // 没找到内联位置的放底部条（LLM 模式或 markdown 改变了文字）
    if (unmatched.length) {
        const strip = document.createElement('div');
        strip.className = 'mm-bubble-strip';
        unmatched.forEach(({ item, idx }) => strip.appendChild(makeBubble(mesid, idx, item, true)));
        textEl.appendChild(strip);
    }
    textEl.dataset.mmBubVer = ver;
}

function refreshAllBubbles() {
    ensureFavoriteCache();
    if (!s().showBubbles) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const id = Number(el.getAttribute('mesid'));
        extractSegmentsOnly(id); // 未生成过语音时预提取段落，已有历史则直接跳过
        injectBubbles(id);
    });
}

function removeAllBubbles() {
    document.querySelectorAll('.mm-bubble, .mm-bubble-strip').forEach(el => el.remove());
    document.querySelectorAll('[data-mm-bub-ver]').forEach(el => el.removeAttribute('data-mm-bub-ver'));
}

function openParamsEditor(id) {
    const { key } = getMessageData(id); let h = s().serverHistory[key]; if (!h?.versions?.length) return;
    const render = () => {
        const v = h.versions[h.activeIndex];
        const rows = v.items.map((it, i) => `
            <div class="minimax-tts-editor-item">
                <div style="font-size:0.8rem; opacity:0.6; margin-bottom:4px;">说话人: <input class="edit-v" data-prop="speaker" data-idx="${i}" value="${it.speaker || ''}" style="width:100px; height:20px !important; display:inline-block; border:none !important; background:none !important; color:inherit !important; padding:0 !important;"></div>
                <textarea class="text_pole" readonly style="width:100%; height:40px; margin-bottom:8px; background:rgba(0,0,0,0.2) !important;">${it.text}</textarea>
                <div class="minimax-tts-editor-grid">
                    <div class="minimax-tts-editor-row-flex"><label>模型</label><select class="text_pole edit-v" data-prop="model" data-idx="${i}">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
                    <div class="minimax-tts-editor-row-flex"><label>语音</label><input class="text_pole edit-v" data-prop="voiceId" data-idx="${i}" value="${it.options.voiceId}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>情感</label><input class="text_pole edit-v" data-prop="emotion" data-idx="${i}" value="${it.options.emotion||''}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>表演风格</label><input class="text_pole edit-v" data-prop="style" data-idx="${i}" value="${it.options.style||'neutral'}" placeholder="gentle/shy/tsundere"></div>
                    <div class="minimax-tts-editor-row-flex"><label>语速</label><input class="text_pole edit-v" data-prop="speed" type="number" step="0.1" data-idx="${i}" value="${it.options.speed}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音量</label><input class="text_pole edit-v" data-prop="vol" type="number" step="0.1" data-idx="${i}" value="${it.options.vol}"></div>
                    <div class="minimax-tts-editor-row-flex"><label>音调</label><input class="text_pole edit-v" data-prop="pitch" type="number" step="1" data-idx="${i}" value="${it.options.pitch}"></div>
                </div>
            </div>`).join('');
        const html = `<div id="minimax_quote_tts_editor" class="minimax-tts-editor-mask"><div class="minimax-tts-editor-dialog">
            <div class="minimax-tts-editor-header">
                <div style="font-weight:bold; font-size:1.1rem; flex:1">版本历史 ${h.activeIndex+1}/${h.versions.length}</div>
                <div style="display:flex; gap:10px; align-items:center; justify-content:center; flex:1">
                    <button class="menu_button v-prev" style="width:40px;"> < </button>
                    <button class="menu_button v-next" style="width:40px;"> > </button>
                    <button class="menu_button v-del" style="color:#ef5350;" title="删除此版本">删除</button>
                </div>
                <div style="text-align:right;"><button class="menu_button editor-close">关闭面板</button></div>
            </div>
            <div class="minimax-tts-editor-body">${rows}</div>
            <div class="minimax-tts-editor-actions">
                <button class="menu_button editor-save-only" style="height:40px;">保存修改</button>
                <button class="menu_button editor-confirm" style="height:40px;">确认并选择此版本</button>
            </div>
        </div></div>`;
        $('#minimax_quote_tts_editor').remove(); $('body').append(html);
        $('#minimax_quote_tts_editor .v-prev').on('click', () => { if(h.activeIndex>0){ h.activeIndex--; render(); } });
        $('#minimax_quote_tts_editor .v-next').on('click', () => { if(h.activeIndex<h.versions.length-1){ h.activeIndex++; render(); } });
        $('#minimax_quote_tts_editor .v-del').on('click', () => {
            if (h.versions.length <= 1) {
                // 最后一个版本也删掉，清空整条记录
                delete s().serverHistory[key];
                saveSettingsDebounced();
                $('#minimax_quote_tts_editor').remove();
                refreshSpeechPanelStatus();
                return;
            }
            h.versions.splice(h.activeIndex, 1);
            h.activeIndex = Math.min(h.activeIndex, h.versions.length - 1);
            saveSettingsDebounced(); refreshSpeechPanelStatus();
            render();
        });
        const invalidateBubbles = () => {
            refreshSpeechPanelStatus();
            const textEl = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
            if (textEl) textEl.removeAttribute('data-mm-bub-ver');
            setTimeout(() => { injectBubbles(id); refreshBubbleStates(id); }, 100);
        };
        $('#minimax_quote_tts_editor .editor-close').on('click', () => { $('#minimax_quote_tts_editor').remove(); invalidateBubbles(); });
        $('#minimax_quote_tts_editor .edit-v').on('change input', function(){
            const p = $(this).data('prop'), idx = $(this).data('idx'), val = $(this).val();
            if(p === 'speaker'){ v.items[idx].speaker = val; const b = findCharacterBinding(val); if(b){ v.items[idx].options.model = b.model || s().model; v.items[idx].options.voiceId = b.voiceId || s().voiceId; render(); } }
            else { v.items[idx].options[p] = val; } v.items[idx].serverPath = null;
        });
        $('#minimax_quote_tts_editor .editor-save-only').on('click', () => { saveSettingsDebounced(); toastr.success('已保存'); });
        $('#minimax_quote_tts_editor .editor-confirm').on('click', () => { saveSettingsDebounced(); $('#minimax_quote_tts_editor').remove(); invalidateBubbles(); });
        $('#minimax_quote_tts_editor select.edit-v').each(function(){ $(this).val(v.items[$(this).data('idx')].options.model); });
    }; render();
}

function refreshAllLlmPresetSelects() {
    const presets = s().llmPresets || [];
    const opts = '<option value="-1">-- 选择预设 --</option>' + presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
    document.querySelectorAll('.llm-preset-sel').forEach(el => {
        const cur = el.value;
        el.innerHTML = opts;
        if (Number(cur) >= 0 && Number(cur) < presets.length) el.value = cur;
    });
}

function refreshSpeechPanel() {
    const select = document.getElementById('mm_speech_message');
    if (!select || select.disabled) return;
    const previous = select.value;
    const { chat = [] } = getContext();
    const messages = chat.map((message, id) => ({ message, id })).filter(({ message }) =>
        message && !message.is_system && (!s().onlyCharacter || !message.is_user)
        && String(message.mes || '').trim());
    select.replaceChildren(...messages.map(({ message, id }) => {
        const option = document.createElement('option');
        option.value = String(id);
        const preview = String(message.mes).replace(/\s+/g, ' ').trim();
        option.textContent = `#${id + 1} ${message.name || '角色'}：${preview.slice(0, 70)}${preview.length > 70 ? '…' : ''}`;
        return option;
    }));
    select.value = messages.some(({ id }) => String(id) === previous)
        ? previous : String(messages.at(-1)?.id ?? '');
    refreshSpeechPanelStatus();
}

function refreshSpeechPanelStatus() {
    const select = document.getElementById('mm_speech_message');
    if (!select || select.disabled) return;
    const hasMessage = select.value !== '';
    const history = hasMessage ? s().serverHistory[getMessageData(Number(select.value)).key] : null;
    const version = history?.versions?.[history.activeIndex];
    const hasSpeech = !!version?.items?.some(item => item.text);
    document.getElementById('mm_speech_status').textContent = !hasMessage
        ? '当前聊天没有可配音的角色消息。'
        : hasSpeech ? `版本 ${history.activeIndex + 1}/${history.versions.length}，共 ${version.items.filter(item => item.text).length} 段台词。`
        : '尚未生成语音。';
    document.getElementById('mm_speech_generate').disabled = !hasMessage;
    document.getElementById('mm_speech_regenerate').disabled = !hasMessage;
    document.getElementById('mm_speech_play').disabled = !hasSpeech && !isPlaying;
    document.getElementById('mm_speech_play').textContent = isPlaying ? '停止' : '播放';
    document.getElementById('mm_speech_edit').disabled = !hasSpeech;
}

function stopMessagePlayback() {
    playbackQueue = [];
    playbackToken++;
    activeAudio.onended = null; activeAudio.onerror = null;
    activeAudio.pause();
    if (activeAudio.src.startsWith('blob:')) URL.revokeObjectURL(activeAudio.src);
    activeAudio.removeAttribute('src');
    isPlaying = false;
}

function openSpeechPanel() {
    if (!document.getElementById('mm-speech-mask')) {
        document.documentElement.insertAdjacentHTML('beforeend', `
<div id="mm-speech-mask" class="mm-config-mask">
  <div class="mm-config-dialog mm-speech-dialog" role="dialog" aria-modal="true" aria-labelledby="mm_speech_title">
    <div class="mm-config-header">
      <strong id="mm_speech_title">MINIMAX TTS</strong>
      <button id="mm_speech_close" class="mm-config-close" title="关闭" aria-label="关闭语音窗口">✕</button>
    </div>
    <div class="mm-speech-body">
      <label for="mm_speech_message" class="mm-speech-label">消息</label>
      <select id="mm_speech_message" class="text_pole"></select>
      <p id="mm_speech_status" class="mm-desc" role="status" aria-live="polite"></p>
      <div class="mm-speech-actions">
        <button id="mm_speech_generate" class="menu_button" title="生成所选消息的语音">生成</button>
        <button id="mm_speech_play" class="menu_button" title="播放当前版本的语音">播放</button>
        <button id="mm_speech_regenerate" class="menu_button" title="重新生成一个版本">重试</button>
        <button id="mm_speech_edit" class="menu_button" title="编辑参数和版本">编辑</button>
      </div>
    </div>
  </div>
</div>`);
        const mask = document.getElementById('mm-speech-mask');
        const close = () => mask.classList.remove('mm-config-open');
        document.getElementById('mm_speech_close').addEventListener('click', close);
        mask.addEventListener('click', event => { if (event.target === mask) close(); });
        mask.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
        document.getElementById('mm_speech_message').addEventListener('change', refreshSpeechPanelStatus);
        const generate = async forced => {
            const select = document.getElementById('mm_speech_message');
            if (select.disabled || select.value === '') return;
            const id = Number(select.value);
            const { key } = getMessageData(id);
            const status = document.getElementById('mm_speech_status');
            const controls = [select, ...document.querySelectorAll('#mm-speech-mask .mm-speech-actions button')];
            controls.forEach(control => { control.disabled = true; });
            stopMessagePlayback();
            status.textContent = forced ? '正在重试…' : '正在生成…';
            try {
                if (!await generateMessageSpeech(id, forced)) {
                    status.textContent = '生成失败，请查看错误提示后重试。';
                    return;
                }
                if (getMessageData(id).key !== key) {
                    status.textContent = '聊天已切换，请重新选择消息。';
                    return;
                }
                const history = s().serverHistory[key];
                const items = history?.versions?.[history.activeIndex]?.items?.filter(item => item.text) || [];
                if (!items.length) {
                    status.textContent = '没有提取到可朗读的台词，请检查格式化或正则规则。';
                    return;
                }
                for (let i = 0; i < items.length; i++) {
                    if (getMessageData(id).key !== key) {
                        status.textContent = '聊天已切换，请重新选择消息。';
                        return;
                    }
                    status.textContent = `正在生成 ${i + 1}/${items.length}…`;
                    await getAudioBlob(items[i]);
                }
                if (getMessageData(id).key !== key) {
                    status.textContent = '聊天已切换，请重新选择消息。';
                    return;
                }
                saveSettingsDebounced();
                refreshBubbleStates(id);
                status.textContent = `已生成 ${items.length} 段语音。`;
            } catch (error) {
                status.textContent = '操作失败：' + error.message;
            } finally {
                const result = status.textContent;
                controls.forEach(control => { control.disabled = false; });
                refreshSpeechPanel();
                status.textContent = result;
            }
        };
        document.getElementById('mm_speech_generate').addEventListener('click', () => generate(false));
        document.getElementById('mm_speech_regenerate').addEventListener('click', () => generate(true));
        document.getElementById('mm_speech_play').addEventListener('click', () => {
            if (isPlaying) {
                stopMessagePlayback();
                refreshSpeechPanelStatus();
                return;
            }
            const select = document.getElementById('mm_speech_message');
            if (select.value !== '') playGeneratedMessage(Number(select.value));
        });
        document.getElementById('mm_speech_edit').addEventListener('click', () => {
            const id = Number(document.getElementById('mm_speech_message').value);
            openParamsEditor(id);
        });
    }
    refreshSpeechPanel();
    const select = document.getElementById('mm_speech_message');
    document.getElementById('mm-speech-mask').classList.add('mm-config-open');
    select.focus();
}

function createUi() {
    // 在魔法棒菜单（左下角）添加入口
    const wandHtml = `<div id="mm_wand_item" class="list-group-item flex-container flexGap5" title="MINIMAX TTS 语音生成"><div class="fa-solid fa-volume-high extensionsMenuExtensionButton"></div>MINIMAX TTS</div>`;
    $('#extensionsMenu').append(wandHtml);
    $('#mm_wand_item').on('click', () => {
        // 关闭魔法棒菜单
        const menu = document.getElementById('extensionsMenu');
        if (menu) menu.style.display = 'none';
        openSpeechPanel();
    });

    $('#extensions_settings').append(`
<div id="mm_settings" class="extension_container">
  <div class="inline-drawer">
    <div id="mm_settings_toggle" class="inline-drawer-toggle inline-drawer-header">
      <b>MINIMAX TTS</b>
      <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
    </div>
    <div class="inline-drawer-content"><div id="mm_settings_content"></div></div>
  </div>
</div>`);
    $('#mm_settings_toggle').on('click', renderConfigPanel);

    loadSettings();
    refreshAllLlmPresetSelects();
    eventSource.on(event_types.CHARACTER_SELECTED, () => { if (document.getElementById('mm_b_rows')) renderBindings(); });
    eventSource.on(event_types.CHAT_CHANGED, () => { if (document.getElementById('mm_b_rows')) renderBindings(); });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const select = document.getElementById('mm_speech_message');
        if (select) select.value = '';
        refreshSpeechPanel();
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        if (!document.getElementById('mm_speech_message')?.disabled) refreshSpeechPanel();
    });
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────────

function getDefaultVcBlocks() {
    return [
        { id: 'charDesc',     enabled: true,  label: '角色卡描述',  editable: false, hint: '（自动读取当前角色卡描述）' },
        { id: 'worldBook',    enabled: false, label: '世界书',      editable: false, hint: '（世界书注入内容，内容多时注意 token 消耗）' },
        { id: 'context',      enabled: true,  label: '上下文对话',  editable: false, hint: '（酒馆聊天记录，见下方条数设置）' },
        { id: 'vcSystem',  enabled: true,  label: '通话系统提示词', editable: true  },
        { id: 'vrmActions', enabled: false, label: 'VRM表情/动作', editable: false, hint: '（视频通话时让 AI 输出表情动作标签，语音通话无效）' },
    ];
}

function renderVoiceLibrary() {
    const container = document.getElementById('mm_voice_lib_rows');
    const lib = s().voiceLibrary || [];
    const count = document.getElementById('mm_voice_lib_count');
    if (count) count.textContent = `${lib.length} 个音色`;
    if (!container) return;
    container.innerHTML = '';
    const query = (document.getElementById('mm_voice_search')?.value || '').trim().toLocaleLowerCase();
    const matches = lib.map((voice, index) => ({ voice, index })).filter(({ voice }) =>
        !query || `${voice.name || ''} ${voice.voiceId || ''}`.toLocaleLowerCase().includes(query));
    if (!matches.length) {
        container.innerHTML = `<p class="mm-desc">${lib.length ? '没有匹配的音色。' : '语音库为空，点击“添加”录入音色。'}</p>`;
        return;
    }
    matches.forEach(({ voice: v, index: i }) => {
        const el = document.createElement('div');
        el.className = 'mm-voice-lib-row';
        el.innerHTML = `
            <input class="text_pole vl-name" aria-label="音色名称" placeholder="名称（如：路人甲女声）" value="${escHtml(v.name||'')}">
            <input class="text_pole vl-id" aria-label="Voice ID" placeholder="voiceId" value="${escHtml(v.voiceId||'')}">
            <button class="menu_button vl-test" title="试听此音色" style="padding:4px 9px;flex-shrink:0">试听</button>
            <button class="menu_button vl-copy" title="复制 Voice ID" style="padding:4px 9px;flex-shrink:0">复制</button>
            <button class="menu_button vl-del" title="删除音色" style="padding:4px 10px;flex-shrink:0">×</button>
        `;
        el.querySelector('.vl-name').addEventListener('input', function() { lib[i].name = this.value; saveSettingsDebounced(); refreshVoiceSelects(); });
        el.querySelector('.vl-id').addEventListener('input', function() { lib[i].voiceId = this.value; saveSettingsDebounced(); });
        el.querySelector('.vl-test').addEventListener('click', async function() {
            const voiceId = String(lib[i]?.voiceId || '').trim();
            if (!voiceId) { toastr.warning('请先填写 Voice ID'); return; }
            const button = this;
            button.disabled = true; button.textContent = '生成中…';
            try {
                const lang = s().ttsLanguage || '';
                const samples = { ja: 'こんにちは。こちらの音声を試聴しています。', en: 'Hello. This is a voice preview.', ko: '안녕하세요. 음성을 미리 듣고 있습니다.' };
                const text = samples[lang] || '你好，这是一段音色试听。';
                const options = { ...buildSynthesisOptions(null, null), voiceId };
                const blob = await getAudioBlob({ text, options, serverPath: null });
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
                audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
                await audio.play();
                toastr.success(`正在试听：${lib[i]?.name || voiceId}`);
            } catch (e) { toastr.error(`音色试听失败：${e.message}`); }
            finally { button.disabled = false; button.textContent = '试听'; }
        });
        el.querySelector('.vl-copy').addEventListener('click', async () => {
            const id = String(lib[i]?.voiceId || '').trim();
            if (!id) { toastr.warning('没有可复制的 Voice ID'); return; }
            try { await navigator.clipboard.writeText(id); toastr.success('Voice ID 已复制'); }
            catch (_) { toastr.info(`Voice ID：${id}`); }
        });
        el.querySelector('.vl-del').addEventListener('click', () => { lib.splice(i, 1); saveSettingsDebounced(); renderVoiceLibrary(); refreshVoiceSelects(); });
        container.appendChild(el);
    });
}

function refreshVoiceSelects() {
    const lib = s().voiceLibrary || [];
    const opts = '<option value="">直接输入</option>' + lib.map(v => `<option value="${escHtml(v.voiceId)}">${escHtml(v.name)}</option>`).join('');
    document.querySelectorAll('.mm-voice-sel').forEach(el => {
        const cur = el.value;
        el.innerHTML = opts;
        if (cur && [...el.options].some(o => o.value === cur)) el.value = cur;
    });
}

function renderRules() {
    const container = document.getElementById('mm_rule_rows');
    if (!container) return;
    container.innerHTML = '';
    const rules = s().regexRules || [];
    rules.forEach((rule, i) => {
        const el = document.createElement('div');
        el.className = 'mm-rule-row';
        el.innerHTML = `
            <input type="checkbox" class="mm-rule-toggle" ${rule.enabled ? 'checked' : ''} title="启用/禁用">
            <input class="text_pole mm-rule-name"    placeholder="规则名" value="${escHtml(rule.name||'')}">
            <input class="text_pole mm-rule-pattern" placeholder="正则 或 /pattern/" value="${escHtml(rule.pattern||'')}">
            <select class="text_pole mm-rule-mode" style="max-width:68px">
                <option value="extract" ${rule.mode==='extract'?'selected':''}>提取</option>
                <option value="exclude" ${rule.mode==='exclude'?'selected':''}>排除</option>
            </select>
            <button class="menu_button mm-rule-del" title="删除">×</button>
        `;
        el.querySelector('.mm-rule-toggle').addEventListener('change', function() { rules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input',    function() { rules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function() { rules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change',   function() { rules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click',     () => { rules.splice(i, 1); saveSettingsDebounced(); renderRules(); });
        container.appendChild(el);
    });
}

function renderPreProcessRules() {
    const container = document.getElementById('mm_pre_rule_rows');
    if (!container) return;
    container.innerHTML = '';
    const rules = s().llmPreProcessRules || [];
    rules.forEach((rule, i) => {
        const el = document.createElement('div');
        el.className = 'mm-rule-row';
        el.innerHTML = `
            <input type="checkbox" class="mm-rule-toggle" ${rule.enabled ? 'checked' : ''} title="启用/禁用">
            <input class="text_pole mm-rule-name"    placeholder="规则名" value="${escHtml(rule.name||'')}">
            <input class="text_pole mm-rule-pattern" placeholder="正则 或 /pattern/" value="${escHtml(rule.pattern||'')}">
            <select class="text_pole mm-rule-mode" style="max-width:68px">
                <option value="extract" ${rule.mode==='extract'?'selected':''}>提取</option>
                <option value="exclude" ${rule.mode==='exclude'?'selected':''}>排除</option>
            </select>
            <button class="menu_button mm-rule-del" title="删除">×</button>
        `;
        el.querySelector('.mm-rule-toggle').addEventListener('change', function() { rules[i].enabled = this.checked; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-name').addEventListener('input',    function() { rules[i].name = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-pattern').addEventListener('input', function() { rules[i].pattern = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-mode').addEventListener('change',   function() { rules[i].mode = this.value; saveSettingsDebounced(); });
        el.querySelector('.mm-rule-del').addEventListener('click',     () => { rules.splice(i, 1); saveSettingsDebounced(); renderPreProcessRules(); });
        container.appendChild(el);
    });
}

function renderVcBlocks() {
    if (!s().vcPromptBlocks) s().vcPromptBlocks = getDefaultVcBlocks();
    const blocks = s().vcPromptBlocks;
    const container = document.getElementById('mm_vc_blocks');
    if (!container) return;
    container.innerHTML = '';
    const BUILTIN_IDS = new Set(['charDesc', 'worldBook', 'context', 'vcSystem', 'vrmActions']);
    blocks.forEach((block, i) => {
        const el = document.createElement('div');
        el.className = 'mm-block mm-draggable';
        el.draggable = true;
        el.dataset.idx = i;
        const isBuiltin = BUILTIN_IDS.has(block.id);
        // For vcSystem block, use s().vcSystemPrompt; for custom blocks, use block.content
        const textareaVal = block.id === 'vcSystem' ? escHtml(s().vcSystemPrompt||'') : escHtml(block.content||'');
        el.innerHTML = `
            <div class="mm-block-header">
                <span class="mm-drag-handle" title="拖拽排序">≡</span>
                <input type="checkbox" class="mm-block-toggle" ${block.enabled ? 'checked' : ''}>
                <span class="mm-block-label">${escHtml(block.label)}</span>
                <div style="display:flex;gap:4px;margin-left:auto">
                    ${block.editable ? `<button class="mm-rename-block menu_button" title="重命名" style="padding:2px 8px;font-size:0.78rem">✎</button>` : ''}
                    ${block.editable ? `<button class="mm-expand-block menu_button" title="展开编辑" style="padding:2px 8px;font-size:0.78rem">⛶</button>` : ''}
                    ${!isBuiltin ? `<button class="mm-del-block menu_button" title="删除" style="padding:2px 8px;font-size:0.78rem">×</button>` : ''}
                </div>
            </div>
            ${block.hint ? `<div class="mm-block-hint">${block.hint}</div>` : ''}
            ${block.id === 'worldBook' ? `<div class="mm-block-content" style="margin-top:6px;display:flex;align-items:center;gap:8px"><span class="mm-wb-count" style="font-size:0.8rem;opacity:0.65">${block.selectedEntries?.length ? `已选 ${block.selectedEntries.length} 条` : '全部注入（未指定条目）'}</span><button class="menu_button mm-wb-manage" style="padding:2px 10px;font-size:0.78rem">选择条目</button></div>` : ''}
            ${block.editable ? `<div class="mm-block-content"><textarea class="mm-block-textarea text_pole" style="min-height:64px;margin-top:6px;width:100%">${textareaVal}</textarea></div>` : ''}
        `;
        el.querySelector('.mm-block-toggle').addEventListener('change', function() {
            s().vcPromptBlocks[i].enabled = this.checked; saveSettingsDebounced();
        });
        if (block.editable) {
            el.querySelector('.mm-block-textarea').addEventListener('input', function() {
                if (block.id === 'vcSystem') s().vcSystemPrompt = this.value;
                else s().vcPromptBlocks[i].content = this.value;
                saveSettingsDebounced();
            });
        }
        el.querySelector('.mm-wb-manage')?.addEventListener('click', async () => {
            const blockRef = s().vcPromptBlocks[i];
            let entries;
            try { entries = await loadAllWbEntries(); } catch(e) { toastr.error('加载世界书失败: ' + e.message); return; }
            if (!entries.length) { toastr.warning('未找到当前角色的世界书条目，请确保已为角色绑定世界书'); return; }
            const selected = new Set(blockRef.selectedEntries || []);
            const wrap = document.createElement('div');
            wrap.style.cssText = 'max-height:55vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding:4px';
            entries.forEach(entry => {
                const label = document.createElement('label');
                label.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-radius:6px;background:rgba(128,128,128,0.06);user-select:none';
                const cb = document.createElement('input');
                cb.type = 'checkbox'; cb.checked = selected.has(entry.key);
                cb.style.cssText = 'margin-top:2px;flex-shrink:0';
                const info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0;font-size:0.85rem';
                info.innerHTML = `<div style="font-weight:600">${escHtml(entry.title)}</div><div style="opacity:0.5;font-size:0.78rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escHtml(entry.content.slice(0, 120))}${entry.content.length > 120 ? '…' : ''}</div>`;
                cb.addEventListener('change', () => { cb.checked ? selected.add(entry.key) : selected.delete(entry.key); });
                label.appendChild(cb); label.appendChild(info);
                wrap.appendChild(label);
            });
            const ok = await callGenericPopup(wrap, POPUP_TYPE.CONFIRM, '选择注入的世界书条目', { wide: true, okButton: '确认', cancelButton: '取消' });
            if (ok) { blockRef.selectedEntries = [...selected]; saveSettingsDebounced(); renderVcBlocks(); }
        });
        el.querySelector('.mm-del-block')?.addEventListener('click', () => {
            s().vcPromptBlocks.splice(i, 1); saveSettingsDebounced(); renderVcBlocks();
        });
        el.querySelector('.mm-rename-block')?.addEventListener('click', () => {
            const name = prompt('重命名块：', block.label);
            if (name !== null && name.trim()) {
                s().vcPromptBlocks[i].label = name.trim();
                saveSettingsDebounced(); renderVcBlocks();
            }
        });
        el.querySelector('.mm-expand-block')?.addEventListener('click', async () => {
            const ta = document.createElement('textarea');
            ta.className = 'text_pole';
            ta.style.cssText = 'width:100%;height:45vh;resize:none;font-family:inherit;box-sizing:border-box';
            ta.value = block.id === 'vcSystem' ? (s().vcSystemPrompt || '') : (block.content || '');
            const ok = await callGenericPopup(ta, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: '确认', cancelButton: '取消' });
            if (ok) {
                if (block.id === 'vcSystem') s().vcSystemPrompt = ta.value;
                else s().vcPromptBlocks[i].content = ta.value;
                saveSettingsDebounced(); renderVcBlocks();
            }
        });
        // Drag-and-drop
        el.addEventListener('dragstart', e => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
            el.classList.add('mm-dragging');
        });
        el.addEventListener('dragend',  () => el.classList.remove('mm-dragging'));
        el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('mm-drag-over'); });
        el.addEventListener('dragleave',() => el.classList.remove('mm-drag-over'));
        el.addEventListener('drop',     e => {
            e.preventDefault(); el.classList.remove('mm-drag-over');
            const fromIdx = Number(e.dataTransfer.getData('text/plain')), toIdx = i;
            if (fromIdx === toIdx) return;
            const arr = s().vcPromptBlocks;
            const [moved] = arr.splice(fromIdx, 1);
            arr.splice(toIdx, 0, moved);
            saveSettingsDebounced(); renderVcBlocks();
        });
        container.appendChild(el);
    });
}

function renderBindings() {
    const c = getContext(), id = c.characterId || c.character_id || c.name2 || 'global';
    if (!s().characterBindingsMap[id]) s().characterBindingsMap[id] = [];
    const container = $('#mm_b_rows');
    if (!container.length) return;
    container.empty();
    const lib = s().voiceLibrary || [];
    s().characterBindingsMap[id].forEach((b, i) => {
        const voiceOpts = '<option value="">直接输入</option>' + lib.map(v => `<option value="${escHtml(v.voiceId)}">${escHtml(v.name)}</option>`).join('');
        const libMatch = lib.find(v => v.voiceId === b.voiceId);
        const row = $(`<div class="mm-binding-row">
            <select class="text_pole b-type">
                <option value="${TARGET_TYPE.CURRENT_CHARACTER}">${escHtml(c.name2||'角色')}</option>
                <option value="${TARGET_TYPE.CURRENT_USER}">${escHtml(c.name1||'你')}</option>
                <option value="${TARGET_TYPE.CUSTOM}">自定义</option>
            </select>
            <input class="text_pole b-name" placeholder="名称" value="${escHtml(b.customName||'')}" style="${b.targetType===TARGET_TYPE.CUSTOM?'':'display:none'}">
            <select class="text_pole b-model">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select>
            <select class="text_pole b-voice-lib mm-voice-sel">${voiceOpts}</select>
            <input class="text_pole b-voice" placeholder="voiceId" value="${escHtml(libMatch?'':b.voiceId||'')}" style="${libMatch?'display:none':''}">
            <button class="menu_button b-del" style="padding:4px 10px;flex-shrink:0">×</button>
        </div>`);
        row.find('.b-type').val(b.targetType).on('change', function() { b.targetType=$(this).val(); renderBindings(); saveSettingsDebounced(); });
        row.find('.b-name').on('input', function() { b.customName=$(this).val(); saveSettingsDebounced(); });
        row.find('.b-model').val(b.model || s().model).on('change', function() { b.model=$(this).val(); saveSettingsDebounced(); });
        row.find('.b-voice-lib').val(libMatch ? b.voiceId : '').on('change', function() {
            const v = $(this).val(); b.voiceId = v;
            row.find('.b-voice').toggle(!v).val(''); saveSettingsDebounced();
        });
        row.find('.b-voice').on('input', function() { b.voiceId=$(this).val(); saveSettingsDebounced(); });
        row.find('.b-del').on('click', () => { s().characterBindingsMap[id].splice(i, 1); renderBindings(); saveSettingsDebounced(); });
        container.append(row);
    });
}

function renderRegexPresets() {
    const sel = document.getElementById('mm_regex_presets');
    if (!sel) return;
    sel.innerHTML = '<option value="-1">-- 选择预设 --</option>';
    (s().regexPresets || []).forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = p.name;
        sel.appendChild(opt);
    });
}

function renderConfigPanel() {
    if (!document.getElementById('mm-config-dialog')) {
        const panelHtml = `
  <div id="mm-config-dialog" class="mm-config-dialog mm-config-inline">
    <div class="mm-config-header">
      <div class="mm-tab-bar" role="tablist">
        <button class="mm-tab active" data-tab="tts">TTS配置</button>
        <button class="mm-tab" data-tab="llm">LLM预设</button>
        <button class="mm-tab" data-tab="format">格式化</button>
        <button class="mm-tab" data-tab="vc">语音通话</button>
        <button class="mm-tab" data-tab="vrm">视频通话</button>
        <button class="mm-tab" data-tab="favorites">语音收藏</button>
      </div>
    </div>
    <div class="mm-config-body">

      <!-- Tab: TTS配置 -->
      <div class="mm-tab-panel active" data-panel="tts">
        <p class="mm-desc">配置 MiniMax TTS API 连接参数及默认音色。</p>
        <div class="mm-row"><label>API Key</label><input id="mm_key" class="text_pole" type="password" autocomplete="off"></div>
        <div class="mm-row"><label>Group ID</label><input id="mm_gid" class="text_pole" type="text" placeholder="可选，sk-cp 新版密钥可留空"></div>
        <div class="mm-row"><label>API 节点</label><select id="mm_apihost" class="text_pole">${API_HOST_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
        <div class="mm-row"><label>默认模型</label><select id="mm_model" class="text_pole">${MODEL_OPTIONS.map(o=>`<option value="${o.value}">${o.label}</option>`).join('')}</select></div>
        <div class="mm-row">
          <label>默认语音</label>
          <select id="mm_voice_sel" class="text_pole mm-voice-sel" style="flex:1"></select>
          <input id="mm_voice" class="text_pole" placeholder="voiceId" style="max-width:160px">
        </div>
        <div class="mm-row"><label>语速</label><input id="mm_speed" class="text_pole" type="number" step="0.1" min="0.5" max="2" style="max-width:80px"></div>
        <div class="mm-row"><label>音量</label><input id="mm_vol" class="text_pole" type="number" step="0.1" min="0" max="10" style="max-width:80px"></div>
        <div class="mm-row"><label>语言</label>
          <select id="mm_tts_lang" class="text_pole">
            <option value="">自动（Auto）</option>
            <option value="zh">中文 (zh)</option>
            <option value="en">English (en)</option>
            <option value="ja">日本語 (ja)</option>
            <option value="ko">한국어 (ko)</option>
            <option value="fr">Français (fr)</option>
            <option value="de">Deutsch (de)</option>
            <option value="es">Español (es)</option>
            <option value="pt">Português (pt)</option>
            <option value="id">Indonesia (id)</option>
            <option value="ar">العربية (ar)</option>
          </select>
          <span class="mm-inline-hint">克隆声音使用时建议明确指定语言</span>
        </div>
        <div class="mm-row"><label>自动播放</label><input id="mm_autoplay" type="checkbox"></div>
        <div class="mm-row"><label>语音气泡</label><input id="mm_show_bubbles" type="checkbox"><span class="mm-inline-hint">在台词旁显示播放和收藏气泡，点击可单独收听该段语音</span></div>
        <details><summary>仅测试一次，不保存密钥</summary><div class="mm-row"><label>临时 API Key</label><input id="mm_test_key" class="text_pole" type="password" autocomplete="off" placeholder="可选：仅用于下一次测试，完成后清空"></div></details>
        <div class="mm-row" style="flex-wrap:wrap;gap:8px"><button id="mm_test_tts" class="menu_button"><i class="fa-solid fa-play"></i> 测试语音</button><button id="mm_save_test" class="menu_button" disabled>收藏测试语音</button><button id="mm_run_diagnostics" class="menu_button"><i class="fa-solid fa-stethoscope"></i> 运行插件诊断</button></div>
        <div id="mm_diagnostics_result" class="mm-desc" role="status" aria-live="polite">检查酒馆存储读写并统计收藏与缓存；不会显示 API Key 或调用付费合成。</div>
        <div class="mm-voice-library-head">
          <details id="mm_voice_lib_details" class="mm-voice-library-details">
            <summary><span>语音库</span><span id="mm_voice_lib_count" class="mm-voice-lib-count">0 个音色</span></summary>
          </details>
          <button id="mm_add_voice" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button>
        </div>
        <div id="mm_voice_lib_content" class="mm-voice-lib-content" hidden>
          <p class="mm-desc">为语音 ID 起名，支持搜索、单独试听和复制 ID；试听使用当前模型、语速、音量与语言设置。</p>
          <input id="mm_voice_search" class="text_pole" type="search" placeholder="搜索音色名称或 Voice ID…" style="width:100%;margin:6px 0">
          <div id="mm_voice_lib_rows" class="mm-voice-lib-list"></div>
        </div>
        <div class="mm-section-title" style="margin-top:16px">角色绑定 <button id="mm_add_b" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">为当前角色卡的各角色分配专属音色，优先级高于默认语音。</p>
        <div id="mm_b_rows"></div>
      </div>

      <!-- Tab: LLM预设 -->
      <div class="mm-tab-panel" data-panel="llm">
        <p class="mm-desc">管理用于格式化和语音通话的 LLM API 预设。</p>
        <div class="mm-row">
          <label>预设</label>
          <select id="mm_llm_presets" class="text_pole llm-preset-sel"></select>
          <button id="mm_llm_save_p" class="menu_button">保存</button>
          <button id="mm_llm_upd_p" class="menu_button">更新</button>
          <button id="mm_llm_del_p" class="menu_button">删除</button>
        </div>
        <div class="mm-row"><label>接口格式</label><select id="mm_llm_format" class="text_pole"><option value="${API_FORMATS.OAI}">OpenAI</option><option value="${API_FORMATS.GOOGLE}">Google Gemini</option></select></div>
        <div class="mm-row"><label>API 地址</label><input id="mm_llm_url" class="text_pole" type="text" placeholder="https://api.openai.com/v1"></div>
        <div class="mm-row"><label>API 密钥</label><input id="mm_llm_key" class="text_pole" type="password" autocomplete="off"></div>
        <div class="mm-row"><label>AI 模型</label><input id="mm_llm_model" class="text_pole" type="text"><select id="mm_llm_model_sel" class="text_pole" style="display:none"></select><button id="mm_llm_fetch" class="menu_button">获取</button><button id="mm_llm_test_conn" class="menu_button">测试</button></div>
      </div>

      <!-- Tab: 格式化（正则规则 + 副LLM） -->
      <div class="mm-tab-panel" data-panel="format">
        <p class="mm-desc">两种格式化方式：正则规则手动提取朗读内容；启用副 LLM 后交由 AI 结构化处理（支持多角色/情感），两者互斥，启用副 LLM 时正则规则不生效。</p>

        <div class="mm-section-title">正则文本规则 <button id="mm_add_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <div class="mm-rule-header-row">
          <span class="mm-rule-toggle"></span>
          <span class="mm-rule-name">名称</span>
          <span class="mm-rule-pattern">正则表达式</span>
          <span class="mm-rule-mode">模式</span>
          <span class="mm-rule-del"></span>
        </div>
        <div id="mm_rule_rows"></div>
        <div class="mm-section-title" style="margin-top:12px">规则预设</div>
        <div class="mm-row" style="flex-wrap:wrap;gap:6px">
          <select id="mm_regex_presets" class="text_pole" style="min-width:120px;flex:1"></select>
          <button id="mm_regex_save_p" class="menu_button">保存</button>
          <button id="mm_regex_upd_p" class="menu_button">更新</button>
          <button id="mm_regex_del_p" class="menu_button">删除</button>
          <button id="mm_regex_export" class="menu_button">导出</button>
          <button id="mm_regex_import" class="menu_button">导入</button>
        </div>

        <div class="mm-section-title" style="margin-top:16px">副 LLM 格式化</div>
        <div class="mm-row"><label>启用格式化</label><input id="mm_f_en" type="checkbox"></div>
        <div class="mm-section-title">AI 情感演绎导演</div>
        <div class="mm-section-title">多角色智能配音</div>
        <div class="mm-row"><label>NPC 自动分配音色</label><input id="mm_auto_voice_casting" type="checkbox"><span class="mm-inline-hint">主角/手动绑定优先；新 NPC 首次出现自动选音色并记住</span></div>
        <div class="mm-row"><label>每个聊天独立 NPC 上限</label><input id="mm_auto_voice_max" class="text_pole" type="number" min="1" max="100" step="1" style="max-width:90px"><span class="mm-inline-hint">超出上限后复用音色库中的声音</span></div>
        <div class="mm-row"><label>自动情绪导演</label><input id="mm_emotion_director" type="checkbox"><span class="mm-inline-hint">结合角色卡与台词生成逐段情绪、停顿和语气词；需启用副 LLM 格式化</span></div>
        <div class="mm-row"><label>表演强度</label><select id="mm_emotion_intensity" class="text_pole"><option value="subtle">自然克制</option><option value="balanced">情感丰富</option><option value="expressive">戏剧化</option></select></div>
        <div class="mm-row"><label>演绎模式</label><select id="mm_performance_mode" class="text_pole"><option value="natural">真人自然聊天</option><option value="hybrid">双模式融合（推荐）</option><option value="immersive">动漫角色沉浸</option></select></div>
        <div class="mm-row"><label>上下文条数</label><input id="mm_director_context" class="text_pole" type="number" min="0" max="8" step="1" style="max-width:90px"><span class="mm-inline-hint">越多越了解剧情，也会增加 LLM 输入用量</span></div>
        <div class="mm-row"><label>缓存情绪分析</label><input id="mm_director_cache" type="checkbox"><span class="mm-inline-hint">相同台词和上下文不重复调用副 LLM</span></div>
        <div class="mm-section-title">V6 音频稳定性与发音</div>
        <div class="mm-row"><label>失败自动重试次数</label><input id="mm_retry_count" class="text_pole" type="number" min="0" max="5" style="max-width:80px"><span class="mm-inline-hint">仅对超时、限流和服务器错误重试</span></div>
        <div class="mm-row"><label>片段衔接停顿（毫秒）</label><input id="mm_segment_gap" class="text_pole" type="number" min="0" max="2500" style="max-width:90px"><span class="mm-inline-hint">AI 未指定停顿时的默认间隔</span></div>
        <div class="mm-row" style="align-items:flex-start"><label>发音纠错词典</label><textarea id="mm_pronunciation_dict" class="text_pole" rows="4" placeholder="例如：
沈清秋=>沈清秋（shen 三声 qing 一声 qiu 一声）
AI=>A I"></textarea></div>
        <p class="mm-desc">每行一条，格式：原词=&gt;替换读音。只影响 TTS，不修改聊天记录。缓存按文本、音色、模型和参数区分。</p>
        <div class="mm-section-title">智能音频缓存管理</div>
        <div class="mm-row"><label>缓存保留天数</label><input id="mm_cache_days" class="text_pole" type="number" min="1" max="365" style="max-width:90px"><span class="mm-inline-hint">默认 7 天；过期普通缓存自动清理</span></div>
        <div class="mm-row"><label>缓存容量上限（MB）</label><input id="mm_cache_max_mb" class="text_pole" type="number" min="100" max="20480" step="100" style="max-width:100px"><span class="mm-inline-hint">默认 1024 MB；超限优先删除最旧缓存</span></div>
        <div class="mm-row" style="flex-wrap:wrap"><button id="mm_cache_refresh" class="menu_button">刷新缓存统计</button><button id="mm_cache_cleanup" class="menu_button">立即清理普通缓存</button><span id="mm_cache_stats" class="mm-inline-hint">缓存统计尚未加载</span></div>
        <p class="mm-desc">仅清理普通 TTS 缓存；收藏语音独立保存，永不参与自动清理。旧版本上传到 SillyTavern 文件目录的音频不会被本功能擅自删除。</p>
        <div class="mm-section-title">当前角色声音人格</div>
        <textarea id="mm_voice_personality" class="text_pole" rows="3" placeholder="例如：温柔但有些傲娇；平时语速偏慢，害羞时会犹豫，生气时语气冷淡。"></textarea>
        <p class="mm-desc">声音人格按当前角色单独保存；双模式融合会在日常聊天保持自然，在情绪明显时增强演绎。</p>
        <p class="mm-desc">Speech 2.8 HD/Turbo 支持原生语气词标签；其他模型会自动移除不兼容的语气词标签。停顿标记由模型支持时生效。</p>
        <div class="mm-row"><label>LLM预设</label><select id="mm_f_preset_sel" class="text_pole llm-preset-sel"></select></div>
        <div class="mm-row" style="flex-wrap:wrap;gap:6px">
          <label style="min-width:85px">模板</label>
          <select id="mm_f_templates" class="text_pole" style="min-width:120px;flex:1"></select>
          <button id="mm_f_save_t" class="menu_button">保存</button>
          <button id="mm_f_upd_t" class="menu_button">更新</button>
          <button id="mm_f_del_t" class="menu_button">删除</button>
          <button id="mm_f_export_t" class="menu_button">导出</button>
          <button id="mm_f_import_t" class="menu_button">导入</button>
        </div>
        <div class="mm-row" style="align-items:flex-start">
          <label style="padding-top:6px">系统提示词</label>
          <textarea id="mm_f_prompt" class="text_pole" style="flex:1;width:0"></textarea>
        </div>

        <div class="mm-section-title" style="margin-top:16px">预处理规则 <button id="mm_add_pre_rule" class="menu_button" style="font-size:0.8rem;padding:3px 10px">+ 添加</button></div>
        <p class="mm-desc">发送给副LLM或语音通话LLM之前，对消息文本执行正则处理（如剔除 &lt;think&gt; 思维链标签）。排除=删除匹配内容，提取=仅保留匹配内容。</p>
        <div class="mm-rule-header-row">
          <span class="mm-rule-toggle"></span>
          <span class="mm-rule-name">名称</span>
          <span class="mm-rule-pattern">正则表达式</span>
          <span class="mm-rule-mode">模式</span>
          <span class="mm-rule-del"></span>
        </div>
        <div id="mm_pre_rule_rows"></div>
      </div>

      <!-- Tab: 语音通话 -->
      <div class="mm-tab-panel" data-panel="vc">
        <p class="mm-desc">实时语音通话。启用后悬浮球出现，点击发起通话。推荐使用无思考链的极速模型以降低延迟。</p>
        <div class="mm-row"><label>启用通话</label><input id="mm_vc_enabled" type="checkbox"></div>
        <div class="mm-row"><label>LLM 预设</label><select id="mm_vc_llm_preset" class="text_pole llm-preset-sel"></select></div>
        <div class="mm-row">
          <label>挂断注入</label>
          <input id="mm_vc_inject" type="checkbox">
          <span class="mm-inline-hint">通话结束后把记录注入聊天</span>
        </div>
        <div class="mm-section-title" style="margin-top:16px">通话提示词</div>
        <div class="mm-row" style="flex-wrap:wrap;gap:6px">
          <select id="mm_vc_templates" class="text_pole" style="min-width:120px;flex:1"></select>
          <button id="mm_vc_save_t" class="menu_button">保存</button>
          <button id="mm_vc_upd_t" class="menu_button">更新</button>
          <button id="mm_vc_del_t" class="menu_button">删除</button>
          <button id="mm_vc_export_t" class="menu_button">导出</button>
          <button id="mm_vc_import_t" class="menu_button">导入</button>
        </div>
        <p class="mm-hint">拖拽 ≡ 可调整顺序，☑ 开关模块。上下文越多注入演绎更准确但回复更慢，反之亦然。</p>
        <div id="mm_vc_blocks" class="mm-block-list"></div>
        <div class="mm-row" style="margin-top:12px">
          <label>上下文条数</label>
          <input id="mm_vc_ctx_count" class="text_pole" type="number" style="max-width:70px">
          <span class="mm-inline-hint">条（注入通话前）</span>
        </div>
        <div class="mm-row" style="margin-top:6px">
          <button id="mm_vc_add_block" class="menu_button"><i class="fa-solid fa-plus"></i> 添加自定义块</button>
        </div>
      </div>

      <!-- Tab: 视频通话 -->
      <div class="mm-tab-panel" data-panel="vrm">
        <p class="mm-desc">通话时渲染 VRM 3D 角色，占据屏幕上半部分（类视觉小说布局），支持实时口型同步与情感表情驱动。</p>

        <div class="mm-section-title">基本设置</div>
        <div class="mm-row">
          <label>启用视频通话</label>
          <input id="mm_vrm_enabled" type="checkbox">
          <span class="mm-inline-hint">启用后出现视频悬浮球</span>
        </div>
        <div class="mm-row">
          <label>LLM 预设</label>
          <select id="mm_vrm_llm_preset" class="text_pole llm-preset-sel"></select>
        </div>

        <div class="mm-section-title" style="margin-top:14px">VRM 模型</div>
        <div class="mm-row">
          <label>模型 URL</label>
          <input id="mm_vrm_url" class="text_pole" type="text" placeholder="https://... 或留空使用下方上传">
        </div>
        <div class="mm-row">
          <label>上传模型</label>
          <button id="mm_vrm_upload" class="menu_button"><i class="fa-solid fa-upload"></i> 选择 .vrm 文件</button>
          <span id="mm_vrm_filename" class="mm-inline-hint"></span>
        </div>
        <div class="mm-row" style="flex-wrap:wrap;gap:8px">
          <button id="mm_vrm_preview" class="menu_button"><i class="fa-solid fa-eye"></i> 预览模型</button>
          <button id="mm_vrm_stop_preview" class="menu_button" style="display:none"><i class="fa-solid fa-stop"></i> 停止预览</button>
        </div>
        <div id="mm_vrm_preview_wrap" style="display:none;margin-top:10px;width:100%;text-align:center">
          <canvas id="mm_vrm_preview_canvas" width="320" height="420" style="border-radius:12px;max-width:100%;display:inline-block"></canvas>
        </div>

        <div class="mm-section-title" style="margin-top:14px">画面设置</div>
        <div class="mm-row">
          <label>背景色</label>
          <select id="mm_vrm_bg" class="text_pole">
            <option value="transparent">透明（显示酒馆背景）</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>
        <div class="mm-row" style="align-items:center">
          <label>渲染质量</label>
          <input id="mm_vrm_dpr" type="range" min="0.5" max="3" step="0.5" style="flex:1;margin:0 8px">
          <span id="mm_vrm_dpr_val" class="mm-inline-hint" style="min-width:28px;text-align:right">1×</span>
        </div>
        <p class="mm-desc" style="margin-top:2px">手机建议 1×，PC 建议 1.5~2×。过高会导致手机内存不足自动刷新页面。</p>
      </div>

      <div class="mm-tab-panel" data-panel="favorites">
        <p class="mm-desc">${isTauriTavernHost() ? '设置、API Key、收藏、音频和上传模型随 TT 同步；请在 TT 中启用同步并包含设置与扩展存储。' : '收藏与音频保存在当前酒馆账号的文件中，其他设备登录同一酒馆账号即可访问，无需安装服务端插件。'} “备份导出”可另存含音频的副本。</p>
        <div class="mm-row mm-fav-toolbar"><input id="mm_favorites_search" class="text_pole" type="search" placeholder="搜索标题、文本、角色、音色、标签…" style="min-width:180px;flex:1"><button id="mm_favorites_refresh" class="menu_button">刷新收藏</button><span id="mm_favorites_count" class="mm-inline-hint">—</span><button id="mm_favorites_select_all" class="menu_button">全选 / 取消</button><button id="mm_favorites_play_selected" class="menu_button">连续播放</button><button id="mm_favorites_delete_selected" class="menu_button">删除选中</button><button id="mm_favorites_export" class="menu_button">备份导出</button><button id="mm_favorites_import_btn" class="menu_button">恢复备份</button><input id="mm_favorites_import_file" type="file" accept="application/json,.json" hidden></div>
        <div id="mm_favorites_list" class="mm-favorites-list"><p class="mm-desc">打开此标签页加载收藏。</p></div>
      </div>

    </div>
  </div>
`;
        document.getElementById('mm_settings_content').insertAdjacentHTML('beforeend', panelHtml);

        // ── Tab 切换 ──
        document.querySelectorAll('#mm-config-dialog .mm-tab').forEach(tab => {
            tab.addEventListener('click', function() {
                const t = this.dataset.tab;
                document.querySelectorAll('#mm-config-dialog .mm-tab').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('#mm-config-dialog .mm-tab-panel').forEach(p => p.classList.remove('active'));
                document.querySelector(`#mm-config-dialog .mm-tab-panel[data-panel="${t}"]`).classList.add('active');
                if (t === 'vc')     { renderVcBlocks(); }
                if (t === 'tts')    { renderVoiceLibrary(); refreshVoiceSelects(); renderBindings(); }
                if (t === 'format') { renderRules(); renderRegexPresets(); renderPreProcessRules(); }
                if (t === 'vrm')    { syncVrmFields(); }
                if (t === 'favorites') { renderFavorites(); }
            });
        });

        document.getElementById('mm_favorites_refresh')?.addEventListener('click', renderFavorites);
        document.getElementById('mm_favorites_search')?.addEventListener('input', function() { favoriteFilterText = this.value || ''; renderFavoriteCards(); });
        document.getElementById('mm_favorites_play_selected')?.addEventListener('click', () => { if (favoritePlaybackToken) { favoritePlaybackToken++; favoritePlaybackToken = 0; if (currentFavoriteAudio) { currentFavoriteAudio.pause(); currentFavoriteAudio.currentTime = 0; currentFavoriteAudioDone?.(); currentFavoriteAudio = null; currentFavoriteAudioDone = null; } toastr.info('已停止连续播放'); } else playSelectedFavorites(); });
        document.getElementById('mm_favorites_select_all')?.addEventListener('click', () => {
            const checks = [...document.querySelectorAll('#mm_favorites_list .mm-fav-check')];
            const shouldCheck = checks.some(x => !x.checked);
            checks.forEach(x => { x.checked = shouldCheck; });
        });
        document.getElementById('mm_favorites_delete_selected')?.addEventListener('click', async () => {
            const ids = [...document.querySelectorAll('#mm_favorites_list .mm-fav-card')]
                .filter(card => card.querySelector('.mm-fav-check')?.checked).map(card => card.dataset.favId);
            if (!ids.length) { toastr.info('请先勾选要删除的收藏'); return; }
            if (!confirm(`确定永久删除选中的 ${ids.length} 条收藏及音频文件？建议先备份。`)) return;
            try { const result = await favoriteRequest('/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
                toastr.success(`已删除 ${result.deleted} 条收藏`); await renderFavorites();
            } catch (err) { toastr.error(err.message); }
        });
        document.getElementById('mm_favorites_export')?.addEventListener('click', async () => {
            try { await exportFavorites(); toastr.success('收藏备份已导出'); } catch (err) { toastr.error('导出失败：' + err.message); }
        });
        document.getElementById('mm_favorites_import_btn')?.addEventListener('click', () => document.getElementById('mm_favorites_import_file')?.click());
        document.getElementById('mm_favorites_import_file')?.addEventListener('change', async function() {
            const file = this.files?.[0]; if (!file) return;
            if (!confirm('恢复备份会将备份中的收藏追加到当前收藏，不会覆盖现有内容。继续吗？')) { this.value = ''; return; }
            try { const count = await importFavorites(file); toastr.success(`成功恢复 ${count} 条收藏`); await renderFavorites(); }
            catch (err) { toastr.error('恢复失败：' + err.message); }
            finally { this.value = ''; }
        });
        document.getElementById('mm_favorites_list')?.addEventListener('click', async (e) => {
            const card = e.target.closest('.mm-fav-card'); if (!card) return;
            const id = card.dataset.favId;
            try {
                if (e.target.closest('.mm-fav-play')) {
                    const status = card.querySelector('.mm-fav-play-status');
                    if (status) status.textContent = '正在读取音频…';
                    const blob = await getFavoriteAudioBlob(id);
                    const url = URL.createObjectURL(blob);
                    const audio = new Audio(url);
                    audio.onended = () => { URL.revokeObjectURL(url); if (status) status.textContent = '播放完成'; };
                    audio.onerror = () => { URL.revokeObjectURL(url); if (status) status.textContent = '播放失败'; toastr.error('收藏音频播放失败'); };
                    try {
                        await audio.play();
                        if (status) status.textContent = '正在播放';
                    } catch (error) { URL.revokeObjectURL(url); if (status) status.textContent = '播放失败：' + error.message; throw error; }
                } else if (e.target.closest('.mm-fav-download')) {
                    const item = favoriteItemsCache.find(x => x.id === id);
                    const blob = await getFavoriteAudioBlob(id);
                    const ext = item?.format || 'mp3';
                    const safeTitle = String(item?.title || id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || id;
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `${safeTitle}.${ext}`;
                    document.body.appendChild(a); a.click(); a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 1500);
                } else if (e.target.closest('.mm-fav-edit')) {
                    const item = favoriteItemsCache.find(x => x.id === id); if (!item) return;
                    const title = prompt('收藏标题', item.title || ''); if (title === null) return;
                    const tagsText = prompt('标签（用逗号分隔，例如：日语,治愈,角色名）', (item.tags || []).join(', ')); if (tagsText === null) return;
                    const note = prompt('备注（可留空）', item.note || ''); if (note === null) return;
                    await favoriteRequest(`/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, tags: tagsText.split(/[,，]/).map(x => x.trim()).filter(Boolean), note }) });
                    toastr.success('收藏信息已更新'); await renderFavorites();
                } else if (e.target.closest('.mm-fav-delete')) {
                    if (!confirm('确定删除这条语音收藏？')) return;
                    await favoriteRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
                    card.remove(); favoriteItemsCache = favoriteItemsCache.filter(x => x.id !== id); renderFavoriteCards(); toastr.success('已删除收藏');
                }
            } catch (err) { toastr.error(err.message); }
        });

        // ── TTS 基础 ──
        const syncTts = () => {
            const voiceSel = document.getElementById('mm_voice_sel');
            s().apiKey  = document.getElementById('mm_key').value;
            s().groupId = document.getElementById('mm_gid').value;
            s().apiHost = document.getElementById('mm_apihost').value;
            s().model   = document.getElementById('mm_model').value;
            s().voiceId = voiceSel.value || document.getElementById('mm_voice').value;
            s().speed   = Number(document.getElementById('mm_speed').value);
            s().vol     = Number(document.getElementById('mm_vol').value);
            s().ttsLanguage = document.getElementById('mm_tts_lang').value;
            s().autoPlay = document.getElementById('mm_autoplay').checked;
            saveSettingsDebounced();
        };
        document.getElementById('mm_show_bubbles').addEventListener('change', function() {
            s().showBubbles = this.checked;
            saveSettingsDebounced();
            if (this.checked) refreshAllBubbles(); else removeAllBubbles();
        });
        ['mm_key','mm_gid','mm_apihost','mm_model','mm_voice_sel','mm_voice','mm_speed','mm_vol','mm_tts_lang','mm_autoplay'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener('input', syncTts);
            el.addEventListener('change', syncTts);
        });
        document.getElementById('mm_voice_sel').addEventListener('change', function() {
            document.getElementById('mm_voice').style.display = this.value ? 'none' : '';
        });
        const TEST_TEXTS = {
            '':   '你好，我是 MINIMAX TTS。',
            'zh': '你好，我是 MINIMAX TTS。',
            'en': 'Hello, I am MiniMax voice.',
            'ja': 'こんにちは、MiniMaxの音声です。',
            'ko': '안녕하세요, 저는 MiniMax 음성입니다.',
            'fr': 'Bonjour, je suis la voix MiniMax.',
            'de': 'Hallo, ich bin die MiniMax-Stimme.',
            'es': 'Hola, soy la voz MiniMax.',
            'pt': 'Olá, sou a voz MiniMax.',
            'id': 'Halo, saya adalah suara MiniMax.',
            'ar': 'مرحبًا، أنا صوت MiniMax.',
        };
        async function refreshAudioCacheStats() {
            const out = document.getElementById('mm_cache_stats'); if (!out) return;
            try {
                const d = await getAudioCacheStatsUnified();
                const modeLabel = d.mode === 'tauritavern' ? 'TT同步存储' : '酒馆文件缓存';
                out.textContent = `${modeLabel} ${d.files} 个 · ${(d.bytes/1048576).toFixed(2)} MB · 收藏独立保存`;
            } catch (e) { out.textContent = `缓存统计不可用：${e.message}`; }
        }
        document.getElementById('mm_run_diagnostics')?.addEventListener('click', async () => {
            const button = document.getElementById('mm_run_diagnostics');
            const output = document.getElementById('mm_diagnostics_result');
            if (!button || !output) return;
            button.disabled = true;
            output.textContent = '正在检查酒馆存储…';
            try {
                {
                    const probeKey = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`;
                    try {
                        await localStoreSetBlob('diagnostics', probeKey, new Blob(['minimax-storage-check']));
                        const probe = await localStoreGetBlob('diagnostics', probeKey);
                        if (!probe || await probe.text() !== 'minimax-storage-check') throw new Error('酒馆存储读写校验未通过');
                    } finally { await localStoreDeleteBlob('diagnostics', probeKey); }
                    const favs = await localStoreGetJson('favorites', 'index', []);
                    const favList = Array.isArray(favs) ? favs : [];
                    const favBytes = favList.reduce((sum, x) => sum + Number(x?.size || 0), 0);
                    const cacheStats = await getAudioCacheStatsUnified();
                    const hostLabel = isTauriTavernHost() ? 'TauriTavern 同步存储' : 'SillyTavern 内置文件接口';
                    const totalMB = ((favBytes + Number(cacheStats.bytes || 0)) / 1048576).toFixed(2);
                    output.textContent = `存储读写检查通过：${hostLabel} · 收藏 ${favList.length} 条 · 缓存 ${cacheStats.files} 条 · 总音频 ${totalMB} MB。尚未调用 MiniMax，请点击“测试语音”验证合成与播放。`;
                    toastr.success(`存储读写检查通过（${hostLabel}）`);
                }
            } catch (error) {
                output.textContent = `诊断失败：${error.message}`;
                toastr.error('插件诊断失败：' + error.message);
            } finally { button.disabled = false; }
        });

        let lastTestAudio = null;
        document.getElementById('mm_test_tts').addEventListener('click', async () => {
            const button = document.getElementById('mm_test_tts');
            const keyInput = document.getElementById('mm_test_key');
            const temporaryKey = keyInput.value.trim();
            keyInput.value = '';
            button.disabled = true;
            document.getElementById('mm_save_test').disabled = true;
            lastTestAudio = null;
            try {
                const lang = s().ttsLanguage || '';
                const text = TEST_TEXTS[lang] || TEST_TEXTS[''];
                const options = buildSynthesisOptions(null, null);
                const blob = await requestTtsAudioBlob({
                    text, apiKey: temporaryKey || s().apiKey, groupId: s().groupId,
                    apiHost: s().apiHost, model: options.model, voiceId: options.voiceId,
                    speed: options.speed, volume: options.vol, pitch: options.pitch,
                    format: options.audioFormat, emotion: options.emotion, language: options.language,
                });
                lastTestAudio = { blob, text, options };
                document.getElementById('mm_save_test').disabled = false;
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                const release = () => URL.revokeObjectURL(url);
                audio.onended = release;
                audio.onerror = release;
                try { await audio.play(); } catch (e) { release(); throw e; }
                document.getElementById('mm_diagnostics_result').textContent = `MiniMax 实时合成成功：${options.model} · ${blob.size} 字节 · 播放器已开始播放。`;
                toastr.success('语音已生成并开始播放');
            } catch(e) { toastr.error(e.message); }
            finally { button.disabled = false; }
        });
        document.getElementById('mm_save_test').addEventListener('click', async () => {
            if (!lastTestAudio) return;
            const button = document.getElementById('mm_save_test');
            const { blob, text, options } = lastTestAudio;
            button.disabled = true;
            try {
                await favoriteRequest('', { method: 'POST', body: {
                    title: 'MINIMAX TTS 测试语音', text,
                    audioBase64: await blobToBase64(blob), format: options.audioFormat,
                    voiceId: options.voiceId, model: options.model, tags: ['本机测试'],
                } });
                favoriteCacheLoaded = false;
                await ensureFavoriteCache(true);
                toastr.success('测试语音已保存到收藏，可重新加载后检查');
            } catch (error) { toastr.error('收藏失败：' + error.message); button.disabled = false; }
        });
        document.getElementById('mm_voice_search').addEventListener('input', renderVoiceLibrary);
        const voiceDetails = document.getElementById('mm_voice_lib_details');
        const voiceContent = document.getElementById('mm_voice_lib_content');
        voiceDetails?.addEventListener('toggle', () => { if (voiceContent) voiceContent.hidden = !voiceDetails.open; });
        document.getElementById('mm_add_voice').addEventListener('click', () => {
            if (voiceDetails && !voiceDetails.open) voiceDetails.open = true;
            if (voiceContent) voiceContent.hidden = false;
            if (!s().voiceLibrary) s().voiceLibrary = [];
            s().voiceLibrary.push({ name: '', voiceId: '' });
            renderVoiceLibrary(); saveSettingsDebounced();
        });

        // ── 角色绑定 ──
        document.getElementById('mm_add_b').addEventListener('click', () => {
            const c = getContext(), id = c.characterId || c.character_id || c.name2 || 'global';
            if (!s().characterBindingsMap[id]) s().characterBindingsMap[id] = [];
            s().characterBindingsMap[id].push({ targetType: TARGET_TYPE.CUSTOM, customName: '', voiceId: '', model: s().model });
            renderBindings(); saveSettingsDebounced();
        });

        // ── 文本规则 ──
        document.getElementById('mm_add_rule').addEventListener('click', () => {
            if (!s().regexRules) s().regexRules = [];
            s().regexRules.push({ id: 'rule-' + Date.now(), enabled: true, name: '新规则', pattern: '', flags: 'g', mode: 'extract' });
            renderRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_add_pre_rule').addEventListener('click', () => {
            if (!s().llmPreProcessRules) s().llmPreProcessRules = [];
            s().llmPreProcessRules.push({ id: 'pre-' + Date.now(), enabled: true, name: '新规则', pattern: '', mode: 'exclude' });
            renderPreProcessRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_regex_save_p').addEventListener('click', () => {
            const name = prompt('预设名称：'); if (!name) return;
            if (!s().regexPresets) s().regexPresets = [];
            s().regexPresets.push({ name, rules: JSON.parse(JSON.stringify(s().regexRules || [])) });
            renderRegexPresets(); saveSettingsDebounced(); toastr.success('预设已保存');
        });
        document.getElementById('mm_regex_upd_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_regex_presets').value);
            if (i < 0 || !s().regexPresets?.[i]) return;
            s().regexPresets[i].rules = JSON.parse(JSON.stringify(s().regexRules || []));
            saveSettingsDebounced(); toastr.success('预设已更新');
        });
        document.getElementById('mm_regex_presets').addEventListener('change', function() {
            const i = Number(this.value);
            if (i < 0 || !s().regexPresets?.[i]) return;
            s().regexRules = JSON.parse(JSON.stringify(s().regexPresets[i].rules));
            renderRules(); saveSettingsDebounced();
        });
        document.getElementById('mm_regex_del_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_regex_presets').value);
            if (i < 0 || !s().regexPresets?.[i]) return;
            s().regexPresets.splice(i, 1); renderRegexPresets(); saveSettingsDebounced();
        });
        document.getElementById('mm_regex_export').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().regexPresets || [], null, 2)], {type:'application/json'}));
            a.download = 'regex_presets.json'; a.click();
        });
        document.getElementById('mm_regex_import').addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) {
                        if (!s().regexPresets) s().regexPresets = [];
                        s().regexPresets.push(...data);
                        renderRegexPresets(); saveSettingsDebounced();
                        toastr.success(`已导入 ${data.length} 个预设`);
                    }
                } catch(e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });

        // ── 副LLM格式化 ──
        const syncFormatter = () => {
            s().formatterEnabled   = document.getElementById('mm_f_en').checked;
            s().formatterPresetIdx = Number(document.getElementById('mm_f_preset_sel').value);
            s().formatterSystemPrompt = document.getElementById('mm_f_prompt').value;
            saveSettingsDebounced();
        };
        const selFT = document.getElementById('mm_f_templates');
        const upFTemplates = () => {
            selFT.innerHTML = '<option value="-1">-- 新建模板 --</option>';
            (s().formatterTemplates || []).forEach((t, i) => {
                const o = document.createElement('option'); o.value = i; o.textContent = t.name; selFT.appendChild(o);
            });
        };
        document.getElementById('mm_auto_voice_casting').addEventListener('change', e => { s().autoVoiceCasting = e.target.checked; saveSettingsDebounced(); });
        document.getElementById('mm_auto_voice_max').addEventListener('change', e => { s().autoVoiceCastingMax = Math.max(1, Math.min(100, Number(e.target.value) || 20)); saveSettingsDebounced(); });
        document.getElementById('mm_emotion_director').addEventListener('change', e => { s().emotionDirectorEnabled = e.target.checked; saveSettingsDebounced(); });
        document.getElementById('mm_emotion_intensity').addEventListener('change', e => { s().emotionDirectorIntensity = e.target.value; saveSettingsDebounced(); });
        document.getElementById('mm_performance_mode').addEventListener('change', e => { s().performanceMode = e.target.value; saveSettingsDebounced(); });
        document.getElementById('mm_director_context').addEventListener('change', e => { s().directorContextCount = Math.max(0, Math.min(8, Number(e.target.value) || 0)); saveSettingsDebounced(); });
        document.getElementById('mm_director_cache').addEventListener('change', e => { s().directorCacheEnabled = e.target.checked; saveSettingsDebounced(); });
        document.getElementById('mm_retry_count').addEventListener('change', e => { s().retryCount = Math.max(0, Math.min(5, Number(e.target.value) || 0)); saveSettingsDebounced(); });
        document.getElementById('mm_segment_gap').addEventListener('change', e => { s().segmentGapMs = Math.max(0, Math.min(2500, Number(e.target.value) || 0)); saveSettingsDebounced(); });
        document.getElementById('mm_pronunciation_dict').addEventListener('change', e => { s().pronunciationDictionary = e.target.value; saveSettingsDebounced(); });
        document.getElementById('mm_cache_days').addEventListener('change', e => { s().audioCacheMaxAgeDays = Math.max(1, Math.min(365, Number(e.target.value) || 7)); saveSettingsDebounced(); refreshAudioCacheStats(); });
        document.getElementById('mm_cache_max_mb').addEventListener('change', e => { s().audioCacheMaxMB = Math.max(100, Math.min(20480, Number(e.target.value) || 1024)); saveSettingsDebounced(); refreshAudioCacheStats(); });
        document.getElementById('mm_cache_refresh').addEventListener('click', refreshAudioCacheStats);
        document.getElementById('mm_cache_cleanup').addEventListener('click', async () => {
            const out = document.getElementById('mm_cache_stats'); if (out) out.textContent = '正在清理…';
            try {
                const d = await cleanupAudioCacheUnified({ maxAgeDays: s().audioCacheMaxAgeDays ?? 7, maxMB: s().audioCacheMaxMB ?? 1024 });
                toastr.success(`已清理 ${d.deletedFiles} 个普通缓存，释放 ${(d.freedBytes/1048576).toFixed(2)} MB`);
                await refreshAudioCacheStats();
            } catch (err) { toastr.error(`缓存清理失败：${err.message}`); if (out) out.textContent = '清理失败：' + err.message; }
        });
        document.getElementById('mm_voice_personality').addEventListener('change', e => { const c=getContext(), id=String(c.characterId ?? c.character_id ?? c.name2 ?? 'global'); s().characterVoiceProfiles=s().characterVoiceProfiles||{}; s().characterVoiceProfiles[id]=e.target.value.slice(0,1200); saveSettingsDebounced(); });
        ['mm_f_en','mm_f_preset_sel','mm_f_prompt'].forEach(id => {
            document.getElementById(id).addEventListener('input', syncFormatter);
            document.getElementById(id).addEventListener('change', syncFormatter);
        });
        selFT.addEventListener('change', function() {
            const t = (s().formatterTemplates||[])[Number(this.value)];
            if (t) { document.getElementById('mm_f_prompt').value = t.content; syncFormatter(); }
        });
        document.getElementById('mm_f_save_t').addEventListener('click', () => {
            const n = prompt('模板名:'); if (!n) return;
            if (!s().formatterTemplates) s().formatterTemplates = [];
            s().formatterTemplates.push({ name: n, content: document.getElementById('mm_f_prompt').value });
            upFTemplates(); saveSettingsDebounced();
        });
        document.getElementById('mm_f_upd_t').addEventListener('click', () => {
            const i = Number(selFT.value); if (i >= 0) { (s().formatterTemplates||[])[i].content = document.getElementById('mm_f_prompt').value; toastr.success('更新成功'); saveSettingsDebounced(); }
        });
        document.getElementById('mm_f_del_t').addEventListener('click', () => {
            const i = Number(selFT.value); if (i >= 0) { (s().formatterTemplates||[]).splice(i, 1); upFTemplates(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_f_export_t').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().formatterTemplates || [], null, 2)], {type:'application/json'}));
            a.download = 'formatter_templates.json'; a.click();
        });
        document.getElementById('mm_f_import_t').addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) { if (!s().formatterTemplates) s().formatterTemplates = []; s().formatterTemplates.push(...data); upFTemplates(); saveSettingsDebounced(); toastr.success(`已导入 ${data.length} 个模板`); }
                } catch(e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });
        // ── LLM 预设 CRUD ──
        const loadLlmPresetFields = (i) => {
            const p = (s().llmPresets || [])[i]; if (!p) return;
            document.getElementById('mm_llm_url').value    = p.url    || '';
            document.getElementById('mm_llm_key').value    = p.key    || '';
            document.getElementById('mm_llm_format').value = p.format || API_FORMATS.OAI;
            document.getElementById('mm_llm_model').value  = p.model  || '';
            document.getElementById('mm_llm_model').style.display     = '';
            document.getElementById('mm_llm_model_sel').style.display = 'none';
        };
        document.getElementById('mm_llm_presets').addEventListener('change', function() { loadLlmPresetFields(Number(this.value)); });
        document.getElementById('mm_llm_save_p').addEventListener('click', () => {
            const n = prompt('预设名:'); if (!n) return;
            const modelSel = document.getElementById('mm_llm_model_sel');
            const model = modelSel.style.display !== 'none' ? modelSel.value : document.getElementById('mm_llm_model').value;
            s().llmPresets.push({ name: n, url: document.getElementById('mm_llm_url').value, key: document.getElementById('mm_llm_key').value, format: document.getElementById('mm_llm_format').value, model });
            const newIdx = s().llmPresets.length - 1;
            refreshAllLlmPresetSelects(); document.getElementById('mm_llm_presets').value = newIdx;
            saveSettingsDebounced(); toastr.success('预设已保存');
        });
        document.getElementById('mm_llm_upd_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_llm_presets').value);
            if (i < 0 || i >= s().llmPresets.length) return;
            const modelSel = document.getElementById('mm_llm_model_sel');
            const model = modelSel.style.display !== 'none' ? modelSel.value : document.getElementById('mm_llm_model').value;
            s().llmPresets[i] = { ...s().llmPresets[i], url: document.getElementById('mm_llm_url').value, key: document.getElementById('mm_llm_key').value, format: document.getElementById('mm_llm_format').value, model };
            refreshAllLlmPresetSelects(); document.getElementById('mm_llm_presets').value = i;
            saveSettingsDebounced(); toastr.success('预设已更新');
        });
        document.getElementById('mm_llm_del_p').addEventListener('click', () => {
            const i = Number(document.getElementById('mm_llm_presets').value);
            if (i < 0 || i >= s().llmPresets.length) return;
            s().llmPresets.splice(i, 1);
            if (s().formatterPresetIdx >= s().llmPresets.length) s().formatterPresetIdx = s().llmPresets.length - 1;
            if (s().vcLlmPresetIdx >= s().llmPresets.length) s().vcLlmPresetIdx = s().llmPresets.length - 1;
            refreshAllLlmPresetSelects();
            const newI = Number(document.getElementById('mm_llm_presets').value);
            if (newI >= 0) loadLlmPresetFields(newI);
            else {
                ['mm_llm_url','mm_llm_key','mm_llm_model'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('mm_llm_format').value = API_FORMATS.OAI;
                document.getElementById('mm_llm_model').style.display     = '';
                document.getElementById('mm_llm_model_sel').style.display = 'none';
            }
            saveSettingsDebounced();
        });
        document.getElementById('mm_llm_fetch').addEventListener('click', async () => {
            const url    = document.getElementById('mm_llm_url').value.trim().replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
            const key    = document.getElementById('mm_llm_key').value.trim();
            const format = document.getElementById('mm_llm_format').value;
            try {
                let m = [];
                if (format === API_FORMATS.OAI) { const d = await proxyFetch(`${url}/models`, { headers: key ? { 'Authorization': `Bearer ${key}` } : {} }); m = d.data?.map(it => typeof it === 'string' ? it : it.id) || []; }
                else { const d = await proxyFetch(`${url}/v1beta/models`, { headers: key ? { 'x-goog-api-key': key } : {} }); m = d.models?.map(it => it.name.replace('models/', '')) || []; }
                if (m.length) {
                    const sel = document.getElementById('mm_llm_model_sel');
                    sel.innerHTML = ''; sel.style.display = '';
                    document.getElementById('mm_llm_model').style.display = 'none';
                    m.forEach(it => { const o = document.createElement('option'); o.value = it; o.textContent = it; sel.appendChild(o); });
                    sel.value = m[0]; toastr.success('获取成功');
                }
            } catch(e) { toastr.error(e.message); }
        });
        document.getElementById('mm_llm_test_conn').addEventListener('click', async () => {
            const url    = document.getElementById('mm_llm_url').value.trim();
            const key    = document.getElementById('mm_llm_key').value.trim();
            const format = document.getElementById('mm_llm_format').value;
            const modelSel = document.getElementById('mm_llm_model_sel');
            const model = modelSel.style.display !== 'none' ? modelSel.value : document.getElementById('mm_llm_model').value;
            try {
                let d;
                if (format === API_FORMATS.OAI) {
                    d = await proxyFetch(normalizeOaiUrl(url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) }, body: { model, messages: [{ role: 'user', content: 'Say connected' }], temperature: 0.1 } });
                } else {
                    const gUrl = `${url.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`;
                    d = await proxyFetch(gUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) }, body: { contents: [{ role: 'user', parts: [{ text: 'Say connected' }] }] } });
                }
                if (d) toastr.success('API 连通成功！');
            } catch(e) { toastr.error(e.message); }
        });

        // ── 语音通话 ──
        const syncVc = () => {
            const enabled = document.getElementById('mm_vc_enabled').checked;
            s().vcEnabled      = enabled;
            s().vcLlmPresetIdx = Number(document.getElementById('mm_vc_llm_preset').value);
            s().vcInjectOnEnd  = document.getElementById('mm_vc_inject').checked;
            saveSettingsDebounced();
            // 控制悬浮球显示/隐藏
            const fab = document.getElementById('vc-fab');
            if (fab) fab.style.display = enabled ? '' : 'none';
        };
        ['mm_vc_enabled','mm_vc_llm_preset','mm_vc_inject'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener('input', syncVc);
            el.addEventListener('change', syncVc);
        });

        // ── 视频通话 (VRM) ──
        function syncVrmFields() {
            document.getElementById('mm_vrm_enabled').checked = !!s().vrmEnabled;
            let url = s().vrmModelUrl || '';
            // 修复旧版本可能存储的双斜杠路径（如 //user/files/model.vrm）
            if (url.startsWith('//')) { url = url.slice(1); s().vrmModelUrl = url; saveSettingsDebounced(); }
            // blob URL（旧版本）或服务器路径（新版本）均视为"已上传"，只显示文件名
            const isUpload = url.startsWith('mm-store:') || url.startsWith('blob:') || url.startsWith('/user/files/') || url.startsWith('user/files/');
            document.getElementById('mm_vrm_url').value = isUpload ? '' : url;
            document.getElementById('mm_vrm_filename').textContent = isUpload ? (s().vrmFilename || '（已上传）') : '';
            document.getElementById('mm_vrm_bg').value = s().vrmBg || 'transparent';
            const dpr = s().vrmPixelRatio ?? 1;
            const dprEl = document.getElementById('mm_vrm_dpr');
            if (dprEl) { dprEl.value = dpr; document.getElementById('mm_vrm_dpr_val').textContent = dpr + '×'; }
            refreshAllLlmPresetSelects();
            if (s().vrmLlmPresetIdx >= 0) document.getElementById('mm_vrm_llm_preset').value = s().vrmLlmPresetIdx;
        }
        document.getElementById('mm_vrm_enabled').addEventListener('change', function() {
            s().vrmEnabled = this.checked; saveSettingsDebounced();
            const vrmFab = document.getElementById('vrm-fab');
            if (vrmFab) vrmFab.style.display = this.checked ? '' : 'none';
        });
        document.getElementById('mm_vrm_llm_preset').addEventListener('change', function() {
            s().vrmLlmPresetIdx = Number(this.value); saveSettingsDebounced();
        });
        document.getElementById('mm_vrm_url').addEventListener('input', function() {
            s().vrmModelUrl = this.value.trim(); saveSettingsDebounced();
        });
        document.getElementById('mm_vrm_bg').addEventListener('change', function() {
            s().vrmBg = this.value; saveSettingsDebounced();
            applyVrmBg();
        });
        document.getElementById('mm_vrm_dpr').addEventListener('input', function() {
            const dpr = Number(this.value);
            s().vrmPixelRatio = dpr; saveSettingsDebounced();
            document.getElementById('mm_vrm_dpr_val').textContent = dpr + '×';
            if (vrmModule?.isReady()) vrmModule.setPixelRatio(dpr);
        });
        document.getElementById('mm_vrm_upload').addEventListener('click', () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.vrm';
            inp.onchange = async () => {
                const file = inp.files?.[0]; if (!file) return;
                const btn = document.getElementById('mm_vrm_upload');
                const origHtml = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 上传中...';
                btn.disabled = true;
                try {
                    const serverPath = await vrmServerUpload(file);
                    s().vrmModelUrl = serverPath;
                    s().vrmFilename = file.name;
                    saveSettingsDebounced();
                    document.getElementById('mm_vrm_url').value = '';
                    document.getElementById('mm_vrm_filename').textContent = file.name;
                    toastr.success('VRM 已保存，可随酒馆数据跨设备使用');
                    document.getElementById('mm_vrm_preview').click();
                } catch (e) {
                    toastr.error('VRM 上传失败: ' + e.message);
                } finally {
                    btn.innerHTML = origHtml;
                    btn.disabled = false;
                }
            };
            inp.click();
        });
        document.getElementById('mm_vrm_preview').addEventListener('click', async () => {
            const url = s().vrmModelUrl?.trim();
            if (!url) { toastr.warning('请先填写模型 URL 或上传 .vrm 文件'); return; }
            const wrap = document.getElementById('mm_vrm_preview_wrap');
            wrap.style.display = '';
            document.getElementById('mm_vrm_stop_preview').style.display = '';
            const canvas = document.getElementById('mm_vrm_preview_canvas');
            try {
                console.log('[VRM] 预览加载 URL:', url);
                if (!vrmModule) vrmModule = await import('./vrm.js');
                await vrmModule.init(canvas, s().vrmPixelRatio ?? 1);
                await loadConfiguredVrmModel(url);
                vrmModule.setState('idle');
                toastr.success('VRM 模型加载成功');
            } catch (e) {
                console.error('[VRM] 加载失败:', e, 'URL:', url);
                const hint = e.message?.includes('超时') ? '（请检查模型地址是否可访问，或完成酒馆同步后重试）' : '';
                toastr.error('VRM 加载失败: ' + e.message + hint, '', { timeOut: 8000 });
                wrap.style.display = 'none';
                document.getElementById('mm_vrm_stop_preview').style.display = 'none';
            }
        });
        document.getElementById('mm_vrm_stop_preview').addEventListener('click', () => {
            if (vrmModule) { try { vrmModule.destroy(); } catch (_) {} }
            document.getElementById('mm_vrm_preview_wrap').style.display = 'none';
            document.getElementById('mm_vrm_stop_preview').style.display = 'none';
        });

        // VC 提示词模板
        const vcTplSel = document.getElementById('mm_vc_templates');
        const upVcTemplates = () => {
            vcTplSel.innerHTML = '<option value="-1">-- 新建模板 --</option>';
            (s().vcPromptTemplates || []).forEach((t, i) => {
                const o = document.createElement('option'); o.value = i; o.textContent = t.name; vcTplSel.appendChild(o);
            });
        };
        vcTplSel.addEventListener('change', function() {
            const t = (s().vcPromptTemplates||[])[Number(this.value)];
            if (t) { s().vcPromptBlocks = JSON.parse(JSON.stringify(t.blocks)); if (t.systemPrompt !== undefined) s().vcSystemPrompt = t.systemPrompt; renderVcBlocks(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_vc_save_t').addEventListener('click', () => {
            const n = prompt('模板名:'); if (!n) return;
            if (!s().vcPromptTemplates) s().vcPromptTemplates = [];
            s().vcPromptTemplates.push({ name: n, blocks: JSON.parse(JSON.stringify(s().vcPromptBlocks||getDefaultVcBlocks())), systemPrompt: s().vcSystemPrompt||'' });
            upVcTemplates(); saveSettingsDebounced();
        });
        document.getElementById('mm_vc_upd_t').addEventListener('click', () => {
            const i = Number(vcTplSel.value); if (i >= 0) { const tpls = s().vcPromptTemplates||[]; tpls[i].blocks = JSON.parse(JSON.stringify(s().vcPromptBlocks||getDefaultVcBlocks())); tpls[i].systemPrompt = s().vcSystemPrompt||''; toastr.success('更新成功'); saveSettingsDebounced(); }
        });
        document.getElementById('mm_vc_del_t').addEventListener('click', () => {
            const i = Number(vcTplSel.value); if (i >= 0) { (s().vcPromptTemplates||[]).splice(i, 1); upVcTemplates(); saveSettingsDebounced(); }
        });
        document.getElementById('mm_vc_export_t').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(s().vcPromptTemplates || [], null, 2)], {type:'application/json'}));
            a.download = 'vc_prompt_templates.json'; a.click();
        });
        document.getElementById('mm_vc_import_t').addEventListener('click', () => {
            const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
            inp.onchange = async () => {
                try {
                    const data = JSON.parse(await inp.files[0].text());
                    if (Array.isArray(data)) { if (!s().vcPromptTemplates) s().vcPromptTemplates = []; s().vcPromptTemplates.push(...data); upVcTemplates(); saveSettingsDebounced(); toastr.success(`已导入 ${data.length} 个模板`); }
                } catch(e) { toastr.error('导入失败: ' + e.message); }
            };
            inp.click();
        });
        document.getElementById('mm_vc_ctx_count').addEventListener('input', function() {
            s().vcContextCount = Number(this.value) || 10; saveSettingsDebounced();
        });
        document.getElementById('mm_vc_add_block').addEventListener('click', () => {
            if (!s().vcPromptBlocks) s().vcPromptBlocks = getDefaultVcBlocks();
            s().vcPromptBlocks.push({ id: 'custom-' + Date.now(), enabled: true, label: '自定义块', editable: true, content: '', hint: '' });
            saveSettingsDebounced(); renderVcBlocks();
        });

        // ── Populate all fields ──
        const set = s();
        document.getElementById('mm_key').value     = set.apiKey  || '';
        document.getElementById('mm_gid').value     = set.groupId || '';
        document.getElementById('mm_apihost').value = set.apiHost || DEFAULT_API_HOST;
        document.getElementById('mm_model').value   = set.model   || 'speech-02-hd';
        document.getElementById('mm_speed').value   = set.speed   ?? 1;
        document.getElementById('mm_vol').value     = set.vol     ?? 1;
        document.getElementById('mm_tts_lang').value       = set.ttsLanguage || '';
        document.getElementById('mm_autoplay').checked    = set.autoPlay !== false;
        document.getElementById('mm_show_bubbles').checked = set.showBubbles || false;

        // Voice selector
        renderVoiceLibrary(); refreshVoiceSelects();
        const voiceSel   = document.getElementById('mm_voice_sel');
        const voiceInput = document.getElementById('mm_voice');
        const libMatch   = (set.voiceLibrary||[]).find(v => v.voiceId === set.voiceId);
        if (libMatch) { voiceSel.value = set.voiceId; voiceInput.style.display = 'none'; }
        else { voiceSel.value = ''; voiceInput.value = set.voiceId || ''; }

        document.getElementById('mm_f_en').checked       = set.formatterEnabled || false;
        document.getElementById('mm_emotion_director').checked = set.emotionDirectorEnabled !== false;
        document.getElementById('mm_auto_voice_casting').checked = set.autoVoiceCasting !== false;
        document.getElementById('mm_auto_voice_max').value = set.autoVoiceCastingMax ?? 20;
        document.getElementById('mm_emotion_intensity').value = set.emotionDirectorIntensity || 'balanced';
        document.getElementById('mm_performance_mode').value = set.performanceMode || 'hybrid';
        document.getElementById('mm_director_context').value = set.directorContextCount ?? 4;
        document.getElementById('mm_director_cache').checked = set.directorCacheEnabled !== false;
        document.getElementById('mm_retry_count').value = set.retryCount ?? 2;
        document.getElementById('mm_segment_gap').value = set.segmentGapMs ?? 180;
        document.getElementById('mm_pronunciation_dict').value = set.pronunciationDictionary || '';
        document.getElementById('mm_cache_days').value = set.audioCacheMaxAgeDays ?? 7;
        document.getElementById('mm_cache_max_mb').value = set.audioCacheMaxMB ?? 1024;
        refreshAudioCacheStats();
        { const c=getContext(), id=String(c.characterId ?? c.character_id ?? c.name2 ?? 'global'); document.getElementById('mm_voice_personality').value = set.characterVoiceProfiles?.[id] || ''; }
        document.getElementById('mm_f_prompt').value     = set.formatterSystemPrompt || '';
        upFTemplates();

        // 必须先 refresh（填充 option）再赋值，否则 select 为空时赋值无效
        refreshAllLlmPresetSelects();
        if ((s().llmPresets || []).length > 0) { document.getElementById('mm_llm_presets').value = 0; loadLlmPresetFields(0); }
        if (set.formatterPresetIdx >= 0) document.getElementById('mm_f_preset_sel').value = set.formatterPresetIdx;

        document.getElementById('mm_vc_enabled').checked = set.vcEnabled !== false;
        document.getElementById('mm_vc_inject').checked  = set.vcInjectOnEnd !== false;
        if (set.vcLlmPresetIdx >= 0) document.getElementById('mm_vc_llm_preset').value = set.vcLlmPresetIdx;
        document.getElementById('mm_vc_ctx_count').value = set.vcContextCount || 10;
        // VRM 初始值在切换到 vrm tab 时通过 syncVrmFields() 填充
        upVcTemplates();

        renderRules(); renderRegexPresets(); renderPreProcessRules();
        renderVcBlocks(); renderBindings();
    }
}

jQuery(async () => {
    await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
    loadSettings(); createUi();
    const migration = localFavoriteQueue.then(() => migrateLegacyStorage());
    localFavoriteQueue = migration.catch(() => {});
    await migration.catch(error => {
        console.warn('[MiniMax TTS] 旧数据迁移未完成：', error);
        toastr.warning('旧收藏迁移未完成，原数据已保留；重新加载可重试。' + error.message);
    });

    // --- 自动播放 + 气泡注入 ---
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        const ctx = getContext();
        if (ctx.chat?.[id]?.extra?.voice_call) return; // 跳过通话记录注入的消息
        if (s().enabled && s().autoPlay && !vcActive) {
            if (await generateMessageSpeech(id, false)) {
                playGeneratedMessage(id);
            }
        } else {
            // 无自动播放时，若启用了气泡则预提取段落（纯正则，不调用 API）
            extractSegmentsOnly(id);
        }
        injectBubbles(id); // 若该消息已有段落数据则注入气泡
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(refreshAllBubbles, 600); // 等待消息渲染完毕后批量注入
    });

    setInterval(refreshAllBubbles, 1000);

    // --- 收藏当前语音段 ---
    $(document).on('click', '.mm-bubble-fav', async function(e) {
        e.preventDefault(); e.stopPropagation();
        const button = this;
        const bubble = button.closest('.mm-bubble'); const item = bubbleItems.get(bubble);
        if (!item) return toastr.warning('找不到这段语音的数据');
        button.disabled = true;
        const oldText = button.textContent;
        button.textContent = '…';
        try {
            await ensureFavoriteCache();
            const match = favoriteMatchForBubble(item, Number(bubble.dataset.mesid));
            if (match?.id) {
                await favoriteRequest(`/${encodeURIComponent(match.id)}`, { method: 'DELETE' });
                favoriteItemsCache = favoriteItemsCache.filter(f => f.id !== match.id);
                updateBubbleFavoriteButton(bubble);
                toastr.info('已取消收藏');
            } else {
                const created = await saveFavorite(item, Number(bubble.dataset.mesid));
                if (created?.id) favoriteItemsCache.unshift(created);
                else { favoriteCacheLoaded = false; await ensureFavoriteCache(true); }
                updateBubbleFavoriteButton(bubble);
                toastr.success('已添加到语音收藏');
            }
        } catch (err) {
            button.textContent = oldText;
            toastr.error('收藏操作失败：' + err.message);
        } finally { button.disabled = false; }
    });

    // --- 气泡点击播放 ---
    $(document).on('click', '.mm-bubble', async function(e) {
        if ($(e.target).closest('.mm-bubble-fav').length) return;
        if ($(this).hasClass('mm-bubble-loading') || $(this).hasClass('mm-bubble-playing')) return;
        const mesid = Number($(this).data('mesid'));
        const segidx = Number($(this).data('segidx'));
        const { key } = getMessageData(mesid);
        const h = s().serverHistory[key];
        const item = h?.versions?.[h.activeIndex]?.items?.[segidx];
        if (!item) return;
        const $b = $(this);
        $b.addClass('mm-bubble-loading');
        try {
            const blob = await getAudioBlob(item);
            $b.removeClass('mm-bubble-loading').addClass('mm-bubble-playing');
            // 请求完成后立即刷新缓存状态。
            refreshBubbleStates(mesid);
            refreshSpeechPanelStatus();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.onended  = () => { URL.revokeObjectURL(url); $b.removeClass('mm-bubble-playing'); };
            audio.onerror  = () => { URL.revokeObjectURL(url); $b.removeClass('mm-bubble-playing'); };
            await audio.play();
        } catch(e) {
            $b.removeClass('mm-bubble-loading mm-bubble-playing');
            toastr.error('播放失败: ' + e.message);
        }
    });
});


// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        VOICE CALL MODULE                                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ── Settings defaults ─────────────────────────────────────────────────────────
const VC_DEFAULTS = {
    vcEnabled: true,
    sttLang: '',                // 留空则自动用浏览器语言（navigator.language）
    vcLlmPresetIdx: -1,         // 使用 llmPresets 中的哪个预设
    vcContextCount: 10,         // 注入多少条酒馆上下文
    vcSystemPrompt: '你现在正在与用户进行语音通话。请用自然的口语回答，不要使用任何 Markdown 格式、动作描述（*动作*）或表情符号，只说出可以直接朗读的话语。一次最多回复1-2句话！！',
    vcInjectOnEnd: true,        // 挂断后把通话记录注入聊天
};

// ── State ─────────────────────────────────────────────────────────────────────
let vcActive   = false;   // true when a call is in progress (suppresses regular auto-play)
let vcState    = 'idle';  // idle | connecting | listening | recording | processing | thinking | speaking
let callMode   = 'voice'; // 'voice' | 'video' — set before vcStartCall(), determines FAB + VRM

// 视频通话时把 vc-dialog 的 UI ID 重定向到 VRM HUD / info bar 里的对应元素
const VRM_HUD_MAP = { 'vc-status':'vrm-info-status', 'vc-log':'vrm-log', 'vc-name':'vrm-info-name', 'vc-timer':'vrm-info-timer', 'vc-mute':'vrm-mute', 'vc-canvas': null };
function vcEl(id) {
    if (callMode === 'video') {
        const mapped = VRM_HUD_MAP[id];
        if (mapped === null) return null;          // 无此元素（如波形画布）
        if (mapped !== undefined) return document.getElementById(mapped);
    }
    return document.getElementById(id);
}

let vcAudioCtx    = null;
let vcPlaybackCtx = null; // 专用于 TTS 播放的 AudioContext（iOS 解锁后可异步播放）
let vcStream      = null;
let vcAnalyser    = null;
let vcRafId       = null;
let vcMuted       = false;
let vcSpeakAudio  = null;
let vcTimerInterval = null;
let vcSpeechRec   = null;
let vcStartTime   = null;
let vcStreamBuffer  = '';    // 未凑成句子的文本碎片
let vcTtsPipeline   = [];    // Promise<Blob|null>[] 有序 TTS 队列
let vcTtsDraining   = false; // 是否正在消费队列
let vcGenDone       = true;  // LLM 生成是否已结束
let vcCallLog       = [];    // [{role, content, audioItems?}] 本次通话记录
let vcLlmAbortCtrl  = null;  // AbortController，用于中断流式 LLM
let vcCurrentResponseAudioItems = null; // 当前 AI 回复对应的 TTS 条目（用于挂断后存档）

// ── VRM ───────────────────────────────────────────────────────────────────────
let vrmModule      = null; // 动态 import('./vrm.js') 的模块对象
let vrmAnalyserNode = null; // AnalyserNode，接在 vcPlaybackCtx 上，驱动口型

function applyVrmBg() {
    const frame = document.getElementById('mm-vrm-frame');
    if (!frame) return;
    const bg = s().vrmBg || 'transparent';
    const map = { transparent: 'transparent', dark: '#09111f', light: '#f0eff5' };
    frame.style.background = map[bg] ?? 'transparent';
}

// ── Legacy VRM IndexedDB reader (new models use host-synchronized storage) ──────
const VRM_DB_NAME  = 'mm-vrm-db';
const VRM_DB_STORE = 'files';
const VRM_DB_KEY   = 'vrm-model';

function vrmOpenDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(VRM_DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(VRM_DB_STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function vrmDbLoad() {
    try {
        const db = await vrmOpenDb();
        const file = await new Promise((resolve, reject) => {
            const tx  = db.transaction(VRM_DB_STORE, 'readonly');
            const req = tx.objectStore(VRM_DB_STORE).get(VRM_DB_KEY);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
        db.close();
        return file || null;
    } catch (e) { console.warn('[VRM] IndexedDB load failed', e); return null; }
}

// Keep the stored reference portable; object URLs exist only while loading a model.
async function vrmServerUpload(file) {
    if (!file.size || file.size > 100 * 1024 * 1024) throw new Error('VRM 文件必须非空且不超过 100MB');
    await localStoreSetBlob('models', 'avatar.vrm', file, 'model/gltf-binary');
    return 'mm-store://models/avatar.vrm';
}

async function loadConfiguredVrmModel(url) {
    if (url !== 'mm-store://models/avatar.vrm') return vrmModule.loadModel(url);
    const blob = await localStoreGetBlob('models', 'avatar.vrm');
    if (!blob) throw new Error('模型文件尚未同步到本机，请完成酒馆同步后重试');
    const objectUrl = URL.createObjectURL(blob);
    try { return await vrmModule.loadModel(objectUrl); }
    finally { URL.revokeObjectURL(objectUrl); }
}

async function restoreVrmBlobUrl() {
    const stored = s().vrmModelUrl || '';
    if (!stored || !stored.startsWith('blob:')) return;
    const file = await vrmDbLoad();
    if (file) {
        try {
            const serverPath = await vrmServerUpload(file);
            s().vrmModelUrl  = serverPath;
            saveSettingsDebounced();
            console.info('[VRM] 已迁移至酒馆同步存储');
        } catch (error) {
            console.warn('[VRM] 模型迁移尚未完成：', error);
            toastr.warning('旧 VRM 模型迁移未完成，原文件已保留。' + error.message);
        }
    } else {
        // Never erase shared settings just because this device lacks a legacy browser file.
        console.warn('[VRM] 旧模型仍在原设备浏览器中；请在原设备更新扩展以完成迁移。');
    }
}

// ── Settings helpers ──────────────────────────────────────────────────────────
function vcLoadSettings() {
    const set = extension_settings[MODULE_NAME];
    for (const k in VC_DEFAULTS) {
        if (set[k] === undefined) set[k] = VC_DEFAULTS[k];
    }
}
function vc() { return extension_settings[MODULE_NAME]; }

// ── State machine ─────────────────────────────────────────────────────────────
function vcSetState(state) {
    vcState  = state;
    vcActive = state !== 'idle';

    const icons = {
        idle: 'fa-phone', connecting: 'fa-spinner fa-spin',
        listening: 'fa-microphone', recording: 'fa-circle',
        processing: 'fa-spinner fa-spin', thinking: 'fa-spinner fa-spin',
        speaking: 'fa-volume-high',
    };
    const labels = {
        idle: '', connecting: '正在接通...',
        listening: '聆听中', recording: '录音中...',
        processing: '识别中...', thinking: 'AI 思考中...',
        speaking: 'AI 说话中...',
    };

    const fab    = document.getElementById('vc-fab');
    const vrmFab = document.getElementById('vrm-fab');
    if (state === 'idle') {
        // 通话结束：两个 FAB 都恢复默认
        if (fab)    { fab.querySelector('i').className = 'fa-solid fa-phone';  fab.classList.remove('vc-fab-active'); fab.style.opacity = ''; fab.style.pointerEvents = ''; }
        if (vrmFab) { vrmFab.querySelector('i').className = 'fa-solid fa-video'; vrmFab.classList.remove('vc-fab-active'); vrmFab.style.opacity = ''; vrmFab.style.pointerEvents = ''; }
    } else if (callMode === 'voice') {
        if (fab)    { fab.querySelector('i').className = `fa-solid ${icons[state] || 'fa-phone'}`; fab.classList.add('vc-fab-active'); fab.style.opacity = ''; fab.style.pointerEvents = ''; }
        if (vrmFab) { vrmFab.style.opacity = '0.35'; vrmFab.style.pointerEvents = 'none'; }
    } else { // callMode === 'video'
        if (vrmFab) { vrmFab.querySelector('i').className = `fa-solid ${icons[state] || 'fa-video'}`; vrmFab.classList.add('vc-fab-active'); vrmFab.style.opacity = ''; vrmFab.style.pointerEvents = ''; }
        if (fab)    { fab.style.opacity = '0.35'; fab.style.pointerEvents = 'none'; }
    }
    const statusEl = vcEl('vc-status');
    if (statusEl) statusEl.textContent = (vcMuted && state === 'listening') ? '已静音' : (labels[state] ?? '');
    const dialog = document.getElementById('vc-dialog');
    if (dialog) dialog.dataset.state = state;

    // VRM 状态映射
    if (vrmModule?.isReady()) {
        const VRM_STATE_MAP = {
            idle: 'idle', connecting: 'idle',
            listening: 'listening', recording: 'listening',
            processing: 'thinking', thinking: 'thinking',
            speaking: 'speaking',
        };
        vrmModule.setState(VRM_STATE_MAP[state] || 'idle');
    }
}

// ── 句子提取 ──────────────────────────────────────────────────────────────────
function vcExtractSentences(text) {
    const complete = [];
    let lastIdx = 0;

    // 强终止符：遇到即成句，立即送 TTS
    const termRe = /[^。！？!?\n]*[。！？!?\n]+/g;
    let m;
    while ((m = termRe.exec(text)) !== null) {
        const s = m[0].replace(/\s+/g, ' ').trim();
        if (s.length >= 1) complete.push(s);
        lastIdx = termRe.lastIndex;
    }

    // 软分隔（逗号/顿号/分号）：找第一个「位置 >= MIN_BEFORE」的分隔符，在此截断。
    // ⚠️ 必须用 while 循环跳过靠前的出现，不能用 indexOf+filter：
    //   indexOf 返回【第一个】逗号的位置，若第一个在 index<3 被 filter 过滤后，
    //   index>=3 的第二个逗号就永远找不到，导致整条回复等到流结束才送 TTS。
    const MIN_BEFORE = 3; // 逗号前至少 3 个字符（避免 "好，" 这类极短片段）
    const rest = text.slice(lastIdx);
    const SOFT_SEPS = ['\u3001', '\uff0c', '\uff1b', ',', ';'];
    let bestSoftIdx = Infinity;
    for (const sep of SOFT_SEPS) {
        let idx = rest.indexOf(sep);
        while (idx !== -1 && idx < MIN_BEFORE) idx = rest.indexOf(sep, idx + 1);
        if (idx !== -1 && idx < bestSoftIdx) bestSoftIdx = idx;
    }
    if (bestSoftIdx !== Infinity) {
        const s = rest.slice(0, bestSoftIdx + 1).replace(/\s+/g, ' ').trim();
        if (s.length >= MIN_BEFORE) { complete.push(s); lastIdx += bestSoftIdx + 1; }
    }

    return { complete, rest: text.slice(lastIdx) };
}

// 获取当前通话使用的 TTS 参数（用于写入 serverHistory，供后续播放）
function vcGetTtsOptions() {
    const set = s(), ctx = getContext();
    const charId   = ctx.characterId ?? ctx.character_id ?? ctx.name2 ?? 'global';
    const bindings = set.characterBindingsMap?.[charId] || [];
    const charName = (ctx.name2 || '').toLowerCase();
    const binding  = bindings.find(b => {
        const n = (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 :
                   b.targetType === TARGET_TYPE.CURRENT_USER      ? ctx.name1 : b.customName)?.toLowerCase();
        return n === charName;
    });
    return {
        model:       binding?.model   || set.model,
        voiceId:     binding?.voiceId || set.voiceId,
        speed:       Number(set.speed),
        vol:         Number(set.vol),
        pitch:       Number(set.pitch),
        audioFormat: 'mp3',
        emotion:     set.emotion || '',
    };
}

// ── TTS 流水线（并行合成，顺序播放）──────────────────────────────────────────
function vcEnqueueTts(text) {
    if (!text || !vcActive) return;
    // 立刻开始合成（不阻塞），把 Promise<Blob|null> 压入队列
    const p = vcTtsSpeak(text).catch(() => null);
    vcTtsPipeline.push(p);
    // 同时记录到当前回复的音频存档（同一个 Promise，不额外消耗 API）
    if (vcCurrentResponseAudioItems !== null) {
        vcCurrentResponseAudioItems.push({ text, options: vcGetTtsOptions(), blob: p });
    }
    if (!vcTtsDraining) vcDrainTtsPipeline();
}

async function vcDrainTtsPipeline() {
    if (vcTtsDraining) return;
    vcTtsDraining = true;
    let drainIdx = 0;
    while (vcTtsPipeline.length > 0) {
        drainIdx++;
        const t1 = Date.now();
        console.log(`[VC drain] 等待第 ${drainIdx} 段 TTS blob…`);
        const blob = await vcTtsPipeline.shift(); // 等第一个合成完成
        console.log(`[VC drain] 第 ${drainIdx} 段 TTS 完成, 耗时 ${Date.now()-t1}ms, blob=${blob?.size}bytes`);
        if (!vcActive) break;
        if (!blob) { console.warn(`[VC drain] 第 ${drainIdx} 段 TTS 返回 null，跳过`); continue; }
        if (vcState === 'thinking') vcSetState('speaking');
        console.log(`[VC drain] 第 ${drainIdx} 段开始播放`);
        // iOS Safari 要求 play() 必须在用户手势上下文中调用。
        // 异步链（LLM 流式 + TTS 合成）完成后已离开手势上下文，new Audio().play() 会被静默拒绝。
        // 改用 AudioContext（在用户点击通话按钮时创建，保持解锁状态），可在任意时刻播放音频。
        if (vcPlaybackCtx) {
            try {
                const arrayBuffer = await blob.arrayBuffer();
                const audioBuffer = await vcPlaybackCtx.decodeAudioData(arrayBuffer);
                const source = vcPlaybackCtx.createBufferSource();
                source.buffer = audioBuffer;
                if (vrmAnalyserNode) {
                    source.connect(vrmAnalyserNode);
                    vrmAnalyserNode.connect(vcPlaybackCtx.destination);
                } else {
                    source.connect(vcPlaybackCtx.destination);
                }
                vcSpeakAudio = source;
                await new Promise(resolve => {
                    source.onended = () => { vcSpeakAudio = null; resolve(); };
                    source.start();
                });
            } catch (e) {
                vcSpeakAudio = null;
            }
        } else {
            // 回退：非 iOS 环境或 AudioContext 不可用时，使用传统方式
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            vcSpeakAudio = audio;
            await new Promise(resolve => {
                audio.onended = () => { URL.revokeObjectURL(url); vcSpeakAudio = null; resolve(); };
                audio.onerror = () => { URL.revokeObjectURL(url); vcSpeakAudio = null; resolve(); };
                audio.play().catch(resolve);
            });
        }
        if (!vcActive) break;
    }
    vcTtsDraining = false;
    // 队列清空且生成已结束 → 恢复聆听
    if (vcActive && vcGenDone && vcTtsPipeline.length === 0) {
        vcSetState('listening');
        vcResumeListening();
    }
}

// ── 独立 LLM 流式调用 ─────────────────────────────────────────────────────────
async function vcBuildLlmMessages(userText) {
    const set = vc(), ctx = getContext();
    const msgs = [];
    const blocks = (set.vcPromptBlocks || getDefaultVcBlocks()).filter(b => b.enabled);

    for (const block of blocks) {
        if (block.id === 'charDesc') {
            const desc = ctx.characters?.[ctx.characterId]?.description || '';
            if (desc) msgs.push({ role: 'system', content: desc });
        } else if (block.id === 'worldBook') {
            const selectedKeys = block.selectedEntries;
            if (selectedKeys?.length) {
                // 按用户勾选的条目直接加载内容
                const allEntries = await loadAllWbEntries();
                const filtered = allEntries.filter(e => selectedKeys.includes(e.key));
                const content = filtered.map(e => e.content).join('\n\n').trim();
                if (content) msgs.push({ role: 'system', content });
            } else {
                // 未指定条目时回退到酒馆注入的合并字符串
                const wi = [ctx.worldInfoBefore, ctx.worldInfoAfter].filter(Boolean).join('\n\n').trim();
                if (wi) msgs.push({ role: 'system', content: wi });
            }
        } else if (block.id === 'vcSystem') {
            if (set.vcSystemPrompt) msgs.push({ role: 'system', content: set.vcSystemPrompt });
        } else if (block.id === 'vrmActions') {
            msgs.push({ role: 'system', content: `【表情动作标签】回复中可用以下标签自然表达情绪和动作，系统会自动处理，请勿读出标签文字：\n表情：[e:happy]开心 [e:sad]悲伤 [e:angry]愤怒 [e:surprised]惊讶 [e:relaxed]放松\n动作：[a:nod]点头 [a:shake]摇头 [a:wave]招手 [a:tilt]歪头\n示例："你来了！[e:happy][a:wave] 好久不见。"` });
        } else if (block.id === 'context') {
            const n = Math.max(0, Number(set.vcContextCount) || 10);
            const recent = (ctx.chat || []).filter(m => !m.is_system).slice(-n);
            for (const m of recent) msgs.push({ role: m.is_user ? 'user' : 'assistant', content: applyPreProcessRules(m.mes) });
        } else if (block.editable && block.content) {
            msgs.push({ role: 'system', content: block.content });
        }
    }

    msgs.push(...vcCallLog);
    msgs.push({ role: 'user', content: userText });
    return msgs;
}

// ── VRM 标签解析 ───────────────────────────────────────────────────────────────
// 标签格式：[e:name] 表情  [a:name] 动作
// 只在 callMode=video 且 vrmModule 就绪时派发；始终从文本中剥离标签
const VRM_TAG_RE = /\[(e|a):(\w+)\]/g;
function stripAndDispatchVrmTags(text) {
    let dispatched = 0;
    const stripped = text.replace(VRM_TAG_RE, (_, type, name) => {
        if (callMode === 'video' && vrmModule?.isReady()) {
            if (type === 'e') vrmModule.setEmotion(name);
            else if (type === 'a') vrmModule.playAction(name);
            dispatched++;
        }
        return '';
    });
    return { stripped, dispatched };
}

async function vcStreamingLlm(userText) {
    const presetIdx = (callMode === 'video' && s().vrmLlmPresetIdx >= 0) ? s().vrmLlmPresetIdx : s().vcLlmPresetIdx;
    const preset = (s().llmPresets || [])[presetIdx];
    if (!preset || !preset.url || !preset.model) { toastr.error('请先在设置里选择 LLM 预设'); vcSetState('listening'); vcResumeListening(); return; }
    const url   = normalizeOaiUrl(preset.url);
    const key   = (preset.key || '').trim();
    const model = (preset.model || '').trim();

    vcGenDone = false;
    vcTtsPipeline.length = 0;
    vcStreamBuffer = '';
    vcCurrentResponseAudioItems = []; // 开始收集本轮回复的 TTS 条目

    // ── 诊断日志（排查流式是否生效，可在控制台观察） ──────────────────────────
    const t0 = Date.now();
    let chunkCount = 0, ttsCount = 0;
    const vcLog_ = (tag, msg) => console.log(`[VC ${tag} +${Date.now()-t0}ms]`, msg);
    vcLog_('LLM', `request → ${model}`);

    try {
        vcLlmAbortCtrl = new AbortController();
        const res = await fetchLlmResponse(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { 'Authorization': `Bearer ${key}` } : {}) },
            body: JSON.stringify({ model, messages: await vcBuildLlmMessages(userText), stream: true }),
            signal: vcLlmAbortCtrl.signal,
        }, { native: !isTauriTavernHost(), getHeaders: getRequestHeaders });
        if (!res.ok) throw new Error(`LLM API HTTP ${res.status}`);
        vcLog_('LLM', `response headers received (status ${res.status})`);

        // 解析 SSE 流
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let sseBuf = '', fullText = '';
        let vrmTagCount = 0; // 本轮派发的 VRM 标签数量

        // 流式更新通话记录：第一个 token 到达时创建元素，后续逐字追加
        const logContainer = vcEl('vc-log');
        let liveLogEl = null;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done || !vcActive) break;
                chunkCount++;
                sseBuf += dec.decode(value, { stream: true });
                const lines = sseBuf.split('\n');
                sseBuf = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const raw = line.slice(6).trim();
                    if (raw === '[DONE]') break;
                    try {
                        const delta = JSON.parse(raw).choices?.[0]?.delta?.content || '';
                        if (!delta) continue;
                        fullText += delta;
                        vcStreamBuffer += delta;

                        // 剥离 VRM 标签（同时派发给 VRM 模块）
                        const { stripped, dispatched } = stripAndDispatchVrmTags(vcStreamBuffer);
                        vcStreamBuffer = stripped;
                        vrmTagCount += dispatched;

                        // 逐字更新 vcLog（让用户看到字在流式出现，而不是等全文才显示）
                        if (logContainer) {
                            if (!liveLogEl) {
                                liveLogEl = document.createElement('div');
                                liveLogEl.className = 'vc-log-line vc-log-ai';
                                liveLogEl.textContent = 'TA: ';
                                logContainer.appendChild(liveLogEl);
                            }
                            liveLogEl.textContent = 'TA: ' + fullText.replace(/\*[^*]*\*/g, '').replace(VRM_TAG_RE, '').replace(/\n+/g, ' ');
                            logContainer.scrollTop = logContainer.scrollHeight;
                        }

                        const { complete, rest } = vcExtractSentences(vcStreamBuffer);
                        vcStreamBuffer = rest;
                        if (complete.length) {
                            complete.forEach(seg => {
                                ttsCount++;
                                vcLog_('TTS-enqueue', `#${ttsCount} "${seg.slice(0,20)}…" (buf剩余:"${rest.slice(0,10)}")`);
                                vcEnqueueTts(seg);
                            });
                        }
                    } catch (_) {}
                }
            }
        } finally { reader.releaseLock(); }

        vcLog_('LLM', `stream done — 共 ${chunkCount} 个网络块, ${ttsCount} 段已送TTS, 剩余buffer: "${vcStreamBuffer.slice(0,30)}"`);

        // 冲刷尾巴
        const tail = vcStreamBuffer.trim();
        vcStreamBuffer = '';
        if (tail.length >= 2) {
            ttsCount++;
            vcLog_('TTS-enqueue', `#${ttsCount} tail: "${tail.slice(0,20)}"`);
            vcEnqueueTts(tail);
        }

        // 记录到通话日志（liveLogEl 已经显示了流式文字，这里只更新数据）
        if (vcActive && fullText) {
            // 无标签时才做整体关键词情感分析（有标签则已精准派发过）
            if (vrmModule?.isReady() && vrmTagCount === 0) vrmModule.setEmotionFromText(fullText);
            vcCallLog.push({ role: 'user', content: userText });
            // audioItems 携带本轮所有 TTS 条目（含 blob promise），挂断时用于存档
            vcCallLog.push({ role: 'assistant', content: fullText, audioItems: vcCurrentResponseAudioItems || [] });
            vcCurrentResponseAudioItems = null;
            // 若 liveLogEl 不存在（极短回复走 tail）则补一条静态日志
            if (!liveLogEl) vcLog('ai', fullText.replace(/\*[^*]*\*/g, '').replace(/\n+/g, ' ').trim());
        }
    } catch (e) {
        if (e.name !== 'AbortError') { console.error('[VC LLM]', e); toastr.error('LLM 错误: ' + e.message); }
    }

    vcGenDone = true;
    if (!vcTtsDraining && vcTtsPipeline.length === 0 && vcActive) {
        vcSetState('listening');
        vcResumeListening();
    }
}

// ── 挂断后注入通话记录 ────────────────────────────────────────────────────────
async function vcInjectCallRecord(callLog) {
    if (!callLog.length) return;
    const ctx = getContext();
    if (!ctx.chat) return;
    const n1 = ctx.name1 || '你', n2 = ctx.name2 || 'AI';

    const lines = callLog.map(m => `${m.role === 'user' ? n1 : n2}：${m.content}`);
    const transcript = `【语音通话记录】\n${lines.join('\n')}`;

    const newMsg = {
        name: n2, is_user: false, is_system: false,
        send_date: new Date().toLocaleString(),
        mes: transcript, extra: { voice_call: true },
    };
    ctx.chat.push(newMsg);
    const newId = ctx.chat.length - 1;
    addOneMessage(newMsg, { scroll: true, forceId: newId });
    saveChatDebounced();
    toastr.success(`通话记录已注入（${callLog.length / 2 | 0} 轮对话）`);

    // ── 收集通话中所有 AI 回复的 TTS 音频，存入 serverHistory ─────────────────
    const assistantTurns = callLog.filter(m => m.role === 'assistant' && m.audioItems?.length);
    if (!assistantTurns.length) return;

    // Blob 在通话中已并行合成完毕，这里只是等待 Promise 兑现（几乎即时）
    // 设 5s 超时以防万一用户挂断时仍有请求在途
    const TIMEOUT = 5000;
    const VC_TURN_PAUSE_MS = 700; // 两轮回话之间的停顿时长
    const items = [];
    for (let t = 0; t < assistantTurns.length; t++) {
        // 第二轮起，先插入停顿标记（playNext 遇到 pauseMs 会 sleep 后继续）
        if (t > 0) items.push({ pauseMs: VC_TURN_PAUSE_MS });

        for (const { text, options, blob: blobP } of assistantTurns[t].audioItems) {
            const blob = await Promise.race([blobP, new Promise(r => setTimeout(() => r(null), TIMEOUT))]);
            if (!blob) continue;

            // 用与常规 TTS 相同的 cacheKey，若之后相同文本+参数再次生成可复用服务端文件
            const cacheKey = `tts_${simpleHash(text)}_${simpleHash(JSON.stringify(options))}`;
            const serverPath = await uploadToSTServer(blob, `${cacheKey}.mp3`);

            items.push({ text, speaker: n2, options, serverPath: serverPath || null });
        }
    }
    if (!items.length) return;

    // 写入 serverHistory，key 对应刚刚注入的那条消息
    const { key } = getMessageData(newId);
    if (!s().serverHistory[key]) s().serverHistory[key] = { activeIndex: 0, versions: [] };
    s().serverHistory[key].versions.push({ items, timestamp: Date.now() });
    s().serverHistory[key].activeIndex = s().serverHistory[key].versions.length - 1;
    saveSettingsDebounced();

    refreshSpeechPanelStatus();
    // 注入气泡：serverPath 已写入，气泡将直接显示为绿色（已缓存）
    if (s().showBubbles) injectBubbles(newId);
}

// ── TTS (直接复用现有 MiniMax 端点) ──────────────────────────────────────────
async function vcTtsSpeak(text) {
    const set = s();
    const ctx = getContext();
    const charId  = ctx.characterId ?? ctx.character_id ?? ctx.name2 ?? 'global';
    const bindings = set.characterBindingsMap?.[charId] || [];
    const charName = (ctx.name2 || '').toLowerCase();
    const binding  = bindings.find(b => {
        const n = (b.targetType === TARGET_TYPE.CURRENT_CHARACTER ? ctx.name2 :
                   b.targetType === TARGET_TYPE.CURRENT_USER      ? ctx.name1 : b.customName)?.toLowerCase();
        return n === charName;
    });
    return await requestTtsAudioBlob({
        text: applyPronunciationDictionary(text),
        apiKey: set.apiKey,
        groupId: set.groupId,
        apiHost:  set.apiHost,
        model:    binding?.model   || set.model,
        voiceId:  binding?.voiceId || set.voiceId,
        speed:    Number(set.speed),
        volume:   Number(set.vol),
        pitch:    Number(set.pitch),
        format:   'mp3',
        emotion:  set.emotion || '',
        language: set.ttsLanguage || undefined,
    });
}


// ── 对话记录 ──────────────────────────────────────────────────────────────────
function vcLog(speaker, text) {
    const log = vcEl('vc-log');
    if (!log) return;
    const el = document.createElement('div');
    el.className = `vc-log-line vc-log-${speaker}`;
    el.textContent = (speaker === 'user' ? '你: ' : 'TA: ') + text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
}


function vcResumeListening() {
    if (vcState !== 'listening' || vcMuted) return;
    vcStartWebSpeech();
}

// ── STT: 浏览器内置 Web Speech API ───────────────────────────────────────────
function vcStartWebSpeech() {
    if (vcState !== 'listening' || vcMuted) return;
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        toastr.error('当前浏览器不支持语音识别，请用 Chrome 或 Edge');
        vcEndCall();
        return;
    }

    vcSpeechRec = new SpeechRec();
    // lang：优先用设置里的语言，否则用浏览器语言（通常已含地区如 zh-CN）
    vcSpeechRec.lang           = vc().sttLang || navigator.language || 'zh-CN';
    vcSpeechRec.continuous     = false;
    vcSpeechRec.interimResults = true;   // 开启实时识别，边说边显示
    vcSpeechRec.maxAlternatives = 1;

    // vcLog 里的实时文字元素（interim 时透明度低，final 后正常）
    const logEl = vcEl('vc-log');
    let liveEl = null;

    const removeLive = () => {
        if (liveEl && !liveEl.textContent.replace('你: ', '').trim()) liveEl.remove();
        liveEl = null;
    };

    vcSpeechRec.onresult = async (e) => {
        // 拼接本次事件所有结果
        let interim = '', final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) final += t;
            else interim += t;
        }

        // 实时更新显示（interim 用淡色斜体，final 后变正常）
        const display = final || interim;
        if (display && logEl) {
            if (!liveEl) {
                liveEl = document.createElement('div');
                liveEl.className = 'vc-log-line vc-log-user vc-log-interim';
                logEl.appendChild(liveEl);
            }
            liveEl.textContent = '你: ' + display;
            liveEl.classList.toggle('vc-log-interim', !final);
            logEl.scrollTop = logEl.scrollHeight;
        }

        if (!final) return; // 还是 interim，继续等

        const text = final.trim();
        if (!text) { removeLive(); if (vcState === 'listening') vcStartWebSpeech(); return; }

        // 识别完成：定稿 log 元素，转入 LLM
        liveEl = null; // 已定稿，不再移除
        vcSetState('thinking');
        await vcStreamingLlm(text);
    };

    vcSpeechRec.onend = () => {
        removeLive();
        if (vcState === 'listening' && !vcMuted) vcStartWebSpeech();
    };

    vcSpeechRec.onerror = (e) => {
        removeLive();
        // aborted/no-speech/audio-capture 是正常中断，静默重启
        if (['aborted', 'no-speech', 'audio-capture'].includes(e.error)) {
            if (vcState === 'listening' && !vcMuted) vcStartWebSpeech();
        } else {
            console.warn('[VC STT] error:', e.error);
        }
    };

    vcSpeechRec.start();
}

// ── 波形可视化 ────────────────────────────────────────────────────────────────
function vcStartWaveform() {
    const loop = () => {
        if (!vcActive) return;
        const canvas = vcEl('vc-canvas');
        if (!canvas) { requestAnimationFrame(loop); return; }
        const ctx2d = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx2d.clearRect(0, 0, W, H);

        if (vcAnalyser && (vcState === 'listening' || vcState === 'recording')) {
            // 实时麦克风频谱
            const buf  = new Uint8Array(vcAnalyser.frequencyBinCount);
            vcAnalyser.getByteFrequencyData(buf);
            const n = 32, step = Math.floor(buf.length / n), barW = W / n - 2;
            for (let i = 0; i < n; i++) {
                const v = buf[i * step] / 255;
                const h = Math.max(3, v * H * 0.85);
                ctx2d.fillStyle = vcState === 'recording'
                    ? `rgba(255,90,90,${0.45 + v * 0.55})`
                    : `rgba(70,195,130,${0.35 + v * 0.65})`;
                ctx2d.fillRect(i * (barW + 2), (H - h) / 2, barW, h);
            }
        } else {
            // 状态动画（正弦波）
            const t   = Date.now() / 1000;
            const amp = vcState === 'thinking' || vcState === 'processing'
                ? 4 + Math.sin(t * 7) * 3
                : vcState === 'speaking' ? 7 + Math.sin(t * 4) * 4 : 6;
            const rgb = vcState === 'speaking'           ? '110,150,255'
                      : vcState === 'thinking' || vcState === 'processing' ? '255,175,70'
                      : '70,195,130';
            ctx2d.strokeStyle = `rgba(${rgb},0.75)`;
            ctx2d.lineWidth   = 2;
            ctx2d.beginPath();
            for (let x = 0; x <= W; x++) {
                const y = H / 2 + Math.sin((x / W * 5 + t * 2) * Math.PI) * amp;
                x === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
            }
            ctx2d.stroke();
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

// ── 通话生命周期 ──────────────────────────────────────────────────────────────
async function vcStartCall() {
    vcLoadSettings();
    if (callMode === 'voice' && !vc().vcEnabled) return;
    if (callMode === 'video' && !s().vrmEnabled)  return;

    // 在用户手势的同步调用栈中创建 AudioContext，使其处于"解锁"状态。
    // iOS Safari 要求 AudioContext 必须由用户手势创建，之后才能在异步代码中播放音频。
    if (vcPlaybackCtx) { try { vcPlaybackCtx.close(); } catch (_) {} }
    vcPlaybackCtx = new (window.AudioContext || window.webkitAudioContext)();

    // VRM：视频通话时（callMode === 'video'）始终启动，语音通话时不启动
    vrmAnalyserNode = null;
    if (callMode === 'video') {
        try {
            vrmAnalyserNode = vcPlaybackCtx.createAnalyser();
            vrmAnalyserNode.fftSize = 256;
        } catch (_) {}
        // 展开 VN 式布局：上方 60vh 给 VRM，下方 40vh 给聊天
        document.documentElement.classList.add('mm-vc-active');
        applyVrmBg();
        // 异步加载 VRM 模块并初始化画布（不阻塞通话启动）
        (async () => {
            try {
                if (!vrmModule) vrmModule = await import('./vrm.js');
                const canvas = document.getElementById('vc-vrm-canvas');
                const frame  = document.getElementById('mm-vrm-frame');
                console.log('[VRM] frame:', frame?.clientWidth, 'x', frame?.clientHeight,
                    'display:', frame ? getComputedStyle(frame).display : 'N/A',
                    '| canvas:', canvas?.clientWidth, 'x', canvas?.clientHeight,
                    '| modelUrl:', s().vrmModelUrl);
                if (canvas) {
                    await vrmModule.init(canvas, s().vrmPixelRatio ?? 1);
                    const modelUrl = s().vrmModelUrl?.trim();
                    if (modelUrl) {
                        await loadConfiguredVrmModel(modelUrl);
                    } else {
                        toastr.warning(
                            '尚未配置 VRM 模型。请在「视频通话」中上传模型，或完成酒馆同步后重试。',
                            'VRM 未加载', { timeOut: 10000 }
                        );
                        console.warn('[VRM] 尚未配置或同步模型文件。');
                    }
                    if (vrmAnalyserNode) vrmModule.setAnalyser(vrmAnalyserNode);
                    vrmModule.resize(canvas);
                    vrmModule.setState('listening');
                }
            } catch (e) {
                console.warn('[VRM] 初始化失败', e);
                const hint = e.message?.includes('超时') ? '\n请检查模型地址是否可访问，或完成酒馆同步后重试' : '';
                toastr.warning('VRM 加载失败，将以普通语音模式继续：' + e.message + hint, '', { timeOut: 6000 });
            }
        })();
    }

    // 停止当前正在播放的普通 TTS
    activeAudio.pause();
    activeAudio.src = '';
    playbackQueue.length = 0;

    vcSetState('connecting');

    // 更新角色信息（dialog 或 VRM HUD）
    const ctx = getContext();
    const nameEl = vcEl('vc-name');
    if (nameEl) nameEl.textContent = ctx.name2 || 'AI';
    if (callMode === 'voice') {
        const avatarEl = document.getElementById('vc-avatar');
        const phEl     = document.getElementById('vc-avatar-placeholder');
        const charAvatar = ctx.characters?.[ctx.characterId]?.avatar;
        if (avatarEl) { avatarEl.src = charAvatar ? `/characters/${charAvatar}` : ''; avatarEl.style.display = charAvatar ? '' : 'none'; }
        if (phEl)     phEl.style.display = charAvatar ? 'none' : '';
        document.getElementById('vc-dialog').classList.add('vc-dialog-open');
    }

    // 计时器
    vcStartTime = Date.now();
    const timerEl = vcEl('vc-timer');
    vcTimerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - vcStartTime) / 1000);
        if (timerEl) timerEl.textContent = `${String(Math.floor(sec / 60)).padStart(2,'0')}:${String(sec % 60).padStart(2,'0')}`;
    }, 1000);

    vcStartWaveform();

    // iOS Safari 要求 SpeechRecognition.start() 必须在用户手势的同步调用栈中触发，
    // 因此先同步启动识别，再异步获取麦克风流（仅用于波形显示，不影响识别）
    vcSetState('listening');
    vcStartWebSpeech();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (!vcActive) { stream.getTracks().forEach(t => t.stop()); return; }
        vcStream = stream;
        vcAudioCtx = new AudioContext();
        const src  = vcAudioCtx.createMediaStreamSource(stream);
        vcAnalyser = vcAudioCtx.createAnalyser();
        vcAnalyser.fftSize = 512;
        src.connect(vcAnalyser);
    }).catch(() => { /* 无波形也能通话 */ });
}

function vcEndCall() {
    // 终止进行中的 LLM 请求
    if (vcLlmAbortCtrl) { vcLlmAbortCtrl.abort(); vcLlmAbortCtrl = null; }
    vcStreamBuffer = '';
    vcCurrentResponseAudioItems = null; // 中途挂断时放弃当前未完成的收集
    vcTtsPipeline.length = 0; vcTtsDraining = false; vcGenDone = true;
    // 快照通话记录并立即清空（inject 是 async，但先把日志拍下来）
    const logSnapshot = vcCallLog.slice();
    vcCallLog = [];
    if (vc().vcInjectOnEnd && logSnapshot.length) vcInjectCallRecord(logSnapshot);
    if (vcSpeechRec)  { try { vcSpeechRec.abort(); } catch (_) {} vcSpeechRec = null; }
    if (vcSpeakAudio)  {
        // vcSpeakAudio 可能是 AudioBufferSourceNode（AudioContext 播放）或 HTMLAudioElement（回退）
        try { if (typeof vcSpeakAudio.stop === 'function') vcSpeakAudio.stop(); else vcSpeakAudio.pause(); } catch (_) {}
        vcSpeakAudio = null;
    }
    if (vcRafId)       { cancelAnimationFrame(vcRafId); vcRafId = null; }
    if (vcAudioCtx)    { try { vcAudioCtx.close(); } catch (_) {} vcAudioCtx = null; }
    if (vcPlaybackCtx) { try { vcPlaybackCtx.close(); } catch (_) {} vcPlaybackCtx = null; }
    if (vcStream)      { vcStream.getTracks().forEach(t => t.stop()); vcStream = null; }
    vcAnalyser = null;

    // VRM 清理
    if (vrmModule) { try { vrmModule.destroy(); } catch (_) {} }
    vrmAnalyserNode = null;
    document.documentElement.classList.remove('mm-vc-active');
    if (vcTimerInterval) { clearInterval(vcTimerInterval); vcTimerInterval = null; }

    if (callMode === 'voice') document.getElementById('vc-dialog')?.classList.remove('vc-dialog-open');
    const log = vcEl('vc-log');
    if (log) log.innerHTML = '';
    vcMuted = false;
    const muteBtn = vcEl('vc-mute');
    if (muteBtn) {
        muteBtn.classList.remove('vc-btn-muted');
        muteBtn.querySelector('i').className = 'fa-solid fa-microphone';
    }
    vcSetState('idle');
}

function vcToggleMute() {
    vcMuted = !vcMuted;
    const btn = vcEl('vc-mute');
    if (btn) {
        btn.classList.toggle('vc-btn-muted', vcMuted);
        btn.querySelector('i').className = vcMuted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
    }
    if (vcMuted && vcSpeechRec) { try { vcSpeechRec.abort(); } catch (_) {} }
    if (!vcMuted && vcState === 'listening') vcStartWebSpeech(); // 取消静音后立刻重启识别
    if (vcState === 'listening') vcSetState('listening'); // 刷新状态文字
}

// ── FAB + 弹窗 DOM ────────────────────────────────────────────────────────────
function vcCreateUi() {
    const fab = document.createElement('div');
    fab.id    = 'vc-fab';
    fab.title = '语音通话';
    fab.innerHTML = '<i class="fa-solid fa-phone"></i>';
    // 根据 vcEnabled 设置初始显示状态
    if (vc().vcEnabled === false) fab.style.display = 'none';
    // 附加到 <html> 而非 <body>，避免 body 上的 filter/transform（主题）
    // 导致 position:fixed 相对 body 而非视口定位
    document.documentElement.appendChild(fab);

    // ── 拖拽逻辑（Pointer Events API，兼容鼠标 + 触摸） ──────────────────────
    let dragging = false, wasDragged = false, ox = 0, oy = 0;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // CSS 不再设置任何位置属性，JS 完全接管 left/top
    const fabTakeOver = (x, y) => {
        fab.style.left = clamp(x, 0, window.innerWidth  - 52) + 'px';
        fab.style.top  = clamp(y, 0, window.innerHeight - 52) + 'px';
    };

    // 恢复上次保存的位置，或默认居中偏下
    try {
        const p = JSON.parse(localStorage.getItem('vc-fab-pos') || 'null');
        if (p && typeof p.l === 'number') {
            fabTakeOver(p.l, p.t);
        } else {
            fabTakeOver((window.innerWidth - 52) / 2, window.innerHeight - 52 - 80);
        }
    } catch (_) {
        fabTakeOver((window.innerWidth - 52) / 2, window.innerHeight - 52 - 80);
    }

    fab.addEventListener('pointerdown', e => {
        dragging = true; wasDragged = false;
        fab.setPointerCapture(e.pointerId);
        const r = fab.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        fab.style.transition = 'box-shadow 0.18s ease'; // 拖动时关闭位移动画
        e.preventDefault();
    }, { passive: false });

    fab.addEventListener('pointermove', e => {
        if (!dragging) return;
        fabTakeOver(e.clientX - ox, e.clientY - oy);
        wasDragged = true;
        e.preventDefault();
    }, { passive: false });

    const onPointerEnd = e => {
        if (!dragging) return;
        dragging = false;
        fab.releasePointerCapture(e.pointerId);
        fab.style.transition = ''; // 恢复动画
        if (wasDragged) {
            const r = fab.getBoundingClientRect();
            try { localStorage.setItem('vc-fab-pos', JSON.stringify({ l: r.left, t: r.top })); } catch (_) {}
        }
    };
    fab.addEventListener('pointerup',     onPointerEnd);
    fab.addEventListener('pointercancel', onPointerEnd);

    // 拖动后忽略 click，未拖动才触发语音通话
    fab.addEventListener('click', () => {
        if (wasDragged) { wasDragged = false; return; }
        if (vcState === 'idle') { callMode = 'voice'; vcStartCall(); } else vcEndCall();
    });

    // 窗口缩放时把悬浮球夹回可视区，同时更新 VRM 渲染器
    window.addEventListener('resize', () => {
        if (fab.style.left) {
            fab.style.left = clamp(parseFloat(fab.style.left), 0, window.innerWidth  - 52) + 'px';
            fab.style.top  = clamp(parseFloat(fab.style.top),  0, window.innerHeight - 52) + 'px';
        }
        const vrmC = document.getElementById('vc-vrm-canvas');
        if (vrmC && vrmModule?.isReady() && document.documentElement.classList.contains('mm-vc-active'))
            vrmModule.resize(vrmC);
    }, { passive: true });

    const dialog = document.createElement('div');
    dialog.id = 'vc-dialog';
    dialog.innerHTML = `
        <div class="vc-card">
            <div class="vc-avatar-wrap">
                <div class="vc-ripple r1"></div>
                <div class="vc-ripple r2"></div>
                <div class="vc-ripple r3"></div>
                <img id="vc-avatar" src="" alt="" style="display:none">
                <div id="vc-avatar-placeholder" class="vc-avatar-placeholder">
                    <i class="fa-solid fa-robot"></i>
                </div>
            </div>
            <div id="vc-name" class="vc-name">接通中...</div>
            <div class="vc-meta">
                <span id="vc-timer">00:00</span>
                <span class="vc-dot">·</span>
                <span id="vc-status">连接中</span>
            </div>
            <canvas id="vc-canvas" width="240" height="48"></canvas>
            <div id="vc-log" class="vc-log"></div>
            <div class="vc-controls">
                <button id="vc-mute" class="vc-btn" title="静音">
                    <i class="fa-solid fa-microphone"></i><span>静音</span>
                </button>
                <button id="vc-hangup" class="vc-btn vc-btn-end" title="挂断">
                    <i class="fa-solid fa-phone-slash"></i><span>挂断</span>
                </button>
            </div>
        </div>`;
    document.documentElement.appendChild(dialog);
    document.getElementById('vc-hangup').addEventListener('click', vcEndCall);
    document.getElementById('vc-mute').addEventListener('click', vcToggleMute);

    // ── 视频通话悬浮球（独立于语音 FAB） ──────────────────────────────────────
    const vrmFab = document.createElement('div');
    vrmFab.id    = 'vrm-fab';
    vrmFab.title = '视频通话';
    vrmFab.innerHTML = '<i class="fa-solid fa-video"></i>';
    if (!s().vrmEnabled) vrmFab.style.display = 'none';
    document.documentElement.appendChild(vrmFab);

    {
        let vDragging = false, vWasDragged = false, vox = 0, voy = 0;
        const vClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const vTakeOver = (x, y) => {
            vrmFab.style.left = vClamp(x, 0, window.innerWidth  - 52) + 'px';
            vrmFab.style.top  = vClamp(y, 0, window.innerHeight - 52) + 'px';
        };
        try {
            const p = JSON.parse(localStorage.getItem('vrm-fab-pos') || 'null');
            if (p && typeof p.l === 'number') vTakeOver(p.l, p.t);
            else vTakeOver((window.innerWidth - 52) / 2 + 64, window.innerHeight - 52 - 80);
        } catch (_) { vTakeOver((window.innerWidth - 52) / 2 + 64, window.innerHeight - 52 - 80); }

        vrmFab.addEventListener('pointerdown', e => {
            vDragging = true; vWasDragged = false;
            vrmFab.setPointerCapture(e.pointerId);
            const r = vrmFab.getBoundingClientRect();
            vox = e.clientX - r.left; voy = e.clientY - r.top;
            vrmFab.style.transition = 'box-shadow 0.18s ease';
            e.preventDefault();
        }, { passive: false });
        vrmFab.addEventListener('pointermove', e => {
            if (!vDragging) return;
            vTakeOver(e.clientX - vox, e.clientY - voy);
            vWasDragged = true; e.preventDefault();
        }, { passive: false });
        const vOnEnd = e => {
            if (!vDragging) return;
            vDragging = false;
            vrmFab.releasePointerCapture(e.pointerId);
            vrmFab.style.transition = '';
            if (vWasDragged) {
                const r = vrmFab.getBoundingClientRect();
                try { localStorage.setItem('vrm-fab-pos', JSON.stringify({ l: r.left, t: r.top })); } catch (_) {}
            }
        };
        vrmFab.addEventListener('pointerup',     vOnEnd);
        vrmFab.addEventListener('pointercancel', vOnEnd);
        vrmFab.addEventListener('click', () => {
            if (vWasDragged) { vWasDragged = false; return; }
            if (vcState === 'idle') { callMode = 'video'; vcStartCall(); } else vcEndCall();
        });
        window.addEventListener('resize', () => {
            if (vrmFab.style.left) {
                vrmFab.style.left = vClamp(parseFloat(vrmFab.style.left), 0, window.innerWidth  - 52) + 'px';
                vrmFab.style.top  = vClamp(parseFloat(vrmFab.style.top),  0, window.innerHeight - 52) + 'px';
            }
        }, { passive: true });
    }

    // ── VRM 全屏帧（独立于 vc-dialog，通话时展开） ─────────────────────────────
    const vrmFrame = document.createElement('div');
    vrmFrame.id = 'mm-vrm-frame';
    vrmFrame.innerHTML = `
        <canvas id="vc-vrm-canvas" width="960" height="1440"></canvas>
        <div id="vc-vrm-progress" class="vc-vrm-progress"></div>
        <div id="mm-vrm-hud">
            <div id="vrm-log" class="vc-log vrm-hud-log"></div>
            <div class="vc-controls vrm-hud-controls">
                <button id="vrm-mute" class="vc-btn" title="静音">
                    <i class="fa-solid fa-microphone"></i><span>静音</span>
                </button>
                <button id="vrm-hangup" class="vc-btn vc-btn-end" title="挂断">
                    <i class="fa-solid fa-phone-slash"></i><span>挂断</span>
                </button>
            </div>
        </div>`;
    document.documentElement.appendChild(vrmFrame);
    document.getElementById('vrm-hangup').addEventListener('click', vcEndCall);
    document.getElementById('vrm-mute').addEventListener('click', vcToggleMute);

    // ── 悬浮信息条：在 VRM 与聊天框分界处居中显示角色名/计时/状态 ─────────────
    const infoBar = document.createElement('div');
    infoBar.id = 'mm-vrm-info';
    infoBar.innerHTML = `
        <span id="vrm-info-name">接通中...</span>
        <div class="mm-vrm-meta">
            <span id="vrm-info-timer">00:00</span>
            <span class="mm-vrm-dot">·</span>
            <span id="vrm-info-status">连接中</span>
        </div>`;
    document.documentElement.appendChild(infoBar);
}

// ── 入口（独立 jQuery 块，不改动原有代码） ────────────────────────────────────
jQuery(async () => {
    await (window.__TAURITAVERN__?.ready ?? window.__TAURITAVERN_MAIN_READY__);
    vcLoadSettings();
    vcCreateUi();
    // 将旧浏览器模型迁移到可随宿主同步的存储。
    await restoreVrmBlobUrl();

    // 通话期间屏蔽普通自动播放（已由通话模块接管）
    // CHARACTER_MESSAGE_RENDERED 无需在此处理，vcStreamingLlm 直接处理 LLM 流
});
