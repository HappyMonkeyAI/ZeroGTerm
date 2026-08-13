// Headless repro for the "Can't create a session" voice error:
// creates the Whisper ONNX sessions through onnxruntime-web's WASM backend.
import * as ort from 'onnxruntime-web';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// Require the model directory explicitly. Defaulting to a path under /tmp
// meant loading .onnx files from a world-writable location: on a shared host
// another user can pre-create that directory and swap the models this script
// then executes.
const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/repro-voice-session.mjs <model-dir> [optimization] [...files]');
  process.exit(1);
}
const optimization = process.argv[3]; // optional graphOptimizationLevel override
const files = process.argv.slice(4).length
  ? process.argv.slice(4)
  : ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'];

for (const file of files) {
  try {
    const options = optimization ? { graphOptimizationLevel: optimization } : undefined;
    const session = await ort.InferenceSession.create(`${dir}/${file}`, options);
    console.log(`OK   ${file} inputs=${session.inputNames.length} ${optimization ? `(optimization=${optimization})` : ''}`);
  } catch (error) {
    console.error(`FAIL ${file}: ${error?.message ?? error}`);
  }
}
