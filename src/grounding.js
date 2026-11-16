import * as THREE from 'three';

// Everything that makes the character read as standing ON the floor:
//  1. shadow catcher  – invisible floor that only shows the real cast shadow
//  2. contact shadow  – soft dark blob under the feet (works even when shadow maps are off)
//  3. sun light that follows the character with a tight shadow frustum (crisp, cheap)
//  4. reticle         – shows where the floor was detected before placing
// Floor height comes from the active mode: WebXR hit-test, or y=0 in window mode.

export class Grounding {
  constructor(scene) {
    this.floor = new THREE.Group();
    scene.add(this.floor);

    this.catcherMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), this.catcherMat);
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.receiveShadow = true;
    this.floor.add(this.catcher);

    this.contactMat = new THREE.MeshBasicMaterial({
      map: radialTexture(), transparent: true, depthWrite: false, color: 0x000000,
    });
    this.contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.contactMat);
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.renderOrder = 1;

    this.ambient = new THREE.HemisphereLight(0xffffff, 0x99aacc, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -1.5;
    sc.right = sc.top = 1.5;
    sc.near = 0.1;
    sc.far = 10;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.ambient, this.sun, this.sun.target);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x1b2a4a, transparent: true, opacity: 0.85 }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    scene.add(this.reticle);
  }

  /** Contact shadow is parented to the character root so it follows it for free. */
  attach(characterRoot) {
    characterRoot.add(this.contact);
    this.target = characterRoot;
  }

  applyConfig(c) {
    const g = c.grounding, l = c.lighting;
    this.catcher.visible = g.shadowCatcher;
    this.catcherMat.opacity = g.shadowOpacity;
    this.sun.castShadow = g.shadowCatcher;
    if (this.sun.shadow.mapSize.x !== g.shadowMapSize) {
      this.sun.shadow.mapSize.set(g.shadowMapSize, g.shadowMapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.contact.visible = g.contactShadow;
    this.contactMat.opacity = g.contactOpacity;
    this.contact.scale.setScalar(g.contactRadius * 2);
    this.contact.position.y = 0.002; // just above the floor, avoids z-fighting
    this.showReticle = g.showReticle;
    this.ambient.intensity = l.ambientIntensity;
    this.sun.intensity = l.sunIntensity;
    this.sunAz = THREE.MathUtils.degToRad(l.sunAzimuthDeg);
    this.sunEl = THREE.MathUtils.degToRad(l.sunElevationDeg);
  }

  setFloorHeight(y) {
    this.floor.position.y = y;
  }

  /** Light direction from WebXR light estimation, in world space. */
  setEstimatedLight(dir, intensity) {
    this.estimated = dir ? { dir: dir.clone().normalize(), intensity } : null;
  }

  update() {
    if (!this.target) return;
    const p = this.target.position;
    let dir;
    if (this.estimated) {
      dir = this.estimated.dir;
      this.sun.intensity = this.estimated.intensity;
    } else {
      dir = new THREE.Vector3(
        Math.cos(this.sunEl) * Math.sin(this.sunAz),
        Math.sin(this.sunEl),
        Math.cos(this.sunEl) * Math.cos(this.sunAz),
      );
    }
    this.sun.position.copy(p).addScaledVector(dir, 4);
    this.sun.target.position.copy(p);
  }

  setReticle(matrix) {
    if (matrix && this.showReticle) {
      this.reticle.matrix.copy(matrix);
      this.reticle.visible = true;
    } else {
      this.reticle.visible = false;
    }
  }
}

function radialTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const grd = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv);
  // Used as alpha: black colour × white-centred alpha = dark soft blob.
  return t;
}
