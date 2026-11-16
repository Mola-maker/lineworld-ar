// Pure maths for turning a *relative* depth map into metric depth + a floor mask.
//
// Depth Anything V2 (relative) predicts affine-invariant disparity d:
//     1/z = a·d + b     for unknown a > 0, b
// In window mode we know the camera orientation (gyro) and assume its height
// above the floor, so every pixel whose ray hits the floor has a *predicted*
// floor depth. Pixels that really are floor satisfy the affine relation;
// RANSAC finds (a, b) from those, which
//   1. turns the whole map into meters (for occlusion), and
//   2. labels which pixels are floor (where the character may walk).

/**
 * Camera-space ray (z = -1 plane) for a uv in [0,1]² with tangent half-angles.
 * Returns [x, y, -1].
 */
export function uvToRay(u, v, tanX, tanY) {
  return [(u * 2 - 1) * tanX, (v * 2 - 1) * tanY, -1];
}

/** Rotate a vector by quaternion [x,y,z,w]. */
export function rotate(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

/**
 * Planar depth (along the camera's forward axis) at which the camera ray for
 * (u,v) meets the floor y = 0, or 0 when it does not (looking up, too far).
 */
export function floorDepth(u, v, cam, maxDist = 8) {
  const r = uvToRay(u, v, cam.tanX, cam.tanY); // z component = -1 → planar
  const w = rotate(cam.quaternion, r);
  if (w[1] >= -1e-4) return 0;
  const t = cam.height / -w[1]; // ray parameter; since r.z = -1, t is the planar depth
  const dist = t * Math.hypot(w[0], w[1], w[2]);
  return dist > maxDist ? 0 : t;
}

/**
 * Fit 1/z = a·d + b on floor candidates with RANSAC.
 * samples: [{ d, invZ }] ; returns { a, b, inliers, ratio } or null.
 */
export function fitAffine(samples, { iterations = 80, tol = 0.12, minInliers = 12, rng = Math.random } = {}) {
  const n = samples.length;
  if (n < minInliers) return null;
  const isIn = (a, b, s) => Math.abs(a * s.d + b - s.invZ) <= tol * s.invZ;
  let best = null;
  for (let i = 0; i < iterations; i++) {
    const p = samples[(rng() * n) | 0], q = samples[(rng() * n) | 0];
    if (Math.abs(p.d - q.d) < 1e-6) continue;
    const a = (p.invZ - q.invZ) / (p.d - q.d);
    if (!(a > 0)) continue; // closer = larger disparity
    const b = p.invZ - a * p.d;
    let count = 0;
    for (const s of samples) if (isIn(a, b, s)) count++;
    if (!best || count > best.count) best = { a, b, count };
  }
  if (!best || best.count < minInliers) return null;
  // Least-squares refinement on the inliers.
  const inl = samples.filter((s) => isIn(best.a, best.b, s));
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of inl) { sx += s.d; sy += s.invZ; sxx += s.d * s.d; sxy += s.d * s.invZ; }
  const m = inl.length, den = m * sxx - sx * sx;
  let { a, b } = best;
  if (Math.abs(den) > 1e-12) {
    const a2 = (m * sxy - sx * sy) / den;
    if (a2 > 0) { a = a2; b = (sy - a2 * sx) / m; }
  }
  return { a, b, inliers: inl.length, ratio: inl.length / n };
}

/**
 * Whole pipeline for one depth frame.
 * disp: Float32Array (w*h, row 0 = top), cam: { quaternion, tanX, tanY, height }
 * Returns { metric: Float32Array (m, 0 = unknown), floor: Uint8Array, fit }.
 */
export function analyseDepth(disp, w, h, cam, opts = {}) {
  const step = opts.sampleStep ?? 6;
  const tol = opts.tol ?? 0.12;
  // Normalise disparity to 0..1 so tolerances are model-independent.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < disp.length; i++) { const d = disp[i]; if (d < lo) lo = d; if (d > hi) hi = d; }
  const span = hi - lo || 1;
  const nd = new Float32Array(disp.length);
  for (let i = 0; i < disp.length; i++) nd[i] = (disp[i] - lo) / span;

  const samples = [];
  for (let y = step >> 1; y < h; y += step) {
    for (let x = step >> 1; x < w; x += step) {
      const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
      const z = floorDepth(u, v, cam, opts.maxFloorDist);
      if (z > 0.2) samples.push({ d: nd[y * w + x], invZ: 1 / z });
    }
  }
  const fit = fitAffine(samples, { tol, minInliers: opts.minInliers ?? 12, rng: opts.rng });
  const metric = new Float32Array(w * h);
  const floor = new Uint8Array(w * h);
  if (!fit) return { metric, floor, norm: nd, fit: null };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inv = fit.a * nd[i] + fit.b;
      metric[i] = inv > 1e-3 ? 1 / inv : 0;
      const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h;
      const zf = floorDepth(u, v, cam, opts.maxFloorDist);
      if (zf > 0 && Math.abs(inv - 1 / zf) <= tol * (1 / zf)) floor[i] = 1;
    }
  }
  return { metric, floor, norm: nd, fit };
}
