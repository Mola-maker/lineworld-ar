import * as THREE from 'three';
import { coverFit, orientationToQuaternion, rayToFloor } from '../math.js';

// "Magic window" mode: works everywhere (iOS Safari, desktop webcams).
// The camera image is the backdrop; the gyroscope rotates the 3D camera;
// the floor is assumed to be camera.heightMeters below the eye.
// Limitation (documented): phone translation is not tracked, so walking
// around makes the character slide. Use WebXR mode for true tracking.

export class WindowMode {
  constructor({ camera, lineArt, character, grounding, dom }) {
    Object.assign(this, { camera, lineArt, character, grounding, dom });
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.hasGyro = false;
    this.placed = false;
    this.manual = { yaw: 0, pitch: THREE.MathUtils.degToRad(-22) };
  }

  async start(cfg) {
    this.cfg = cfg;
    await this.requestGyro();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: cfg.camera.facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.texture = new THREE.VideoTexture(this.video);
      this.texture.colorSpace = THREE.SRGBColorSpace;
    } catch (e) {
      console.warn('[window] no camera, using demo backdrop', e);
      this.texture = demoTexture();
      this.noCamera = true;
    }
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.bindInput();
    this.applyConfig(cfg);
    return { noCamera: !!this.noCamera, gyro: this.hasGyro };
  }

  async requestGyro() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    try {
      if (typeof DOE.requestPermission === 'function') {
        if ((await DOE.requestPermission()) !== 'granted') return; // iOS, needs a user tap
      }
    } catch { return; }
    this.onOrient = (e) => {
      if (e.alpha == null && e.beta == null) return;
      this.orient = e;
      this.hasGyro = true;
    };
    window.addEventListener('deviceorientation', this.onOrient);
  }

  applyConfig(cfg) {
    this.cfg = cfg;
    const w = this.video.videoWidth || this.texture?.image?.width || 1280;
    const h = this.video.videoHeight || this.texture?.image?.height || 720;
    const fit = coverFit({
      videoW: w, videoH: h, screenW: innerWidth, screenH: innerHeight,
      fovLongSideDeg: cfg.camera.fovLongSideDeg,
    });
    this.camera.fov = fit.vFovDeg;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, cfg.camera.heightMeters, 0);
    const mirror = cfg.camera.mirror === 'auto' ? cfg.camera.facing === 'user' : !!cfg.camera.mirror;
    this.lineArt.setSource(this.texture, { uvScale: fit.uvScale, uvOffset: fit.uvOffset, mirror });
    this.grounding.setFloorHeight(0);
  }

  bindInput() {
    let drag = null;
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; });
    el.addEventListener('pointermove', (e) => {
      if (!drag || this.hasGyro) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      this.manual.yaw -= dx * 0.005;
      this.manual.pitch = THREE.MathUtils.clamp(this.manual.pitch - dy * 0.005, -1.4, 0.2);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    el.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) this.tap(e.clientX, e.clientY);
      drag = null;
    });
  }

  tap(x, y) {
    const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hitCharacter = ray.intersectObject(this.character.root, true).length > 0;
    if (hitCharacter) return this.character.wave();
    const hit = rayToFloor(ray.ray.origin.toArray(), ray.ray.direction.toArray(), 0);
    if (hit) this.character.walkTo(new THREE.Vector3(...hit));
  }

  update() {
    if (this.hasGyro && this.orient) {
      const o = this.orient;
      const angle = window.screen.orientation?.angle ?? window.orientation ?? 0;
      this.camera.quaternion.fromArray(orientationToQuaternion(o.alpha || 0, o.beta || 0, o.gamma || 0, angle));
    } else {
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.manual.pitch, this.manual.yaw, 0, 'YXZ'));
    }
    this.camera.updateMatrixWorld();
    if (!this.placed && (this.hasGyro ? this.orient : true)) this.placeInFront();
  }

  placeInFront() {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) return; // looking straight down/up; wait
    fwd.normalize().multiplyScalar(this.cfg.character.distanceMeters);
    const viewer = new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
    this.character.placeAt(viewer.clone().add(fwd), viewer);
    this.placed = true;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.onOrient) window.removeEventListener('deviceorientation', this.onOrient);
  }
}

function demoTexture() {
  // Stand-in "room" so desktop without a webcam still shows the line effect.
  const cv = document.createElement('canvas');
  cv.width = 1280; cv.height = 720;
  const c = cv.getContext('2d');
  c.fillStyle = '#d8d2c4'; c.fillRect(0, 0, 1280, 720);
  c.fillStyle = '#a99f8c'; c.fillRect(0, 430, 1280, 290);
  c.strokeStyle = '#6e6656'; c.lineWidth = 3;
  for (let i = -8; i <= 8; i++) { c.beginPath(); c.moveTo(640 + i * 40, 430); c.lineTo(640 + i * 220, 720); c.stroke(); }
  for (let y = 450, s = 20; y < 720; y += s, s *= 1.25) { c.beginPath(); c.moveTo(0, y); c.lineTo(1280, y); c.stroke(); }
  c.fillStyle = '#8b7d66'; c.fillRect(140, 210, 260, 240); c.fillStyle = '#c7bfae'; c.fillRect(160, 230, 220, 90);
  c.fillStyle = '#5d6b78'; c.fillRect(860, 120, 300, 200); c.fillStyle = '#9fb3c4'; c.fillRect(875, 135, 270, 170);
  c.beginPath(); c.arc(1010, 520, 60, 0, Math.PI * 2); c.fillStyle = '#6e7f5a'; c.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
