// Pure helpers (no DOM, no three) so they can be unit-tested in Node.

const DEG = Math.PI / 180;

/**
 * The camera image is shown "cover"-fitted to the screen. Work out the
 * vertical FOV the 3D camera needs so virtual objects line up with the video,
 * and the UV scale/offset the background shader uses for the crop.
 */
export function coverFit({ videoW, videoH, screenW, screenH, fovLongSideDeg }) {
  const va = videoW / videoH;
  const sa = screenW / screenH;
  // Focal length in "video pixels" from the long-side FOV.
  const long = Math.max(videoW, videoH);
  const f = long / 2 / Math.tan((fovLongSideDeg * DEG) / 2);
  // Visible part of the video after cover-fit.
  let visW = videoW, visH = videoH;
  if (sa > va) visH = videoW / sa; // screen wider: crop top/bottom
  else visW = videoH * sa;         // screen taller: crop left/right
  const vFovDeg = (2 * Math.atan(visH / 2 / f)) / DEG;
  const uvScale = [visW / videoW, visH / videoH];
  const uvOffset = [(1 - uvScale[0]) / 2, (1 - uvScale[1]) / 2];
  return { vFovDeg, uvScale, uvOffset };
}

/** Scale factor that makes a model of `currentHeight` stand `targetHeight` tall. */
export function fitHeight(currentHeight, targetHeight) {
  if (!(targetHeight > 0) || !(currentHeight > 0)) return 1;
  return targetHeight / currentHeight;
}

/** Vertical offset that puts the lowest point (minY) on the floor plus a correction. */
export function groundOffset(minY, footOffset = 0) {
  return -minY + footOffset;
}

/**
 * Ray (origin o, direction d) against the horizontal plane y = h.
 * Returns the hit point or null when the ray points away / is parallel.
 */
export function rayToFloor(o, d, h = 0) {
  if (Math.abs(d[1]) < 1e-6) return null;
  const t = (h - o[1]) / d[1];
  if (t <= 0) return null;
  return [o[0] + d[0] * t, h, o[2] + d[2] * t];
}

/**
 * Device orientation (W3C alpha/beta/gamma, degrees) + screen angle → quaternion
 * [x,y,z,w] for a camera whose -Z looks out of the back of the phone.
 * Same math as the former three.js DeviceOrientationControls.
 */
export function orientationToQuaternion(alpha, beta, gamma, screenDeg) {
  const a = alpha * DEG, b = beta * DEG, g = gamma * DEG, o = screenDeg * DEG;
  // Euler 'YXZ' (b, a, -g)
  const c1 = Math.cos(b / 2), s1 = Math.sin(b / 2); // x
  const c2 = Math.cos(a / 2), s2 = Math.sin(a / 2); // y
  const c3 = Math.cos(-g / 2), s3 = Math.sin(-g / 2); // z
  let q = [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
  // Rotate -90° about X: camera looks out the back of the device, not the top.
  const h = Math.SQRT1_2;
  q = mul(q, [-h, 0, 0, h]);
  // Adjust for screen orientation about Z.
  q = mul(q, [0, 0, Math.sin(-o / 2), Math.cos(-o / 2)]);
  return q;
}

function mul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
