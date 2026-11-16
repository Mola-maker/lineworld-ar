import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solveTwoBone, findLegs, footSide, FootIK } from '../src/footik.js';

function rig() {
  const root = new THREE.Group();
  const legs = {};
  for (const [side, x] of [['Left', 0.1], ['Right', -0.1]]) {
    const hip = new THREE.Bone(); hip.name = `${side}UpLeg`; hip.position.set(x, 0.9, 0);
    const knee = new THREE.Bone(); knee.name = `${side}Leg`; knee.position.set(0, -0.42, 0.01);
    const foot = new THREE.Bone(); foot.name = `${side}Foot`; foot.position.set(0, -0.4, -0.01);
    hip.add(knee); knee.add(foot); root.add(hip);
    legs[side] = { hip, knee, foot };
  }
  root.updateMatrixWorld(true);
  return { root, legs };
}

test('footSide recognises common rig conventions', () => {
  for (const n of ['mixamorig:LeftFoot', 'FootL', 'foot.L', 'J_Bip_L_Foot', 'leftFoot']) assert.equal(footSide(n), 'left', n);
  for (const n of ['mixamorig:RightFoot', 'FootR', 'foot.R', 'J_Bip_R_Foot']) assert.equal(footSide(n), 'right', n);
  for (const n of ['LeftToeBase', 'foot_ik.L', 'Hips', 'LeftHand']) assert.equal(footSide(n), null, n);
});

test('findLegs builds hip › knee › foot chains', () => {
  const { root } = rig();
  const legs = findLegs(root);
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((l) => l.knee.name), ['LeftLeg', 'RightLeg']);
});

test('solveTwoBone reaches a reachable target and keeps foot orientation', () => {
  const { root, legs } = rig();
  const leg = legs.Left;
  leg.foot.quaternion.setFromEuler(new THREE.Euler(0.2, 0, 0)); root.updateMatrixWorld(true);
  const footQ = leg.foot.getWorldQuaternion(new THREE.Quaternion());
  const target = new THREE.Vector3(0.15, 0.25, 0.2);
  const err = solveTwoBone(leg, target, new THREE.Vector3(1, 0, 0));
  assert.ok(err < 1e-4, `residual ${err}`);
  assert.ok(leg.foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(footQ) < 1e-4);
});

test('FootIK dynamic grounding pulls floating feet down to the floor', () => {
  const { root } = rig();
  const pivot = new THREE.Group(); root.parent = null;
  const scene = new THREE.Group(); scene.add(pivot); pivot.add(root);
  scene.updateMatrixWorld(true);
  const ik = new FootIK();
  ik.setup(root, scene, {});
  const cfg = { enabled: true, dynamicGrounding: true, maxCorrection: 0.06, footLock: false, contactHeight: 0.03, releaseDistance: 0.15, blendTime: 0.1 };
  // Animation lifts the whole body 3 cm (e.g. a bouncy idle).
  root.position.y = 0.03;
  for (let i = 0; i < 60; i++) { ik.preUpdate(); ik.update(1 / 30, cfg, pivot, 0, 0); }
  const footY = Math.min(...['LeftFoot', 'RightFoot'].map((n) => root.getObjectByName(n).getWorldPosition(new THREE.Vector3()).y));
  assert.ok(Math.abs(footY - 0.08) < 0.003, `ankle at ${footY}`); // ankle height in bind pose = 0.9-0.42-0.4
  // A 30 cm jump must not be pulled down.
  root.position.y = 0.3;
  for (let i = 0; i < 60; i++) ik.update(1 / 30, cfg, pivot, 0, 0);
  assert.ok(Math.abs(pivot.position.y) < 0.01);
});
