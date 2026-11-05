// Source for the self-contained vrm.js bundle. No runtime CDN imports.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

let renderer, scene, camera, canvas, model, observer, analyser, frequencyData;
let frame = 0, lastTime = 0, generation = 0, loadController;
let state = 'idle', emotion = '', action = '', actionStart = 0;
const bones = new Map();
const EXPRESSIONS = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];

function disposeModel(vrm) {
    if (!vrm) return;
    vrm.scene.removeFromParent();
    VRMUtils.deepDispose(vrm.scene);
}

export function isReady() { return Boolean(renderer && model); }

export function resize() {
    if (!canvas || !renderer || !camera) return;
    const width = Math.max(1, canvas.clientWidth || canvas.parentElement?.clientWidth || 480);
    const height = Math.max(1, canvas.clientHeight || canvas.parentElement?.clientHeight || 640);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

export function setPixelRatio(value = 1) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio)) return;
    renderer?.setPixelRatio(Math.max(0.5, Math.min(2, ratio)));
    resize();
}

export function setAnalyser(value) {
    analyser = value || null;
    frequencyData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
}

export function setState(value) { state = String(value || 'idle'); }

export function setEmotion(value) {
    emotion = EXPRESSIONS.includes(value) ? value : '';
}

export function setEmotionFromText(text) {
    const rules = [
        ['happy', /开心|高兴|喜欢|哈哈|太好了|真棒/u],
        ['sad', /难过|伤心|失望|抱歉|对不起/u],
        ['angry', /生气|讨厌|愤怒|可恶/u],
        ['surprised', /惊讶|没想到|真的吗|居然/u],
    ];
    setEmotion(rules.find(([, pattern]) => pattern.test(String(text)))?.[0] || 'relaxed');
}

export function playAction(value) {
    if (!['nod', 'shake', 'wave', 'tilt'].includes(value)) return;
    action = value;
    actionStart = performance.now();
}

function updateAnimation(time, delta) {
    for (const { node, rotation } of bones.values()) node.quaternion.copy(rotation);
    const head = bones.get('head')?.node;
    const arm = bones.get('rightUpperArm')?.node;
    if (action && time - actionStart < 1800) {
        const phase = (time - actionStart) / 1800;
        const envelope = Math.sin(Math.PI * phase);
        if (head && action === 'nod') head.rotateX(Math.sin(phase * Math.PI * 4) * 0.14 * envelope);
        if (head && action === 'shake') head.rotateY(Math.sin(phase * Math.PI * 4) * 0.22 * envelope);
        if (head && action === 'tilt') head.rotateZ(0.18 * envelope);
        if (arm && action === 'wave') arm.rotateZ((0.6 + 0.15 * Math.sin(phase * Math.PI * 8)) * envelope);
    } else action = '';
    const expressions = model.expressionManager;
    if (expressions) {
        for (const name of EXPRESSIONS) expressions.setValue(name, emotion === name ? 0.6 : 0);
        const blinkPhase = (time % 4200) / 4200;
        expressions.setValue('blink', blinkPhase > 0.96 ? Math.sin((blinkPhase - 0.96) / 0.04 * Math.PI) : 0);
        let mouth = 0;
        if (state === 'speaking' && analyser && frequencyData) {
            analyser.getByteFrequencyData(frequencyData);
            const count = Math.min(40, frequencyData.length);
            for (let i = 0; i < count; i++) mouth += frequencyData[i];
            mouth = Math.min(1, mouth / Math.max(1, count) / 100);
        }
        expressions.setValue('aa', mouth);
    }
    model.update(delta);
}

function render(time) {
    if (!renderer) return;
    const delta = Math.min(0.05, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    if (model) updateAnimation(time, delta);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
}

export async function init(targetCanvas, pixelRatio = 1) {
    if (!(targetCanvas instanceof HTMLCanvasElement)) throw new Error('VRM 需要有效的画布');
    if (renderer && canvas === targetCanvas) { setPixelRatio(pixelRatio); return; }
    destroy();
    canvas = targetCanvas;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x62626f, 2.4));
        const light = new THREE.DirectionalLight(0xffffff, 2.2);
        light.position.set(1, 2, 3);
        scene.add(light);
        setPixelRatio(pixelRatio);
        observer = new ResizeObserver(resize);
        observer.observe(canvas);
        lastTime = performance.now();
        frame = requestAnimationFrame(render);
    } catch (error) { destroy(); throw new Error('无法初始化 VRM 渲染：' + error.message); }
}

export async function loadModel(url) {
    if (!renderer) throw new Error('请先初始化 VRM 画布');
    loadController?.abort();
    const token = ++generation;
    const controller = new AbortController();
    loadController = controller;
    const timer = setTimeout(() => controller.abort(new Error('VRM 模型下载超时')), 45000);
    const progress = document.getElementById('vc-vrm-progress');
    if (progress) progress.textContent = '正在加载 VRM…';
    let nextModel;
    try {
        const source = new URL(url, window.location.href);
        if (!['https:', 'blob:'].includes(source.protocol) && source.origin !== window.location.origin) {
            throw new Error('模型地址必须是本地文件或 HTTPS URL');
        }
        const response = await fetch(source.href, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`);
        const maxBytes = 100 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('模型超过 100MB');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) throw new Error('模型超过 100MB');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = await new Blob(chunks).arrayBuffer();
        if (controller.signal.aborted || token !== generation) throw new Error('模型加载已取消');
        const loader = new GLTFLoader();
        // VRM should be a single GLB. Block embedded references to remote files.
        loader.manager.setURLModifier(resource => {
            if (!resource.startsWith('blob:') && !resource.startsWith('data:')) {
                throw new Error('VRM 模型含外部资源，请改用自包含的 .vrm 文件');
            }
            return resource;
        });
        loader.register(parser => new VRMLoaderPlugin(parser));
        const gltf = await loader.parseAsync(bytes, '');
        nextModel = gltf.userData.vrm;
        if (!nextModel) { VRMUtils.deepDispose(gltf.scene); throw new Error('文件不是受支持的 VRM 模型'); }
        if (controller.signal.aborted || token !== generation || !renderer) throw new Error('模型加载已取消');
        VRMUtils.rotateVRM0(nextModel);
        disposeModel(model);
        model = nextModel;
        nextModel = null;
        scene.add(model.scene);
        model.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model.scene);
        if (box.isEmpty()) throw new Error('VRM 模型没有可显示的网格');
        const center = box.getCenter(new THREE.Vector3());
        const size3 = box.getSize(new THREE.Vector3());
        const distance = Math.max(size3.y, size3.x / camera.aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(15))) * 1.12;
        camera.position.set(center.x, center.y, center.z + distance);
        camera.lookAt(center);
        bones.clear();
        for (const name of ['head', 'rightUpperArm']) {
            const node = model.humanoid?.getNormalizedBoneNode(name);
            if (node) bones.set(name, { node, rotation: node.quaternion.clone() });
        }
        state = 'idle';
        emotion = '';
    } finally {
        clearTimeout(timer);
        disposeModel(nextModel);
        if (token === generation) {
            loadController = null;
            if (progress) progress.textContent = '';
        }
    }
}

export function destroy() {
    generation++;
    loadController?.abort();
    loadController = null;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    disposeModel(model);
    renderer?.dispose();
    bones.clear();
    model = renderer = scene = camera = canvas = observer = analyser = frequencyData = null;
    state = 'idle';
    emotion = action = '';
}
