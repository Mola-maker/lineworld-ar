// Runs Depth Anything V2 off the main thread. Input: RGBA frame already
// cropped to the screen and sized to multiples of 14. Output: disparity.
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';

let model = null;
let processor = null;

async function init(o) {
  env.allowLocalModels = true;
  env.localModelPath = o.localModelPath;
  env.allowRemoteModels = !!o.remoteHost;
  if (o.remoteHost) env.remoteHost = o.remoteHost;
  env.useBrowserCache = true;
  if (o.ortPath) {
    env.backends.onnx.wasm.wasmPaths = {
      mjs: o.ortPath + 'ort-wasm-simd-threaded.asyncify.mjs',
      wasm: o.ortPath + 'ort-wasm-simd-threaded.asyncify.wasm',
    };
  }
  let device = o.device;
  if (device === 'auto') {
    let gpu = false;
    try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch { /* none */ }
    device = gpu ? 'webgpu' : 'wasm';
  }
  const dtype = device === 'webgpu' ? o.dtypeWebGPU : o.dtypeWasm;
  const progress = (p) => p.status === 'progress' && postMessage({ type: 'progress', file: p.file, progress: p.progress });
  model = await AutoModel.from_pretrained(o.modelId, { device, dtype, progress_callback: progress });
  processor = await AutoProcessor.from_pretrained(o.modelId);
  // We feed frames that are already the right size (multiples of 14).
  processor.image_processor.do_resize = false;
  postMessage({ type: 'ready', device, dtype });
}

async function run({ id, pixels, width, height }) {
  const t0 = performance.now();
  const image = new RawImage(new Uint8ClampedArray(pixels), width, height, 4);
  const inputs = await processor(image);
  const { predicted_depth } = await model(inputs);
  let t = predicted_depth;
  if (t.type !== 'float32') t = t.to('float32');
  const [ , h, w] = t.dims.length === 3 ? t.dims : [1, ...t.dims.slice(-2)];
  const data = new Float32Array(t.data);
  postMessage({ type: 'depth', id, data, width: w, height: h, ms: performance.now() - t0 }, [data.buffer]);
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') await init(data);
    else if (data.type === 'run') await run(data);
  } catch (e) {
    postMessage({ type: 'error', message: String(e?.message || e), id: data.id });
  }
};
