import * as THREE from 'three';

// Keeps the feet on the floor at runtime, on top of whatever the animation does.
//
// 1. Dynamic grounding: every frame, shift the body so the lowest planted
//    foot touches the floor (fixes small authoring errors, idle bobbing that
//    lifts both feet, scale/offset mistakes). Bounded by maxCorrection so a
//    jump is never pulled down.
// 2. Foot locking: when a foot is in contact, pin it to the world spot where
//    it landed and bend the leg (two-bone IK) to reach it. This removes foot
//    sliding when the programmatic walk speed does not exactly match the
//    animation's stride, and keeps feet still while the body turns.
// 3. Penetration guard: a foot that would go below the floor is lifted onto it.
//
// Works with any rig whose leg chain is upper-leg → lower-leg → foot; bones are
// found by name (Mixamo, VRM, Blender "foot.L", RobotExpressive "FootL", ...).

/** 'left' | 'right' | null for a bone name that looks like a foot (not a toe / IK helper). */
export function footSide(name) {
  const n = name.toLowerCase();
  if (!n.includes('foot') || /toe|ik|target|pole|ctrl|end/.test(n)) return null;
  if (/left/.test(n) || /(^|[^a-z])l([^a-z]|$)/.test(n) || /footl$/.test(n)) return 'left';
  if (/right/.test(n) || /(^|[^a-z])r([^a-z]|$)/.test(n) || /footr$/.test(n)) return 'right';
  return null;
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export function findLegs(root, overrides = {}) {
  const legs = [];
  for (const side of ['left', 'right']) {
    let foot = null;
    const name = overrides[side];
    root.traverse((o) => {
      if (foot || o.isMesh) return;
      if (name ? o.name === name : footSide(o.name) === side) foot = o;
    });
    if (!foot) continue;
    const knee = foot.parent, hip = knee?.parent;
    if (!knee || !hip || hip === root) continue;
    legs.push({ side, foot, knee, hip, mode: 'twoBone' });
  }
  if (legs.length !== 2) return [];
  // Rigs whose feet hang directly off a shared body bone (no knees, e.g. robots
  // animated with IK in the DCC) are pinned by moving the foot itself.
  if (legs[0].knee === legs[1].knee) for (const l of legs) l.mode = 'translate';
  return legs;
}

/** Rotate `bone` so that, in world space, it is additionally rotated by q. */
function rotateWorld(bone, q) {
  bone.getWorldQuaternion(_q1);
  _q1.premultiply(q);
  bone.parent.getWorldQuaternion(_q2).invert();
  bone.quaternion.copy(_q2.multiply(_q1));
  bone.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK in world space. Moves hip+knee so the foot reaches
 * `target`; keeps the foot's world orientation. Returns the residual distance.
 */
export function solveTwoBone({ hip, knee, foot }, target, poleHint) {
  const footWorldQ = foot.getWorldQuaternion(new THREE.Quaternion());
  const H = hip.getWorldPosition(new THREE.Vector3());
  const K = knee.getWorldPosition(new THREE.Vector3());
  const A = foot.getWorldPosition(new THREE.Vector3());
  const a = H.distanceTo(K), b = K.distanceTo(A);
  const c = THREE.MathUtils.clamp(H.distanceTo(target), Math.abs(a - b) + 1e-4, a + b - 1e-4);

  // 1) knee angle (law of cosines)
  const kh = _v1.subVectors(H, K), ka = _v2.subVectors(A, K);
  const cur = kh.angleTo(ka);
  const want = Math.acos(THREE.MathUtils.clamp((a * a + b * b - c * c) / (2 * a * b), -1, 1));
  const axis = _v3.crossVectors(kh, ka);
  if (axis.lengthSq() < 1e-10) axis.copy(poleHint || new THREE.Vector3(1, 0, 0));
  axis.normalize();
  rotateWorld(knee, new THREE.Quaternion().setFromAxisAngle(axis, want - cur));

  // 2) swing the hip so hip→foot points at the target
  const A2 = foot.getWorldPosition(new THREE.Vector3());
  const from = A2.sub(H).normalize(), to = target.clone().sub(H).normalize();
  rotateWorld(hip, new THREE.Quaternion().setFromUnitVectors(from, to));

  // 3) keep the animated foot orientation (flat on the floor)
  foot.parent.getWorldQuaternion(_q2).invert();
  foot.quaternion.copy(_q2.multiply(footWorldQ));
  foot.updateMatrixWorld(true);
  return foot.getWorldPosition(new THREE.Vector3()).distanceTo(target);
}

export class FootIK {
  constructor() {
    this.legs = [];
    this.offset = 0;
    this.stats = { lockedFrames: 0, corrections: 0 };
  }

  /** Call after the model is normalised (bind pose, feet on y = 0). */
  setup(model, root, cfg) {
    this.root = root;
    this.legs = findLegs(model, cfg.bones);
    this.offset = 0;
    root.updateMatrixWorld(true);
    for (const leg of this.legs) {
      // Ankle height above the sole in the bind pose (root-local, i.e. meters).
      leg.ankleHeight = root.worldToLocal(leg.foot.getWorldPosition(new THREE.Vector3())).y;
      leg.lock = null;
      leg.weight = 0;
      leg.rest = [leg.hip, leg.knee, leg.foot].map((b) => b.quaternion.clone());
      leg.restPos = leg.foot.position.clone();
    }
    return this.legs.map((l) => (l.mode === 'translate'
      ? `${l.side}: ${l.foot.name} (direct)`
      : `${l.side}: ${l.hip.name} › ${l.knee.name} › ${l.foot.name}`));
  }

  /**
   * Before mixer.update(): restore the leg bones' rest rotation, so bones the
   * current clip does not animate don't keep last frame's IK pose.
   */
  preUpdate() {
    for (const leg of this.legs) {
      if (leg.mode === 'translate') { leg.foot.position.copy(leg.restPos); leg.foot.quaternion.copy(leg.rest[2]); }
      else [leg.hip, leg.knee, leg.foot].forEach((b, i) => b.quaternion.copy(leg.rest[i]));
    }
  }

  /**
   * After mixer.update(). pivot = the node carrying the vertical ground offset,
   * baseY = its normal value. floorY = world floor height.
   */
  update(dt, cfg, pivot, baseY, floorY) {
    if (!cfg.enabled || !this.legs.length) {
      if (this.offset !== 0) { this.offset = 0; pivot.position.y = baseY; }
      return;
    }
    const root = this.root;
    pivot.position.y = baseY + this.offset;
    root.updateMatrixWorld(true);

    // Sole height of each foot in root space (0 = touching the floor).
    const sole = (leg) => root.worldToLocal(leg.foot.getWorldPosition(_v1)).y - leg.ankleHeight;

    // 1) dynamic grounding
    if (cfg.dynamicGrounding) {
      const lowest = Math.min(...this.legs.map(sole)) - this.offset;
      // Only correct small errors; a big gap means the animation is airborne.
      const target = Math.abs(lowest) <= cfg.maxCorrection ? -lowest : 0;
      this.offset += (target - this.offset) * Math.min(1, dt * 12);
      pivot.position.y = baseY + this.offset;
      root.updateMatrixWorld(true);
      if (Math.abs(target) > 1e-3) this.stats.corrections++;
    }

    // 2) foot locking + 3) penetration guard
    for (const leg of this.legs) {
      const h = sole(leg);
      const animated = leg.foot.getWorldPosition(new THREE.Vector3());
      const contact = cfg.footLock && h < cfg.contactHeight;
      if (contact && !leg.lock) {
        leg.lock = animated.clone();
        leg.lock.y = floorY + leg.ankleHeight; // pin exactly onto the floor
      }
      if (leg.lock) {
        const drift = Math.hypot(animated.x - leg.lock.x, animated.z - leg.lock.z);
        if (!contact || drift > cfg.releaseDistance) leg.lock = null; // lifted / stretched: let go
      }
      const blend = Math.min(1, dt / Math.max(cfg.blendTime, 1e-3));
      leg.weight += ((leg.lock ? 1 : 0) - leg.weight) * blend;

      let target = null;
      if (leg.lock && leg.weight > 0.001) {
        target = animated.clone().lerp(leg.lock, leg.weight);
        this.stats.lockedFrames++;
      } else if (h < 0) {
        target = animated.clone();
        target.y += -h; // lift out of the floor
      }
      if (target && leg.mode === 'translate') {
        leg.foot.position.copy(leg.foot.parent.worldToLocal(target));
        leg.foot.updateMatrixWorld(true);
      } else if (target) {
        const pole = new THREE.Vector3(1, 0, 0).applyQuaternion(root.getWorldQuaternion(_q1));
        solveTwoBone(leg, target, pole);
      }
    }
  }
}
