import * as THREE from 'three';
import { REPROJECT_GLSL } from './depth/depth.js';

// Turns any camera texture (VideoTexture in window mode, the WebXR raw-camera
// ExternalTexture in AR mode) into a line drawing that sits behind the 3D scene.
//
// Pass 1 (prepare): crop / mirror the source into a render target sized from
//   the *camera's* pixels (not the screen's: on a 3x phone screen the image
//   would be upscaled and every edge smeared too thin to detect).
// Pass 2+3 (blur): separable Gaussian blur of brightness at two radii.
// Pass 4 (draw): Difference-of-Gaussians line extraction (the classic
//   "line drawing" filter: clean outlines, ignores sensor noise, normalised by
//   local brightness so it also works in dim rooms), plus depth edges.
//   Drawn as a full-screen quad inside the scene, first, at the far plane,
//   so it works per-eye in WebXR without a separate compositor.

const fullscreenVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const prepareFrag = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uvScale;
  uniform vec2 uvOffset;
  uniform bool mirror;
  uniform bool flipY;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv;
    if (mirror) uv.x = 1.0 - uv.x;
    if (flipY) uv.y = 1.0 - uv.y;
    gl_FragColor = texture2D(tSrc, uv * uvScale + uvOffset);
    #include <colorspace_fragment>
  }
`;

// Separable two-radius Gaussian. First pass reads colour → perceptual brightness,
// second pass blurs the (G_small, G_large) pair from the first.
const blurFrag = /* glsl */ `
  uniform sampler2D tIn;
  uniform vec2 dir;        // one texel along x or y
  uniform float s1, s2;    // sigmas in processed pixels
  uniform bool first;
  varying vec2 vUv;
  void main() {
    float a1 = 0.0, a2 = 0.0, w1s = 0.0, w2s = 0.0;
    for (int i = -12; i <= 12; i++) {
      float x = float(i);
      float w1 = exp(-x * x / (2.0 * s1 * s1));
      float w2 = exp(-x * x / (2.0 * s2 * s2));
      vec4 t = texture2D(tIn, vUv + dir * x);
      float v1, v2;
      if (first) { v1 = v2 = pow(max(dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0), 1.0 / 2.2); }
      else { v1 = t.r; v2 = t.g; }
      a1 += v1 * w1; a2 += v2 * w2; w1s += w1; w2s += w2;
    }
    gl_FragColor = vec4(a1 / w1s, a2 / w2s, 0.0, 1.0);
  }
