import * as THREE from 'three';
import { loadConfig } from './config.js';
import { LineArt } from './lineart.js';
import { Character } from './character.js';
import { Grounding } from './grounding.js';
import { WindowMode } from './modes/window.js';
import { XRMode, xrSupported } from './modes/webxr.js';
import { createAdmin } from './admin.js';
import { DepthEstimator } from './depth/depth.js';
import { createOccluder } from './depth/occluder.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const { config, base } = await loadConfig();
document.title = config.ui.title;
$('title').textContent = config.ui.title;
$('hint').textContent = config.ui.hint;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100);
const lineArt = new LineArt();
scene.add(lineArt.backdrop);
const depth = new DepthEstimator();
lineArt.attachDepth(depth.uniforms);
const occluder = createOccluder(depth.uniforms);
scene.add(occluder);
depth.onStatus = (i) => {
  admin?.refresh();
  if (i.state === 'error') toast('Depth unavailable: ' + i.progress);
};
const grounding = new Grounding(scene);
const character = new Character();
scene.add(character.root);
grounding.attach(character.root);

let mode = null;
let admin = null;

function applyAll(cfg) {
  lineArt.applyConfig(cfg);
  grounding.applyConfig(cfg);
  character.applyConfig(cfg);
  mode?.applyConfig(cfg);
  if (mode instanceof WindowMode) depth.applyConfig(cfg);
  $('fps').hidden = !cfg.ui.showFps;
  admin?.refresh();
}

async function loadModel(url = config.character.url) {
  $('status').textContent = 'Loading character…';
  await character.load(url, config);
  $('status').textContent = '';
  applyAll(config);
}

await loadModel();

// ---------- start screen ----------
const canXR = config.mode !== 'window' && (await xrSupported());
$('btn-xr').hidden = !canXR;
$('btn-window').hidden = config.mode === 'webxr' && canXR;

const CAMERA_ERRORS = {
  InsecureContext: '摄像头只能在 HTTPS（或本机 localhost）下使用。请用 https:// 地址打开（如 GitHub Pages，或 npm run dev:https）。<br>Camera needs HTTPS.',
  NotAllowedError: '摄像头权限被拒绝。请在浏览器地址栏/系统设置里允许本网站使用摄像头，然后刷新。<br>Camera permission denied.',
  NotFoundError: '没有找到摄像头。<br>No camera found.',
  NotReadableError: '摄像头被其他程序占用（关闭视频会议等软件后刷新）。<br>Camera is in use by another app.',
  OverconstrainedError: '摄像头不支持请求的参数。<br>Camera constraints not supported.',
};

async function startWindowMode() {
  $('start').hidden = true;
  mode = new WindowMode({ renderer, camera, lineArt, character, grounding, dom: renderer.domElement, depth, toast });
  const r = await mode.start(config);
  if (r.noCamera) {
    // Never pass the demo room off as the user's camera: say so, persistently.
    banner(`${CAMERA_ERRORS[r.cameraError] || `摄像头无法打开（${r.cameraError}）。`}<br><b>当前显示的是内置演示房间，不是你的摄像头画面。</b>`);
  } else {
    toast(r.gyro ? config.ui.hint : 'No gyroscope – drag to look around. ' + config.ui.hint);
  }
}

$('btn-window').onclick = startWindowMode;

$('btn-xr').onclick = async () => {
  $('start').hidden = true;
  mode = new XRMode({
    renderer, scene, camera, lineArt, character, grounding, overlay: $('overlay'),
    onEnd: () => { $('start').hidden = false; mode = null; },
  });
  try {
    await mode.start(config);
    toast('Move the phone slowly over the floor, then tap to place.');
  } catch (e) {
    // Usually: this phone/browser can't give raw camera access to WebXR, so the
    // line world can't be drawn in tracked AR. Camera view always can.
    console.warn('[xr] falling back to camera view:', e);
    mode = null;
    await startWindowMode();
    toast('此设备的 AR 模式无法获取摄像头画面，已切换到摄像头模式（线条世界）。');
  }
};

// ---------- admin ----------
function openAdmin() {
  if (admin) return admin.gui.show(admin.gui._hidden);
  admin = createAdmin({
    config, base,
    onChange: () => applyAll(config),
    onReloadModel: () => loadModel(),
    onLocalModel: (url) => loadModel(url),
    getInfo: () => ({ ...character.info, depth: depth.info }),
    toast,
  });
  admin.refresh();
}
if (params.has('admin')) openAdmin();
let taps = [];
addEventListener('pointerdown', (e) => {
  if (e.clientX > 80 || e.clientY > 80) return;
  taps = [...taps.filter((t) => e.timeStamp - t < 600), e.timeStamp];
  if (taps.length >= 3) { taps = []; openAdmin(); }
});

// Drag & drop a .glb anywhere: fastest way for the art team to check a delivery.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => /\.(glb|gltf)$/i.test(x.name));
  if (f) loadModel(URL.createObjectURL(f)).then(() => { openAdmin(); admin.setLocalModel?.(f); toast(`Loaded ${f.name}`); });
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  mode?.applyConfig(config);
});

// ---------- loop ----------
const timer = new THREE.Timer();
let frames = 0, fpsT = 0;
renderer.setAnimationLoop((time, frame) => {
  timer.update(time); const dt = Math.min(timer.getDelta(), 0.1);
  if (mode instanceof XRMode) mode.update(frame);
  else mode?.update();

  const viewer = renderer.xr.isPresenting
    ? new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld)
    : camera.position.clone();
  viewer.y = character.root.position.y;
  occluder.visible = mode instanceof WindowMode;
  occluder.update(camera, config);
  character.update(dt, viewer);
  grounding.update();
  lineArt.update(renderer, time / 1000);
  renderer.render(scene, camera);

  frames++; fpsT += dt;
  if (fpsT > 0.5) { $('fps').textContent = `${Math.round(frames / fpsT)} fps`; frames = 0; fpsT = 0; }
});

function banner(html) {
  const el = $('banner');
  el.innerHTML = html;
  el.hidden = false;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// Handle for debugging from the browser console / automated tests.
window.lineworld = { config, character, scene, renderer, lineArt, grounding, depth };
