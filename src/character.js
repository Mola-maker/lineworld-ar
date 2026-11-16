import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fitHeight, groundOffset } from './math.js';
import { buildPlaceholder } from './placeholder.js';

// Hierarchy:
//   root      ← placed on the floor (position = foot point, rotation.y = facing)
//   └ pivot   ← uniform scale to the configured height + vertical ground offset
//     └ model ← the untouched glTF scene (or the placeholder)
// Keeping placement, normalisation and asset separate means a new model from
// the art team drops in without touching any placement code.

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

export class Character {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'character-root';
    this.root.visible = false; // shown once placed on a floor
    this.pivot = new THREE.Group();
    this.root.add(this.pivot);
    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.current = null;
    this.target = null;   // walk destination (Vector3) or null
    this.outlines = [];
    this.info = { source: '', clips: [], height: 0, triangles: 0, warnings: [] };
    this.placeholderUpdate = null;
  }

  async load(url, cfg) {
    let gltf = null;
    if (url) {
      try {
        gltf = await loader.loadAsync(url);
      } catch (e) {
        console.warn('[character] load failed, using placeholder:', e);
      }
    }
    this.dispose();
    if (gltf) {
      this.model = gltf.scene;
      this.info.source = url.startsWith('blob:') ? 'local file' : url;
      this.mixer = new THREE.AnimationMixer(this.model);
      this.clips = gltf.animations;
    } else {
      const p = buildPlaceholder();
      this.model = p.group;
      this.placeholderUpdate = p.update;
      this.info.source = 'built-in placeholder';
      this.mixer = null;
      this.clips = [];
    }
    this.pivot.add(this.model);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // skinned bounds are often wrong in exported files
        o.userData.originalMaterial = o.material;
      }
    });
    this.info.clips = this.clips.map((c) => c.name);
    this.applyConfig(cfg, { reload: true });
    return this.info;
  }

  dispose() {
    this.mixer?.stopAllAction();
    if (this.model) this.pivot.remove(this.model);
    for (const o of this.outlines) o.removeFromParent();
    this.outlines = [];
    this.model = null;
    this.actions = {};
    this.current = null;
    this.placeholderUpdate = null;
  }

  /** Re-normalise size/ground and restyle. Cheap enough to run on every panel edit. */
  applyConfig(cfg, { reload = false } = {}) {
    if (!this.model) return;
    const c = cfg.character;
    this.cfg = c;

    // Measure the bind pose (precise = skinned vertex positions, not loose bounds).
    this.pivot.scale.setScalar(1);
    this.pivot.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const box = new THREE.Box3().setFromObject(this.model, true).applyMatrix4(inv);
    const size = box.getSize(new THREE.Vector3());
    const s = c.heightMeters > 0 ? fitHeight(size.y, c.heightMeters) : 1;
    this.pivot.scale.setScalar(s);
    const minY = c.autoGround ? box.min.y * s : 0;
    this.pivot.position.y = groundOffset(minY, c.footOffset);

    this.info.height = +(size.y * s).toFixed(3);
    this.info.rawHeight = +size.y.toFixed(3);
    this.info.triangles = countTriangles(this.model);
    this.info.warnings = checkModel(this.model, box, this.clips, c);

    this.setStyle(c, s);
    if (reload) this.buildActions(c);
    this.play('idle', 0);
  }

  buildActions(c) {
    this.actions = {};
    if (!this.mixer) return;
    for (const [logical, clipName] of Object.entries(c.animations)) {
      const clip = THREE.AnimationClip.findByName(this.clips, clipName);
      if (clip) this.actions[logical] = this.mixer.clipAction(clip);
    }
    // Fall back to the first clip as idle so something always moves.
    if (!this.actions.idle && this.clips[0]) this.actions.idle = this.mixer.clipAction(this.clips[0]);
  }

  play(name, fade = this.cfg?.crossFade ?? 0.25) {
    const next = this.actions[name];
    if (!next || next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (name === 'wave') {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      const done = (e) => {
        if (e.action !== next) return;
        this.mixer.removeEventListener('finished', done);
        this.play('idle');
      };
      this.mixer.addEventListener('finished', done);
    }
    this.current?.fadeOut(fade);
    this.current = next;
  }

  setStyle(c, scale) {
    for (const o of this.outlines) o.removeFromParent();
    this.outlines = [];
    const steps = makeGradient(c.toonSteps);
    this.model.traverse((o) => {
      if (!o.isMesh || o.userData.isOutline) return;
      const orig = o.userData.originalMaterial;
      if (c.style === 'original') {
        o.material = orig;
        return;
      }
      const toMats = (m) => {
        const t = new THREE.MeshToonMaterial({
          color: m.color ?? 0xffffff,
          map: m.map ?? null,
          gradientMap: steps,
          transparent: m.transparent,
          opacity: m.opacity,
          alphaTest: m.alphaTest,
          side: m.side,
        });
        return t;
      };
      o.material = Array.isArray(orig) ? orig.map(toMats) : toMats(orig);
      if (c.outlineWidth > 0) this.outlines.push(makeOutline(o, c.outlineColor, c.outlineWidth));
    });
  }

  /** Place feet at a world point, optionally facing a world position. */
  placeAt(point, lookAt) {
    this.root.position.copy(point);
    this.target = null;
    if (lookAt && this.cfg?.faceViewer) this.face(lookAt);
    this.root.visible = true;
  }

  face(point) {
    const dx = point.x - this.root.position.x;
    const dz = point.z - this.root.position.z;
    if (dx * dx + dz * dz > 1e-6) this.root.rotation.y = Math.atan2(dx, dz); // glTF forward = +Z
  }

  walkTo(point) {
    this.target = point.clone();
    this.target.y = this.root.position.y; // stay on the same floor
    this.face(this.target);
    this.play(this.actions.walk ? 'walk' : 'idle');
  }

  wave() {
    if (this.actions.wave) this.play('wave');
  }

  update(dt, viewer) {
    this.mixer?.update(dt);
    this.placeholderUpdate?.(dt, !!this.target);
    if (this.target) {
      const p = this.root.position;
      const d = this.target.clone().sub(p);
      const step = (this.cfg?.walkSpeed ?? 0.7) * dt;
      if (d.length() <= step) {
        p.copy(this.target);
        this.target = null;
        this.play('idle');
        if (viewer && this.cfg?.faceViewer) this.face(viewer);
      } else {
        p.addScaledVector(d.normalize(), step);
      }
    }
  }
}

