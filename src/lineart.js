import * as THREE from 'three';
import { REPROJECT_GLSL } from './depth/depth.js';

// Turns any camera texture (VideoTexture in window mode, the WebXR raw-camera
// ExternalTexture in AR mode) into a line drawing that sits behind the 3D scene.
//
// Pass 1 (prepare): crop / mirror the source into a small render target.
//   Downsampling with linear filtering doubles as the blur that keeps Sobel
//   from tracing sensor noise.
// Pass 2 (draw): a full-screen quad inside the scene, drawn first at the far
//   plane, so it works per-eye in WebXR without a separate compositor.

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

const drawFrag = /* glsl */ `
  uniform sampler2D tSrc;
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

  void main() {
    vec3 src = texture2D(tSrc, vUv).rgb;

    // Low-frequency wobble: hand-drawn lines that "boil" a few times a second.
    vec2 cell = floor(vUv * 24.0);
    vec2 j = (vec2(hash(cell + time), hash(cell + time + 17.0)) - 0.5) * jitter * texel;
    vec2 uv = vUv + j;
    vec2 o = texel * lineWidth;

    float tl = lum(uv + vec2(-o.x,  o.y)), t = lum(uv + vec2(0.0,  o.y)), tr = lum(uv + vec2(o.x,  o.y));
    float l  = lum(uv + vec2(-o.x, 0.0)),                                  r  = lum(uv + vec2(o.x, 0.0));
    float bl = lum(uv + vec2(-o.x, -o.y)), b = lum(uv + vec2(0.0, -o.y)), br = lum(uv + vec2(o.x, -o.y));
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
    float edge = smoothstep(threshold, threshold + softness, length(vec2(gx, gy))) * colorEdgeWeight;
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
    this.processScale = c.camera.processScale;
  }

  /** Share the depth estimator's texture + reprojection uniforms (same objects, updated in place). */
  attachDepth(depthUniforms) {
    Object.assign(this.drawMat.uniforms, depthUniforms);
  }

  /** Point at a new camera texture with its crop. */
  setSource(texture, { uvScale = [1, 1], uvOffset = [0, 0], mirror = false, flipY = false } = {}) {
    const u = this.prepMat.uniforms;
    u.tSrc.value = texture;
    u.uvScale.value.fromArray(uvScale);
    u.uvOffset.value.fromArray(uvOffset);
    u.mirror.value = mirror;
    u.flipY.value = flipY;
    this.backdrop.visible = !!texture;
    this.source = texture ? { image: texture.image, uvScale, uvOffset, mirror } : null;
  }

  /** Run pass 1. Call once per frame before renderer.render(scene, camera). */
  update(renderer, time) {
    if (!this.prepMat.uniforms.tSrc.value) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(2, Math.round(size.x * this.processScale));
    const h = Math.max(2, Math.round(size.y * this.processScale));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.drawMat.uniforms.texel.value.set(1 / w, 1 / h);
    this.drawMat.uniforms.time.value = Math.floor(time * this.jitterFps) % 1000;

    // While presenting, three swaps in the XR camera and framebuffer;
    // switch XR off for this offscreen pass.
    const xrOn = renderer.xr.enabled;
    const prevTarget = renderer.getRenderTarget();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.prepScene, this.prepCam);
    renderer.setRenderTarget(prevTarget);
    renderer.xr.enabled = xrOn;
  }
}
