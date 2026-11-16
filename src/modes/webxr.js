import * as THREE from 'three';
import { XREstimatedLight } from 'three/examples/jsm/webxr/XREstimatedLight.js';

// Tracked AR via WebXR (Chrome on Android with ARCore, Quest browser).
//  - hit-test finds real floor/table surfaces → character feet sit on them
//  - camera-access gives the raw camera frame → line-art backdrop
//    (without it, the real passthrough shows and only the character is drawn)
//  - light-estimation steers the shadow-casting light to match the room

export async function xrSupported() {
  try {
    return !!(await navigator.xr?.isSessionSupported('immersive-ar'));
  } catch {
    return false;
  }
}

export class XRMode {
  constructor({ renderer, scene, camera, lineArt, character, grounding, overlay, onEnd }) {
    Object.assign(this, { renderer, scene, camera, lineArt, character, grounding, overlay, onEnd });
    this.placed = false;
    this.hitSource = null;
    this.lastHit = null;
  }

  async start(cfg) {
    this.cfg = cfg;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['camera-access', 'light-estimation', 'dom-overlay', 'local-floor'],
      domOverlay: { root: this.overlay },
    });
    this.session = session;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    await this.renderer.xr.setSession(session);

    const viewer = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewer });
    this.cameraAccess = !!session.enabledFeatures?.includes('camera-access');

    if (cfg.lighting.useXREstimation) {
      this.xrLight = new XREstimatedLight(this.renderer, false);
      this.xrLight.addEventListener('estimationstart', () => {
        this.estimating = true;
        this.xrLight.directionalLight.visible = false; // our own sun casts the shadow
      });
      this.xrLight.addEventListener('estimationend', () => {
        this.estimating = false;
        this.grounding.setEstimatedLight(null);
      });
      this.scene.add(this.xrLight);
    }

    session.addEventListener('select', () => this.select());
    session.addEventListener('end', () => this.end());
    this.character.root.visible = false;
    this.lineArt.setSource(null);
    return { cameraAccess: this.cameraAccess };
  }

  applyConfig(cfg) {
    this.cfg = cfg;
  }

  select() {
    if (!this.lastHit) return;
    const p = new THREE.Vector3().setFromMatrixPosition(this.lastHit);
    const cam = this.renderer.xr.getCamera();
    const viewerOnFloor = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    viewerOnFloor.y = p.y;
    this.grounding.setFloorHeight(p.y);
    if (!this.placed) {
      this.character.placeAt(p, viewerOnFloor);
      this.placed = true;
    } else {
      // Tap near the character → wave; elsewhere → walk there.
      const near = p.distanceTo(this.character.root.position) < 0.25;
      if (near) this.character.wave();
      else this.character.walkTo(p);
    }
  }

  /** Called from the render loop with the XRFrame. */
  update(frame) {
    if (!frame) return;
    const ref = this.renderer.xr.getReferenceSpace();
    const hits = frame.getHitTestResults(this.hitSource);
    const pose = hits[0]?.getPose(ref);
    this.lastHit = pose ? new THREE.Matrix4().fromArray(pose.transform.matrix) : null;
    this.grounding.setReticle(this.lastHit);

    if (this.cameraAccess) {
      const viewerPose = frame.getViewerPose(ref);
      const view = viewerPose?.views[0];
      const tex = view?.camera && this.renderer.xr.getCameraTexture(view.camera);
      if (tex) this.lineArt.setSource(tex, { flipY: !!this.cfg.camera.xrFlipY });
    }

    if (this.estimating && this.xrLight) {
      const d = this.xrLight.directionalLight;
      this.grounding.setEstimatedLight(d.position, d.intensity);
    }
  }

  end() {
    this.hitSource?.cancel();
    this.hitSource = null;
    this.xrLight?.removeFromParent();
    this.grounding.setReticle(null);
    this.grounding.setEstimatedLight(null);
    this.lineArt.setSource(null);
    this.renderer.xr.enabled = false;
    this.onEnd?.();
  }
}
