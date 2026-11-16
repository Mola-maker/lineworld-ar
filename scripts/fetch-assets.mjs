#!/usr/bin/env node
// Puts the depth model and the ONNX Runtime wasm next to the app, so the site
// works without huggingface.co / jsdelivr at runtime (both are unreachable in
// some regions). Run by `npm run assets`, by `predev`/`prebuild`, and in CI.
// Files land in public/ (gitignored) and are copied into dist/ by Vite.
import { mkdir, copyFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'onnx-community/depth-anything-v2-small';
const HF = process.env.HF_ENDPOINT || 'https://huggingface.co';
// q4f16 → WebGPU (19 MB), quantized (int8) → WASM fallback (27 MB)
const MODEL_FILES = ['config.json', 'preprocessor_config.json', 'onnx/model_q4f16.onnx', 'onnx/model_quantized.onnx'];
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
];

const exists = async (p) => (await stat(p).catch(() => null))?.size > 0;

for (const f of ORT_FILES) {
  const dst = join(root, 'public/ort', f);
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(join(root, 'node_modules/onnxruntime-web/dist', f), dst);
}
console.log(`ort: ${ORT_FILES.length} files → public/ort/`);

if (process.argv.includes('--no-model')) process.exit(0);
for (const f of MODEL_FILES) {
  const dst = join(root, 'public/models', MODEL, f);
  if (await exists(dst)) continue;
  const url = `${HF}/${MODEL}/resolve/main/${f}`;
  process.stdout.write(`model: ${f} … `);
  const r = await fetch(url);
  if (!r.ok) {
    console.log(`HTTP ${r.status} (skipped; the app will fall back to the remote host)`);
    continue;
  }
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, Buffer.from(await r.arrayBuffer()));
  console.log('ok');
}
