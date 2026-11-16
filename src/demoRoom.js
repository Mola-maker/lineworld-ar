import * as THREE from 'three';

// Stand-in "camera image" when no webcam is available: a small room rendered
// once with the same camera height / FOV the app assumes. Because it has real
// geometry (floor, walls, a crate in front of the character) it exercises the
// depth model, floor detection and occlusion exactly like a real room would.

export function renderDemoRoom(renderer, { width = 1280, height = 720, fovLongSideDeg = 68, eyeHeight = 1.35, pitchDeg = -22 } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#cfd6dc');
  const vfov = (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fovLongSideDeg) / 2) * height / width)) * 180 / Math.PI;
  const cam = new THREE.PerspectiveCamera(vfov, width / height, 0.05, 50);
  cam.position.set(0, eyeHeight, 0);
  cam.rotation.set(THREE.MathUtils.degToRad(pitchDeg), 0, 0, 'YXZ');

  const tiles = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#b9a88c'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#8a7a62'; g.lineWidth = 6; g.strokeRect(0, 0, 256, 256);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; g.fillRect(Math.random() * 256, Math.random() * 256, 3, 3); }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(12, 12);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  })();
  const std = (color, map) => new THREE.MeshStandardMaterial({ color, map, roughness: 0.9 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), std('#ffffff', tiles));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const wall = (w, x, z, ry, color) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 3), std(color));
    m.position.set(x, 1.5, z); m.rotation.y = ry; m.receiveShadow = true; scene.add(m);
  };
  wall(8, 0, -5.5, 0, '#e3ddd2');
  wall(11, -3.5, 0, Math.PI / 2, '#d9d2c4');
  wall(11, 3.5, 0, -Math.PI / 2, '#d9d2c4');
  const box = (w, h, d, x, z, color, y = h / 2) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color));
    m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; scene.add(m); return m;
  };
  box(0.7, 0.75, 0.5, 0.3, -1.75, '#8d6e4f');             // crate in front of the character spot
  box(2.0, 0.8, 0.9, -2.4, -3.0, '#5f7d8c');              // sofa
  box(0.9, 1.8, 0.4, 2.6, -4.8, '#7a5c45');               // bookshelf
  box(1.2, 0.05, 0.7, 1.6, -2.6, '#6b5a48', 0.72);        // table top
  for (const [x, z] of [[1.1, -2.3], [2.1, -2.3], [1.1, -2.9], [2.1, -2.9]]) box(0.05, 0.7, 0.05, x, z, '#6b5a48');
  const win = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), new THREE.MeshBasicMaterial({ color: '#f5f8fb' }));
  win.position.set(-0.6, 1.8, -5.49); scene.add(win);

  scene.add(new THREE.HemisphereLight('#ffffff', '#8b7d66', 1.2));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
  sun.position.set(-2, 5, 2); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
  scene.add(sun);

  const rt = new THREE.WebGLRenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
  const xr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const px = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, px);
  renderer.setRenderTarget(null);
  renderer.xr.enabled = xr;
  rt.dispose();

  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const img = c.getContext('2d').createImageData(width, height);
  for (let y = 0; y < height; y++) img.data.set(px.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
  c.getContext('2d').putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
