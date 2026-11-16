import * as THREE from 'three';
import { coverFit, orientationToQuaternion, rayToFloor } from '../math.js';
import { renderDemoRoom } from '../demoRoom.js';

// "Magic window" mode: works everywhere (iOS Safari, desktop webcams).
// The camera image is the backdrop; the gyroscope rotates the 3D camera;
// the floor is assumed to be camera.heightMeters below the eye.
// Limitation (documented): phone translation is not tracked, so walking
// around makes the character slide. Use WebXR mode for true tracking.

export class WindowMode {
  constructor({ renderer, camera, lineArt, character, grounding, dom, depth, toast }) {
    Object.assign(this, { renderer, camera, lineArt, character, grounding, dom, depth, toast });
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');
    // iOS Safari only decodes frames reliably for videos attached to the page.
    Object.assign(this.video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', top: '0', left: '0' });
    document.body.appendChild(this.video);
    this.hasGyro = false;
    this.placed = false;
    this.manual = { yaw: 0, pitch: THREE.MathUtils.degToRad(-22) };
  }

  async start(cfg) {
    this.cfg = cfg;
    await this.requestGyro();
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error('insecure context'), { name: 'InsecureContext' });
      }
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
      this.cameraError = e.name || 'Error';
      this.texture = renderDemoRoom(this.renderer, { fovLongSideDeg: cfg.camera.fovLongSideDeg, eyeHeight: cfg.camera.heightMeters });
      this.noCamera = true;
    }
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.bindInput();
    this.applyConfig(cfg);
    if (cfg.depth.enabled) this.depth?.start(cfg);
    return { noCamera: !!this.noCamera, cameraError: this.cameraError, gyro: this.hasGyro, video: [this.video.videoWidth, this.video.videoHeight] };
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
    this.lineArt.setSource(this.texture, { uvScale: fit.uvScale, uvOffset: fit.uvOffset, mirror, size: [w, h] });
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
    if (!hit) return;
    // With depth, refuse taps on furniture / walls: only detected floor is walkable.
    if (this.cfg.depth.enabled && this.cfg.depth.tapRequiresFloor) {
      const onFloor = this.depth?.isFloorAt((ndc.x + 1) / 2, (ndc.y + 1) / 2);
      if (onFloor === false) return this.toast?.('That spot is not floor');
    }
    this.userMoved = true;
    this.character.walkTo(new THREE.Vector3(...hit));
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
    if (this.cfg.depth.enabled) {
      this.depth?.tick(this.lineArt.source, this.camera, this.cfg.camera.heightMeters);
      this.depth?.updateUniforms(this.camera);
      // First valid depth: if the character landed on furniture, move it to real floor.
      if (this.depth?.valid && !this.floorChecked && !this.userMoved) {
        this.floorChecked = true;
        this.moveToFloor();
      }
    }
  }

  /** Nearest detected-floor point along the view direction (closer first). */
  moveToFloor() {
    const p = this.character.root.position;
    const v = p.clone().project(this.camera);
    if (this.depth.isFloorAt((v.x + 1) / 2, (v.y + 1) / 2)) return;
    const eye = new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
    const dir = p.clone().sub(eye).setY(0).normalize();
    for (let d = 0.8; d <= this.cfg.depth.maxFloorDistance; d += 0.2) {
      const q = eye.clone().addScaledVector(dir, d);
      const s = q.clone().project(this.camera);
      if (Math.abs(s.x) > 1 || Math.abs(s.y) > 1) continue;
      if (this.depth.isFloorAt((s.x + 1) / 2, (s.y + 1) / 2)) {
        this.character.walkTo(q);
        return;
      }
    }
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
    this.depth?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.remove();
    if (this.onOrient) window.removeEventListener('deviceorientation', this.onOrient);
  }
}
