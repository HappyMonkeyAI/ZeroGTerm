// End-to-end check: full Whisper ASR pipeline on the WASM backend with the
// graphOptimizationLevel workaround, matching the renderer worker's setup.
// Import the web build directly: the package's Node entry rejects device
// 'wasm'. setup-ort-web marks the runtime as non-Node so the WASM backend is
// selected, matching the renderer worker.
import './setup-ort-web.mjs';
import { env, pipeline } from '../node_modules/@huggingface/transformers/dist/transformers.web.js';

env.allowLocalModels = false;
env.useBrowserCache = false;
// Node has SharedArrayBuffer, so ort would default to a threaded worker via
// blob: URLs (which Node rejects). Electron's file:// renderer cannot thread
// either, so pin single-threaded to match production.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
// In the app, Vite rewrites ort's wasm references to bundled assets; the
// node_modules build has no such rewrite, so transformers fell back to its
// jsdelivr CDN default. Point at the local files instead.
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href
};

const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
  device: 'wasm',
  session_options: { graphOptimizationLevel: 'basic' },
});
console.log('pipeline created');

const audio = new Float32Array(16000 * 2).map(
  (_, index) => Math.sin((2 * Math.PI * 440 * index) / 16000) * 0.2
);
const start = Date.now();
const output = await asr(audio);
console.log(`inference OK in ${Date.now() - start} ms, text: ${JSON.stringify(output.text)}`);
