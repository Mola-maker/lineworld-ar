import test from 'node:test';
import assert from 'node:assert/strict';
import { floorDepth, fitAffine, analyseDepth, rotate } from '../src/depth/floor.js';

// Camera 1.35 m high, pitched down 22° (quaternion about X).
const pitch = (-22 * Math.PI) / 180;
const cam = { quaternion: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)], tanY: Math.tan(0.35), tanX: Math.tan(0.35) * 1.6, height: 1.35 };

let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('rotate: identity and 90° about Y', () => {
  assert.deepEqual(rotate([0, 0, 0, 1], [1, 2, 3]), [1, 2, 3]);
  const h = Math.SQRT1_2, r = rotate([0, h, 0, h], [0, 0, -1]);
  assert.ok(Math.abs(r[0] + 1) < 1e-9 && Math.abs(r[2]) < 1e-9);
});

test('floorDepth: centre ray of a pitched camera', () => {
  const z = floorDepth(0.5, 0.5, cam);
  const expected = 1.35 / Math.sin(22 * Math.PI / 180); // along the optical axis
  assert.ok(Math.abs(z - expected) < 1e-6, `${z} vs ${expected}`);
  assert.equal(floorDepth(0.5, 1.0, { ...cam, quaternion: [0, 0, 0, 1] }), 0, 'above horizon → no floor');
});

test('fitAffine recovers a,b with 30% outliers', () => {
  const s = [];
  for (let i = 0; i < 200; i++) {
    const d = rng();
    const invZ = 0.8 * d + 0.1;
    s.push(i % 10 < 3 ? { d, invZ: invZ * (1.5 + rng()) } : { d, invZ });
  }
  const f = fitAffine(s, { rng });
  assert.ok(Math.abs(f.a - 0.8) < 1e-3 && Math.abs(f.b - 0.1) < 1e-3);
  assert.ok(f.ratio > 0.65 && f.ratio < 0.75);
});

test('analyseDepth: synthetic floor + box → metric depth and floor mask', () => {
  const w = 64, h = 40, disp = new Float32Array(w * h);
  const truthZ = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
    let z = floorDepth(u, v, cam) || 9;
    const box = x > 40 && x < 56 && y > 22 && y < 36; // something standing in front
    if (box) z = Math.min(z, 1.6);
    truthZ[y * w + x] = z;
    disp[y * w + x] = 3 * (1 / z) - 0.2; // unknown affine transform of inverse depth
  }
  const r = analyseDepth(disp, w, h, cam, { sampleStep: 2, rng });
  assert.ok(r.fit, 'fit found');
  const i = 30 * w + 20, j = 30 * w + 48;
  assert.ok(Math.abs(r.metric[i] - truthZ[i]) / truthZ[i] < 0.02, 'floor metric');
  assert.ok(Math.abs(r.metric[j] - 1.6) < 0.05, `box metric ${r.metric[j]}`);
  assert.equal(r.floor[i], 1);
  assert.equal(r.floor[j], 0);
});