`;

const drawFrag = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tBlur;
  uniform int method;      // 0 = Canny-style (default), 1 = Sobel, 2 = DoG
  uniform vec2 texel;
  uniform float lineWidth, threshold, softness;
  uniform float fillAmount, fillLevels, originalMix;
  uniform float jitter, grain, time;
  uniform bool enabled, invert;
  uniform vec3 lineColor, bgColor, fillTint;
  uniform float colorEdgeWeight, depthEdgeWeight, depthThreshold;
  uniform int depthDebug;
  varying vec2 vUv;
  ${REPROJECT_GLSL}

  // Edges of the depth map: object silhouettes, independent of texture/lighting.
  float depthEdge(vec2 uv) {
    if (!depthValid || depthEdgeWeight <= 0.0) return 0.0;
    vec3 rc;
    vec2 c = reprojectUv(uv, rc);
    if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0) return 0.0;
    vec2 o = 1.0 / vec2(textureSize(tDepth, 0)) * 0.75;
    float l = texture2D(tDepth, c - vec2(o.x, 0.0)).b, r = texture2D(tDepth, c + vec2(o.x, 0.0)).b;
    float b = texture2D(tDepth, c - vec2(0.0, o.y)).b, t = texture2D(tDepth, c + vec2(0.0, o.y)).b;
    float g = length(vec2(r - l, t - b));
    return smoothstep(depthThreshold, depthThreshold * 2.0, g) * depthEdgeWeight;
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lum(vec2 uv) { return dot(texture2D(tSrc, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }

  // Gradient of the blurred brightness, relative to local brightness
  // (so a dim room gives the same lines as a bright one).
  vec2 grad(vec2 uv) {
    float l = texture2D(tBlur, uv - vec2(texel.x, 0.0)).r, r = texture2D(tBlur, uv + vec2(texel.x, 0.0)).r;
    float b = texture2D(tBlur, uv - vec2(0.0, texel.y)).r, t = texture2D(tBlur, uv + vec2(0.0, texel.y)).r;
    float m = texture2D(tBlur, uv).g;
    return vec2(r - l, t - b) / (m + 0.08);
  }

  void main() {
    vec3 src = texture2D(tSrc, vUv).rgb;

    // Low-frequency wobble: hand-drawn lines that "boil" a few times a second.
    vec2 cell = floor(vUv * 24.0);
    vec2 j = (vec2(hash(cell + time), hash(cell + time + 17.0)) - 0.5) * jitter * texel;
    vec2 uv = vUv + j;
    vec2 o = texel * lineWidth;

    float strength;
    if (method == 0) {
      // Canny-style: keep only the ridge of the gradient (non-maximum
      // suppression across the edge) → one clean stroke per outline.
      vec2 g = grad(uv);
      float m = length(g);
      vec2 n = m > 1e-5 ? g / m : vec2(0.0);
      float m1 = length(grad(uv + n * texel)), m2 = length(grad(uv - n * texel));
      strength = m * smoothstep(-0.002, 0.002, m - max(m1, m2) + 0.0005);
    } else if (method == 1) {
      float tl = lum(uv + vec2(-o.x,  o.y)), t = lum(uv + vec2(0.0,  o.y)), tr = lum(uv + vec2(o.x,  o.y));
      float l  = lum(uv + vec2(-o.x, 0.0)),                                  r  = lum(uv + vec2(o.x, 0.0));
      float bl = lum(uv + vec2(-o.x, -o.y)), b = lum(uv + vec2(0.0, -o.y)), br = lum(uv + vec2(o.x, -o.y));
      strength = length(vec2(-tl - 2.0 * l - bl + tr + 2.0 * r + br, -bl - 2.0 * b - br + tl + 2.0 * t + tr));
    } else {
      // Dark side of every edge: small blur darker than the large blur,
      // relative to local brightness.
      vec2 g = texture2D(tBlur, uv).rg;
      strength = (g.y - g.x) / (g.y + 0.08);
    }
    float edge = smoothstep(threshold, threshold + softness, strength) * colorEdgeWeight;
    edge = clamp(max(edge, depthEdge(uv)), 0.0, 1.0);

    vec3 paper = invert ? lineColor : bgColor;
    vec3 ink = invert ? bgColor : lineColor;

    float L = lum(vUv);
    float post = floor(L * fillLevels + 0.5) / max(fillLevels, 1.0);
    vec3 base = mix(paper, paper * mix(fillTint, vec3(1.0), post), fillAmount);

    vec3 col = mix(base, ink, edge);
    col = mix(col, src, originalMix);
    col += (hash(gl_FragCoord.xy + time) - 0.5) * grain;
    col = enabled ? col : src;
    if (depthDebug > 0 && depthValid) {
      vec3 rc;
      vec2 c = reprojectUv(vUv, rc);
      vec4 s = texture2D(tDepth, clamp(c, 0.0, 1.0));
      if (depthDebug == 1) col = vec3(s.b);                                   // disparity
      else if (depthDebug == 2) col = mix(col, vec3(0.1, 0.8, 0.3), s.g * 0.55); // floor mask
      else col = vec3(fract(s.r));                                            // metric bands, 1 per meter
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class LineArt {
  constructor() {
    this.rt = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: false });
    this.prepScene = new THREE.Scene();
    this.prepCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.prepMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: prepareFrag,
      uniforms: {
        tSrc: { value: null },
        uvScale: { value: new THREE.Vector2(1, 1) },
        uvOffset: { value: new THREE.Vector2(0, 0) },
        mirror: { value: false },
        flipY: { value: false },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = () => new THREE.PlaneGeometry(2, 2);
    const prep = new THREE.Mesh(quad(), this.prepMat);
    prep.frustumCulled = false;
    this.prepScene.add(prep);

    this.drawMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: drawFrag,
      uniforms: {
        tSrc: { value: this.rt.texture },
        tBlur: { value: null },
        method: { value: 0 },
        texel: { value: new THREE.Vector2(0.5, 0.5) },
        lineWidth: { value: 1 }, threshold: { value: 0.2 }, softness: { value: 0.1 },
        fillAmount: { value: 0 }, fillLevels: { value: 4 }, originalMix: { value: 0 },
        jitter: { value: 0 }, grain: { value: 0 }, time: { value: 0 },
        enabled: { value: true }, invert: { value: false },
        lineColor: { value: new THREE.Color() }, bgColor: { value: new THREE.Color() },
        fillTint: { value: new THREE.Color() },
        colorEdgeWeight: { value: 1 }, depthEdgeWeight: { value: 0 }, depthThreshold: { value: 0.03 }, depthDebug: { value: 0 },
        tDepth: { value: null }, depthValid: { value: false },
        uReproj: { value: new THREE.Matrix3() }, uTan: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });
    /** Add this to the scene; it paints the background before anything else. */
    this.backdrop = new THREE.Mesh(quad(), this.drawMat);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -1000;
    this.backdrop.visible = false;
    this.jitterFps = 8;

    // Blur passes (half float: DoG differences are small).
    const rtOpts = { depthBuffer: false, type: THREE.HalfFloatType };
    this.blurA = new THREE.WebGLRenderTarget(2, 2, rtOpts);
    this.blurB = new THREE.WebGLRenderTarget(2, 2, rtOpts);
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: blurFrag,
      uniforms: {
        tIn: { value: null }, dir: { value: new THREE.Vector2() },
        s1: { value: 1 }, s2: { value: 1.6 }, first: { value: true },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blurScene = new THREE.Scene();
    const bq = new THREE.Mesh(quad(), this.blurMat);
    bq.frustumCulled = false;
    this.blurScene.add(bq);
    this.drawMat.uniforms.tBlur.value = this.blurB.texture;
  }

  applyConfig(c) {
    const u = this.drawMat.uniforms;
    u.enabled.value = c.lineArt.enabled;
    u.lineColor.value.set(c.lineArt.lineColor);
    u.bgColor.value.set(c.lineArt.backgroundColor);
    u.fillTint.value.set(c.lineArt.fillTint);
    u.colorEdgeWeight.value = c.lineArt.colorEdgeWeight;
    u.depthEdgeWeight.value = c.depth.enabled ? c.lineArt.depthEdgeWeight : 0;
    u.depthThreshold.value = c.lineArt.depthThreshold;
    u.depthDebug.value = ['off', 'disparity', 'floor', 'meters'].indexOf(c.depth.debugView);
    for (const k of ['threshold', 'softness', 'lineWidth', 'fillAmount', 'fillLevels', 'originalMix', 'jitter', 'grain']) {
      u[k].value = c.lineArt[k];
    }
    u.invert.value = c.lineArt.invert;
    this.jitterFps = c.lineArt.jitterFps;
    this.processSize = c.camera.processSize;
    u.method.value = { canny: 0, sobel: 1, dog: 2 }[c.lineArt.method] ?? 0;
    this.blurMat.uniforms.s1.value = Math.max(0.3, c.lineArt.lineWidth);
    this.blurMat.uniforms.s2.value = Math.max(0.3, c.lineArt.lineWidth) * 1.6;
  }

  /** Share the depth estimator's texture + reprojection uniforms (same objects, updated in place). */
  attachDepth(depthUniforms) {
    Object.assign(this.drawMat.uniforms, depthUniforms);
  }

  /** Point at a new camera texture with its crop. */
  setSource(texture, { uvScale = [1, 1], uvOffset = [0, 0], mirror = false, flipY = false, size = null } = {}) {
    const u = this.prepMat.uniforms;
    u.tSrc.value = texture;
    u.uvScale.value.fromArray(uvScale);
    u.uvOffset.value.fromArray(uvOffset);
    u.mirror.value = mirror;
    u.flipY.value = flipY;
    this.backdrop.visible = !!texture;
    this.source = texture ? { image: texture.image, uvScale, uvOffset, mirror } : null;
    // Visible camera pixels (after crop) – caps the processing resolution.
    this.srcPixels = size ? [size[0] * uvScale[0], size[1] * uvScale[1]] : null;
  }

  /** Run pass 1. Call once per frame before renderer.render(scene, camera). */
  update(renderer, time) {
    if (!this.prepMat.uniforms.tSrc.value) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Long side = processSize, never more than the camera actually delivers.
    const aspect = size.x / size.y;
    let long = this.processSize;
    if (this.srcPixels) long = Math.min(long, Math.max(...this.srcPixels));
    const w = Math.max(2, Math.round(aspect >= 1 ? long : long * aspect));
    const h = Math.max(2, Math.round(aspect >= 1 ? long / aspect : long));
    if (this.rt.width !== w || this.rt.height !== h) {
      this.rt.setSize(w, h);
      this.blurA.setSize(w, h);
      this.blurB.setSize(w, h);
    }
    this.drawMat.uniforms.texel.value.set(1 / w, 1 / h);
    this.drawMat.uniforms.time.value = Math.floor(time * this.jitterFps) % 1000;

    // While presenting, three swaps in the XR camera and framebuffer;
    // switch XR off for this offscreen pass.
    const xrOn = renderer.xr.enabled;
    const prevTarget = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.prepScene, this.prepCam);
    const b = this.blurMat.uniforms;
    b.first.value = true; b.tIn.value = this.rt.texture; b.dir.value.set(1 / w, 0);
    renderer.setRenderTarget(this.blurA);
    renderer.render(this.blurScene, this.prepCam);
    b.first.value = false; b.tIn.value = this.blurA.texture; b.dir.value.set(0, 1 / h);
    renderer.setRenderTarget(this.blurB);
    renderer.render(this.blurScene, this.prepCam);
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = xrOn;
  }
}
