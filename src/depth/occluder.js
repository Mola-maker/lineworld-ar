import * as THREE from 'three';
import { REPROJECT_GLSL } from './depth.js';

// Writes the estimated real-world depth into the depth buffer (no colour), so
// the character is hidden behind real objects that are closer to the camera.
// Floor pixels write "far": the character's feet stand on the floor and must
// never be clipped by it.

export function createOccluder(depthUniforms) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...depthUniforms,
      uProj: { value: new THREE.Matrix4() },
      enabled: { value: false },
      bias: { value: 0.08 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      ${REPROJECT_GLSL}
      uniform mat4 uProj;
      uniform bool enabled;
      uniform float bias;
      varying vec2 vUv;
      void main() {
        float d = 1.0;
        vec3 rc;
        vec2 cuv = reprojectUv(vUv, rc);
        if (enabled && depthValid && cuv.x >= 0.0 && cuv.y >= 0.0 && cuv.x <= 1.0 && cuv.y <= 1.0) {
          vec4 s = texture2D(tDepth, cuv);
          if (s.g < 0.5 && s.r > 0.05) {
            vec3 pCap = rc * ((s.r + bias) / -rc.z);
            vec3 pCur = transpose(uReproj) * pCap;
            vec4 clip = uProj * vec4(0.0, 0.0, pCur.z, 1.0);
            d = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
          }
        }
        gl_FragDepth = d;
        gl_FragColor = vec4(0.0);
      }
    `,
    colorWrite: false,
    depthWrite: true,
    // GL skips depth writes when the depth test is off, so test-but-always-pass.
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -999; // after the line-art backdrop, before everything else
  mesh.update = (camera, cfg) => {
    mat.uniforms.uProj.value.copy(camera.projectionMatrix);
    mat.uniforms.enabled.value = cfg.depth.enabled && cfg.depth.occlusion;
    mat.uniforms.bias.value = cfg.depth.occlusionBias;
  };
  return mesh;
}
