import * as THREE from 'three';
import { analyseDepth } from './floor.js';

// Main-thread side of monocular depth (window mode).
//  capture: crop the live video exactly like the screen, downscale to a
//           multiple of 14, ship to the worker with the camera pose
//  receive: fit metric scale + floor mask (floor.js), pack into a texture
//  expose : texture + reprojection uniforms (depth lags a few frames; the
//           shaders rotate it into the *current* camera, which is exact for
//           window mode because the camera only rotates)

export class DepthEstimator {
  constructor() {
    this.state = 'off'; // off | loading | ready | error
    this.info = { state: 'off', device: '', fps: 0, ms: 0, floorRatio: 0, progress: '' };
    this.texture = null;
    this.valid = false;
    this.capQuat = new THREE.Quaternion();
    this.busy = false;
    this.last = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.uniforms = {
      tDepth: { value: null },
      depthValid: { value: false },
      uReproj: { value: new THREE.Matrix3() },
      uTan: { value: new THREE.Vector2(1, 1) },
    };
    this.frames = 0;
    this.fpsT = performance.now();
  }

  start(cfg) {
    if (this.worker) return;
    this.cfg = cfg.depth;
    this.state = this.info.state = 'loading';
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'worker error');
    const base = new URL('./', location.href).href;
    this.worker.postMessage({
      type: 'init',
      modelId: this.cfg.modelId,
      localModelPath: new URL(this.cfg.localModelPath, base).href,
      remoteHost: this.cfg.remoteHost,
      ortPath: this.cfg.ortPath ? new URL(this.cfg.ortPath, base).href : '',
      device: this.cfg.device,
      dtypeWebGPU: this.cfg.dtypeWebGPU,
      dtypeWasm: this.cfg.dtypeWasm,
    });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.state = this.info.state = 'off';
    this.valid = false;
    this.uniforms.depthValid.value = false;
  }

  applyConfig(cfg) {
    this.cfg = cfg.depth;
    if (cfg.depth.enabled && !this.worker) this.start(cfg);
    if (!cfg.depth.enabled && this.worker) this.stop();
  }

  fail(msg) {
    console.warn('[depth]', msg);
    this.state = this.info.state = 'error';
    this.info.progress = msg;
    this.onStatus?.(this.info);
  }

  onMessage(m) {
    if (m.type === 'progress') {
      this.info.progress = `${m.file?.split('/').pop()} ${Math.round(m.progress || 0)}%`;
      this.onStatus?.(this.info);
    } else if (m.type === 'ready') {
      this.state = this.info.state = 'ready';
      this.info.device = `${m.device}/${m.dtype}`;
      this.info.progress = '';
      this.onStatus?.(this.info);
    } else if (m.type === 'error') {
      this.busy = false;
      if (this.state === 'loading') this.fail(m.message);
      else console.warn('[depth] frame error', m.message);
    } else if (m.type === 'depth') {
      this.busy = false;
      this.info.ms = Math.round(m.ms);
      this.consume(m);
    }
  }

  /**
   * Call every frame in window mode.
   * source: { video|canvas, uvScale, uvOffset, mirror }, cam: { camera, height }
   */
  tick(source, camera, height) {
    if (this.state !== 'ready' || this.busy || !source?.image) return;
    const now = performance.now();
    if (now - this.last < 1000 / this.cfg.maxFps) return;
    const img = source.image;
    const iw = img.videoWidth || img.width, ih = img.videoHeight || img.height;
    if (!iw || !ih) return;
    this.last = now;

    // Input size: long side ≈ inputSize, both multiples of 14, screen aspect.
    const aspect = innerWidth / innerHeight;
    const S = this.cfg.inputSize;
    let w = aspect >= 1 ? S : S * aspect, h = aspect >= 1 ? S / aspect : S;
    w = Math.max(14, Math.round(w / 14) * 14);
    h = Math.max(14, Math.round(h / 14) * 14);
    this.canvas.width = w;
    this.canvas.height = h;
    const [sx, sy] = source.uvScale, [ox, oy] = source.uvOffset;
    const ctx = this.ctx;
    ctx.save();
    if (source.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    // uv offsets are bottom-origin; canvas is top-origin
    ctx.drawImage(img, ox * iw, (1 - oy - sy) * ih, sx * iw, sy * ih, 0, 0, w, h);
    ctx.restore();
    const pixels = ctx.getImageData(0, 0, w, h).data;

    this.busy = true;
    this.pending = {
      quaternion: camera.quaternion.toArray(),
      tanY: Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2),
      aspect: camera.aspect,
      height,
    };
    this.worker.postMessage({ type: 'run', id: now, pixels: pixels.buffer, width: w, height: h }, [pixels.buffer]);
  }

  consume({ data, width: w, height: h }) {
    const p = this.pending;
    if (!p) return;
    const cam = { quaternion: p.quaternion, tanY: p.tanY, tanX: p.tanY * p.aspect, height: p.height };
    const r = analyseDepth(data, w, h, cam, { tol: this.cfg.floorTolerance, maxFloorDist: this.cfg.maxFloorDistance });
    this.lastResult = { ...r, w, h, cam };
    this.info.floorRatio = r.fit ? +r.fit.ratio.toFixed(2) : 0;
    this.valid = !!r.fit;

    // Pack: R = metric depth (m), G = floor mask, B = normalised disparity.
    // Rows flipped so v=0 is the bottom, as in GL.
    const buf = new Uint16Array(w * h * 4);
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let y = 0; y < h; y++) {
      const src = y * w, dst = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        const i = (dst + x) * 4, s = src + x;
        buf[i] = toHalf(r.metric[s]);
        buf[i + 1] = toHalf(r.floor[s]);
        buf[i + 2] = toHalf(r.norm[s]);
        buf[i + 3] = toHalf(1);
      }
    }
    if (!this.texture || this.texture.image.width !== w || this.texture.image.height !== h) {
      this.texture?.dispose();
      this.texture = new THREE.DataTexture(buf, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
      this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
      this.texture.colorSpace = THREE.NoColorSpace;
    } else {
      this.texture.image.data = buf;
    }
    this.texture.needsUpdate = true;
    this.capQuat.fromArray(p.quaternion);
    this.uniforms.tDepth.value = this.texture;
    this.uniforms.uTan.value.set(cam.tanX, cam.tanY);

    this.frames++;
    const now = performance.now();
    if (now - this.fpsT > 1000) {
      this.info.fps = +((this.frames * 1000) / (now - this.fpsT)).toFixed(1);
      this.frames = 0; this.fpsT = now;
      this.onStatus?.(this.info);
    }
  }

  /** Per frame: rotation from the current camera into the capture camera. */
  updateUniforms(camera) {
    this.uniforms.depthValid.value = this.valid && !!this.texture;
    if (!this.texture) return;
    const rel = this.capQuat.clone().invert().multiply(camera.quaternion);
    this.uniforms.uReproj.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(rel));
  }

  /** Is the screen point (uv, bottom-origin) floor in the latest frame? null = unknown. */
  isFloorAt(u, v) {
    const r = this.lastResult;
    if (!r?.fit) return null;
    const x = Math.min(r.w - 1, Math.max(0, Math.floor(u * r.w)));
    const y = Math.min(r.h - 1, Math.max(0, Math.floor((1 - v) * r.h)));
    // Accept if any pixel in a small neighbourhood is floor (mask is noisy at edges).
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < r.w && yy < r.h && r.floor[yy * r.w + xx]) return true;
    }
    return false;
  }
}

/** GLSL shared by the occluder and the line shader. */
export const REPROJECT_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform bool depthValid;
  uniform mat3 uReproj;
  uniform vec2 uTan;
  // current-screen uv → capture uv (+ capture-camera point for that pixel ray)
  vec2 reprojectUv(vec2 uv, out vec3 rayCap) {
    vec3 r = vec3((uv * 2.0 - 1.0) * uTan, -1.0);
    rayCap = uReproj * r;
    if (rayCap.z > -1e-4) return vec2(-1.0);
    return (rayCap.xy / -rayCap.z) / uTan * 0.5 + 0.5;
  }
`;
