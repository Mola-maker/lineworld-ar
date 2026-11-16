import * as THREE from 'three';

// A tiny procedural traveller (scarf, coat, messy hair) used when no GLB is
// configured or it fails to load. Built to the same contract the art team must
// follow: meters, origin between the feet, facing +Z, ~0.9 m tall.
// Idle motion never moves the feet, so it cannot look like it floats.

export function buildPlaceholder() {
  const g = new THREE.Group();
  g.name = 'placeholder';
  const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const add = (geo, m, x, y, z, parent = g) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  const coat = mat('#3f7d5a'), skin = mat('#f2d2b6'), hair = mat('#f2c53d');
  const boots = mat('#2f3b55'), scarf = mat('#e8b13a');

  add(new THREE.BoxGeometry(0.09, 0.06, 0.15), boots, -0.06, 0.03, 0.02);
  add(new THREE.BoxGeometry(0.09, 0.06, 0.15), boots, 0.06, 0.03, 0.02);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.26), coat, -0.06, 0.19, 0);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.26), coat, 0.06, 0.19, 0);

  // Upper body pivots at the hips so breathing never lifts the feet.
  const upper = new THREE.Group();
  upper.position.y = 0.32;
  g.add(upper);
  add(new THREE.CylinderGeometry(0.11, 0.16, 0.3, 12), coat, 0, 0.15, 0, upper);
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.26), coat, -0.15, 0.14, 0, upper).rotation.z = 0.25;
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.26), coat, 0.15, 0.14, 0, upper).rotation.z = -0.25;
  const head = add(new THREE.SphereGeometry(0.12, 20, 16), skin, 0, 0.42, 0, upper);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const spike = add(new THREE.ConeGeometry(0.04, 0.12, 6), hair, Math.cos(a) * 0.07, 0.1, Math.sin(a) * 0.07, head);
    spike.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
  }
  const eye = mat('#1b2a4a');
  add(new THREE.SphereGeometry(0.014, 8, 6), eye, -0.04, 0.01, 0.11, head);
  add(new THREE.SphereGeometry(0.014, 8, 6), eye, 0.04, 0.01, 0.11, head);
  add(new THREE.SphereGeometry(0.105, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 0.03, -0.01, head);
  add(new THREE.TorusGeometry(0.1, 0.03, 8, 20), scarf, 0, 0.31, 0, upper).rotation.x = Math.PI / 2;
  const tail = new THREE.Group();
  tail.position.set(0.05, 0.31, -0.08);
  upper.add(tail);
  add(new THREE.BoxGeometry(0.06, 0.02, 0.32), scarf, 0, 0, -0.16, tail);

  let t = 0;
  const update = (dt, walking) => {
    t += dt;
    upper.scale.y = 1 + Math.sin(t * 2.2) * 0.012;       // breathing
    head.rotation.y = Math.sin(t * 0.5) * 0.25;           // looking around
    tail.rotation.y = Math.sin(t * (walking ? 6 : 1.4)) * (walking ? 0.5 : 0.25); // scarf in the wind
    tail.rotation.x = 0.25 + Math.sin(t * 1.1) * 0.08;
    upper.rotation.z = walking ? Math.sin(t * 9) * 0.05 : 0;
  };
  return { group: g, update };
}