function makeGradient(steps) {
  const n = Math.max(2, steps | 0);
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(90 + (165 * i) / (n - 1));
    data.set([v, v, v, 255], i * 4);
  }
  const t = new THREE.DataTexture(data, n, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

// Inverted-hull outline: a back-face copy pushed out along the (skinned) normal.
function makeOutline(mesh, color, width) {
  // Lambert skins its normals, so the push follows the animated surface.
  // The push happens in view space, so the width is in real meters whatever
  // scale the asset's node hierarchy uses.
  // Black diffuse + emissive = flat ink colour, unaffected by lights.
  const mat = new THREE.MeshLambertMaterial({ color: 0x000000, emissive: color, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float outlineWidth;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.xyz += normalize(transformedNormal) * outlineWidth;\ngl_Position = projectionMatrix * mvPosition;');
  };
  mat.customProgramCacheKey = () => `outline-${width.toFixed(5)}`;
  let o;
  if (mesh.isSkinnedMesh) {
    o = new THREE.SkinnedMesh(mesh.geometry, mat);
    o.bind(mesh.skeleton, mesh.bindMatrix);
  } else {
    o = new THREE.Mesh(mesh.geometry, mat);
  }
  o.morphTargetInfluences = mesh.morphTargetInfluences;
  o.morphTargetDictionary = mesh.morphTargetDictionary;
  o.position.copy(mesh.position);
  o.quaternion.copy(mesh.quaternion);
  o.scale.copy(mesh.scale);
  o.frustumCulled = false;
  o.userData.isOutline = true;
  mesh.parent.add(o);
  return o;
}

function countTriangles(root) {
  let n = 0;
  root.traverse((o) => {
    if (o.isMesh && !o.userData.isOutline) {
      const g = o.geometry;
      n += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return Math.round(n);
}

/** Checks that map 1:1 to docs/CHARACTER_SPEC.md so the art team gets actionable feedback. */
function checkModel(root, box, clips, c) {
  const w = [];
  const tol = Math.max(0.01, (box.max.y - box.min.y) * 0.02);
  if (Math.abs(box.min.y) > tol) w.push(`Origin is not at the feet: lowest point y=${box.min.y.toFixed(3)} (spec §3.2)`);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  if (Math.hypot(cx, cz) > (box.max.y - box.min.y) * 0.25) w.push('Model is not centred on the origin in X/Z (spec §3.2)');
  const h = box.max.y - box.min.y;
  if (h > 0 && (h < 0.05 || h > 5)) w.push(`Height ${h.toFixed(2)} looks like the wrong unit; export in meters (spec §3.1)`);
  for (const [logical, name] of clips.length ? Object.entries(c.animations) : []) {
    if (!clips.some((k) => k.name === name)) w.push(`Missing clip "${name}" for ${logical} (spec §5)`);
  }
  for (const clip of clips) {
    const rootPos = clip.tracks.find((t) => /(hips|root|pelvis)[^.]*\.position$/i.test(t.name));
    if (rootPos && /idle|walk/i.test(clip.name)) {
      const v = rootPos.values;
      const dx = v[v.length - 3] - v[0], dz = v[v.length - 1] - v[2];
      if (Math.hypot(dx, dz) > h * 0.2) w.push(`Clip "${clip.name}" moves the root; export in-place (spec §5.2)`);
    }
  }
  let tris = 0;
  root.traverse((o) => { if (o.isMesh) tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  if (tris > 60000) w.push(`${Math.round(tris)} triangles; mobile budget is ≤ 30k (spec §4)`);
  return w;
}
