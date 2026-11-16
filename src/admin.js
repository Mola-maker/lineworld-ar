import GUI from 'lil-gui';
import { DEFAULTS, diff, writeLocal, deepMerge } from './config.js';

// Admin panel: generated from the config object itself, so a new key in
// DEFAULTS shows up here with no extra code. Open with ?admin=1 or a
// three-finger / triple tap in the top-left corner.

const ENUMS = {
  mode: ['auto', 'webxr', 'window'],
  'camera.facing': ['environment', 'user'],
  'camera.mirror': ['auto', true, false],
  'character.style': ['toon', 'original'],
  'depth.device': ['auto', 'webgpu', 'wasm'],
  'depth.debugView': ['off', 'disparity', 'floor', 'meters'],
  'depth.dtypeWebGPU': ['q4f16', 'fp16', 'q8', 'fp32'],
  'depth.dtypeWasm': ['q8', 'q4', 'fp32'],
};
const RANGES = {
  'camera.fovLongSideDeg': [30, 120, 1], 'camera.heightMeters': [0.2, 2.2, 0.01],
  'camera.processScale': [0.15, 1, 0.05],
  'lineArt.threshold': [0, 1, 0.005], 'lineArt.softness': [0, 0.5, 0.005],
  'lineArt.lineWidth': [0.5, 4, 0.05], 'lineArt.fillAmount': [0, 1, 0.01],
  'lineArt.fillLevels': [1, 8, 1], 'lineArt.originalMix': [0, 1, 0.01],
  'lineArt.jitter': [0, 4, 0.05], 'lineArt.jitterFps': [0, 30, 1], 'lineArt.grain': [0, 0.2, 0.005],
  'character.heightMeters': [0, 3, 0.01], 'character.footOffset': [-0.2, 0.2, 0.001],
  'character.distanceMeters': [0.3, 6, 0.05], 'character.outlineWidth': [0, 0.03, 0.0005],
  'character.toonSteps': [2, 6, 1], 'character.walkSpeed': [0, 3, 0.05], 'character.crossFade': [0, 1, 0.05],
  'character.footIK.maxCorrection': [0, 0.2, 0.005], 'character.footIK.contactHeight': [0, 0.1, 0.005],
  'character.footIK.releaseDistance': [0.02, 0.5, 0.01], 'character.footIK.blendTime': [0.01, 0.5, 0.01],
  'grounding.shadowOpacity': [0, 1, 0.01], 'grounding.contactOpacity': [0, 1, 0.01],
  'grounding.contactRadius': [0.05, 1.5, 0.01],
  'lineArt.colorEdgeWeight': [0, 2, 0.05], 'lineArt.depthEdgeWeight': [0, 2, 0.05], 'lineArt.depthThreshold': [0.005, 0.2, 0.005],
  'depth.occlusionBias': [0, 0.5, 0.01], 'depth.floorTolerance': [0.02, 0.4, 0.01], 'depth.maxFloorDistance': [2, 15, 0.5],
  'depth.inputSize': [140, 518, 14], 'depth.maxFps': [1, 30, 1],
  'lighting.ambientIntensity': [0, 4, 0.05], 'lighting.sunIntensity': [0, 8, 0.05],
  'lighting.sunAzimuthDeg': [-180, 180, 1], 'lighting.sunElevationDeg': [5, 90, 1],
};
const RELOAD_KEYS = new Set(['character.url', 'character.animations']);
const RESTART_KEYS = new Set(['mode', 'camera.facing']);

export function createAdmin({ config, base, onChange, onReloadModel, onLocalModel, getInfo }) {
  const gui = new GUI({ title: 'Admin · LineWorld' });
  gui.domElement.classList.add('admin');
  if (innerWidth < 600) gui.close(); // don't cover the phone screen on open

  const persist = () => writeLocal(diff(base, config));

  const build = (folder, obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = path ? `${path}.${k}` : k;
      if (v && typeof v === 'object') {
        build(folder.addFolder(k).close(), v, key);
        continue;
      }
      let ctl;
      if (ENUMS[key]) ctl = folder.add(obj, k, ENUMS[key]);
      else if (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v)) ctl = folder.addColor(obj, k);
      else if (typeof v === 'number' && RANGES[key]) ctl = folder.add(obj, k, ...RANGES[key]);
      else ctl = folder.add(obj, k);
      const top = key.split('.').slice(0, 2).join('.');
      ctl.onFinishChange(() => {
        persist();
        if (RELOAD_KEYS.has(top) || RELOAD_KEYS.has(key)) onReloadModel();
        else if (RESTART_KEYS.has(key)) location.reload();
      });
      ctl.onChange(() => onChange(key));
    }
  };
  build(gui, config, '');

  const info = gui.addFolder('Model check (spec)');
  const infoBox = document.createElement('pre');
  infoBox.className = 'admin-info';
  info.$children.appendChild(infoBox);
  const refresh = () => {
    const i = getInfo();
    infoBox.textContent = [
      `source:    ${i.source}`,
      `height:    ${i.height} m (raw ${i.rawHeight})`,
      `triangles: ${i.triangles}`,
      `clips:     ${i.clips.join(', ') || '—'}`,
      `legs:      ${i.legs?.length ? i.legs.join(' | ') : 'none (IK off)'}`,
      `stride:    ${i.strideSpeed ? i.strideSpeed + ' m/s (auto walk speed)' : '—'}`,
      `depth:     ${i.depth.state}${i.depth.device ? ' ' + i.depth.device : ''}${i.depth.state === 'ready' ? ` ${i.depth.fps} fps, ${i.depth.ms} ms, floor ${Math.round(i.depth.floorRatio * 100)}%` : ''} ${i.depth.progress || ''}`,
      ...(i.warnings.length ? ['', 'warnings:', ...i.warnings.map((w) => `· ${w}`)] : ['', 'no warnings']),
    ].join('\n');
  };

  const actions = {
    'Load local .glb…': () => pickFile('.glb,.gltf', (f) => onLocalModel(URL.createObjectURL(f))),
    'Export config JSON': () => download('lineworld.config.json', JSON.stringify(deepMerge(base, diff(base, config)), null, 2)),
    'Import config JSON': () => pickFile('.json', async (f) => {
      writeLocal(diff(base, deepMerge(DEFAULTS, JSON.parse(await f.text()))));
      location.reload();
    }),
    'Reset local edits': () => { writeLocal(null); location.reload(); },
  };
  for (const k of Object.keys(actions)) gui.add(actions, k);

  return { gui, refresh };
}

function pickFile(accept, cb) {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = accept;
  i.onchange = () => i.files[0] && cb(i.files[0]);
  i.click();
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
