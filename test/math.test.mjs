import test from 'node:test';
import assert from 'node:assert/strict';
import { coverFit, fitHeight, groundOffset, rayToFloor, orientationToQuaternion } from '../src/math.js';
import { deepMerge, diff, DEFAULTS } from '../src/config.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('coverFit: same aspect keeps full frame and the long-side FOV', () => {
  const r = coverFit({ videoW: 1280, videoH: 720, screenW: 1280, screenH: 720, fovLongSideDeg: 68 });
  assert.deepEqual(r.uvScale, [1, 1]);
  // vertical FOV of a 16:9 frame with 68° horizontal
  close(r.vFovDeg, 2 * Math.atan(Math.tan((34 * Math.PI) / 180) * 720 / 1280) * 180 / Math.PI);
});

test('coverFit: portrait phone crops the sides of a landscape stream', () => {
  const r = coverFit({ videoW: 1280, videoH: 720, screenW: 390, screenH: 844, fovLongSideDeg: 68 });
  assert.ok(r.uvScale[0] < 1 && r.uvScale[1] === 1);
  close(r.uvOffset[0], (1 - r.uvScale[0]) / 2);
});

test('fitHeight / groundOffset', () => {
  close(fitHeight(1.8, 0.9), 0.5);
  assert.equal(fitHeight(0, 1), 1);
  assert.equal(fitHeight(2, 0), 1);
  close(groundOffset(-0.12, 0), 0.12);
  close(groundOffset(0.3, -0.01), -0.31);
});

test('rayToFloor', () => {
  assert.deepEqual(rayToFloor([0, 1.5, 0], [0, -1, -1], 0), [0, 0, -1.5]);
  assert.equal(rayToFloor([0, 1.5, 0], [0, 1, 0], 0), null);
  assert.equal(rayToFloor([0, 1.5, 0], [1, 0, 0], 0), null);
});

test('orientationToQuaternion: phone upright facing north looks at the horizon', () => {
  // beta=90: device upright; camera -Z should be horizontal.
  const [x, y, z, w] = orientationToQuaternion(0, 90, 0, 0);
  // rotate (0,0,-1) by q
  const v = [0, 0, -1];
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  const ry = iy * w + iw * -y + iz * -x - ix * -z;
  close(ry, 0);
  close(Math.hypot(x, y, z, w), 1);
});

test('config deepMerge/diff round-trip', () => {
  const over = { lineArt: { threshold: 0.3 }, character: { animations: { idle: 'Breath' } } };
  const merged = deepMerge(DEFAULTS, over);
  assert.equal(merged.lineArt.threshold, 0.3);
  assert.equal(merged.lineArt.lineColor, DEFAULTS.lineArt.lineColor);
  assert.equal(merged.character.animations.walk, DEFAULTS.character.animations.walk);
  assert.deepEqual(diff(DEFAULTS, merged), over);
  assert.equal(DEFAULTS.lineArt.threshold, 0.18, 'defaults untouched');
});
