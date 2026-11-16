// Every tunable lives here. The admin panel (?admin=1) edits this object live;
// the same shape is what public/config.json, ?config=<url> and the exported
// JSON contain. Layering, later wins:
//   DEFAULTS < config.json < configs/<profile>.json (?profile=) < ?config=<url> < saved local edits

export const DEFAULTS = {
  mode: 'auto', // 'auto' | 'webxr' | 'window'  (window = camera + gyro fallback, works on iOS/desktop)

  camera: {
    facing: 'environment', // 'environment' (rear) | 'user' (front)
    fovLongSideDeg: 68,    // physical camera FOV across the long side of the sensor; phones ≈ 63–75
    heightMeters: 1.35,    // assumed eye height above the floor in window mode
    mirror: 'auto',        // 'auto' mirrors the front camera | true | false
    processScale: 0.5,     // line extraction resolution; lower = smoother lines + faster
    xrFlipY: false,        // flip the WebXR raw camera image if a device delivers it upside down
  },

  lineArt: {
    enabled: true,
    lineColor: '#1b2a4a',
    backgroundColor: '#f6f1e3',
    threshold: 0.18,       // edge strength needed to draw a line
    softness: 0.12,        // anti-aliasing width of the threshold
    lineWidth: 1.2,        // sampling radius in processed pixels
    fillAmount: 0.0,       // 0 = pure lines, 1 = posterized tinted fill underneath
    fillLevels: 4,
    fillTint: '#c9d6ea',
    originalMix: 0.0,      // blend of the real camera image back in
    jitter: 0.6,           // hand-drawn wobble in pixels
    jitterFps: 8,          // how often the wobble changes (boiling-line look)
    grain: 0.04,           // paper grain
    invert: false,
    colorEdgeWeight: 1.0,  // lines from colour/brightness changes
    depthEdgeWeight: 1.0,  // lines from depth discontinuities (needs depth.enabled)
    depthThreshold: 0.035,
  },

  depth: {                 // monocular depth (Depth Anything V2) – window mode only
    enabled: true,
    occlusion: true,       // real objects closer than the character hide it
    occlusionBias: 0.08,   // meters pushed back, avoids flicker at contact points
    tapRequiresFloor: true,// tap-to-walk only accepts pixels detected as floor
    floorTolerance: 0.12,  // relative error allowed for a pixel to count as floor
    maxFloorDistance: 8,
    inputSize: 266,        // model input long side (multiple of 14); higher = sharper, slower
    maxFps: 12,
    device: 'auto',        // 'auto' (WebGPU if available) | 'webgpu' | 'wasm'
    dtypeWebGPU: 'q4f16',
    dtypeWasm: 'q8',
    modelId: 'onnx-community/depth-anything-v2-small',
    localModelPath: 'models/',  // self-hosted copy (scripts/fetch-assets.mjs)
    remoteHost: 'https://huggingface.co/', // fallback; e.g. https://hf-mirror.com/ in mainland China; '' = never
    ortPath: 'ort/',       // self-hosted ONNX Runtime wasm; '' = CDN default
    debugView: 'off',      // 'off' | 'disparity' | 'floor' | 'meters' (bands, one per meter)
    xrNative: true,        // WebXR mode: use the device's own depth sensing for occlusion
  },

  character: {
    url: 'models/RobotExpressive.glb', // empty or failing → built-in placeholder
    heightMeters: 0.9,     // final standing height; 0 = keep the model's own size
    autoGround: true,      // shift so the lowest point of the bind pose sits on y=0
    footOffset: 0.0,       // fine manual correction in meters (+ lifts, − sinks)
    distanceMeters: 2.2,   // initial placement distance in front of the viewer
    faceViewer: true,
    style: 'toon',         // 'original' | 'toon' (flat shading + outline, matches the line world)
    outlineColor: '#1b2a4a',
    outlineWidth: 0.01,    // meters
    toonSteps: 3,
    animations: {          // logical name → clip name in the GLB
      idle: 'Idle',
      walk: 'Walking',
      wave: 'Wave',
    },
    footIK: {
      enabled: true,
      dynamicGrounding: true, // shift the body each frame so the lowest foot touches the floor
      maxCorrection: 0.06,    // meters; bigger gaps are treated as jumps and left alone
      footLock: true,         // pin planted feet to the floor (anti foot-sliding)
      contactHeight: 0.03,    // sole height (m) below which a foot counts as planted
      releaseDistance: 0.15,  // unpin when the animated foot is this far from its pin
      blendTime: 0.12,        // seconds to blend IK in/out
      bones: { left: '', right: '' }, // foot bone names; '' = detect automatically
    },
    walkSpeed: 0,          // m/s when tap-to-move; 0 = auto, measured from the walk clip's stride
    crossFade: 0.25,
  },

  grounding: {
    shadowCatcher: true,   // real shadow cast onto an invisible floor
    shadowOpacity: 0.35,
    shadowMapSize: 1024,
    contactShadow: true,   // soft dark blob right under the feet
    contactOpacity: 0.55,
    contactRadius: 0.35,   // meters
    showReticle: true,
  },

  lighting: {
    ambientIntensity: 1.1,
    sunIntensity: 2.2,
    sunAzimuthDeg: 35,
    sunElevationDeg: 55,
    useXREstimation: true, // WebXR light estimation when the device provides it
  },

  ui: {
    title: 'LineWorld',
    hint: 'Tap the floor to move the character',
    showFps: false,
  },
};

export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge without mutating inputs. Arrays and scalars replace. */
export function deepMerge(base, over) {
  if (!isObject(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Only the keys that differ from base — what we persist and export. */
export function diff(base, cur) {
  const out = {};
  for (const [k, v] of Object.entries(cur)) {
    if (isObject(v) && isObject(base?.[k])) {
      const d = diff(base[k], v);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(base?.[k])) {
      out[k] = v;
    }
  }
  return out;
}

const profileParam = () => new URLSearchParams(globalThis.location?.search || '').get('profile') || '';
// Local edits are kept per profile so editing one campaign doesn't leak into another.
const storageKey = () => 'lineworld.config.v1' + (profileParam() ? ':' + profileParam() : '');

async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || 'null');
  } catch {
    return null;
  }
}

export function writeLocal(obj) {
  try {
    if (obj) localStorage.setItem(storageKey(), JSON.stringify(obj));
    else localStorage.removeItem(storageKey());
  } catch { /* private mode: edits just won't persist */ }
}

/** Returns { config, base } where base is everything except local edits. */
export async function loadConfig() {
  const params = new URLSearchParams(location.search);
  let base = deepMerge(DEFAULTS, await fetchJson('config.json'));
  const profile = params.get('profile');
  if (profile && /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(profile)) base = deepMerge(base, await fetchJson(`configs/${profile}.json`));
  const remote = params.get('config');
  if (remote) base = deepMerge(base, await fetchJson(remote));
  const config = params.has('clean') ? structuredClone(base) : deepMerge(base, readLocal());
  return { config, base };
}
