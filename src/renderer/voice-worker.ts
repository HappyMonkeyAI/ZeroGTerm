// Whisper transcription worker. Runs off the main thread so WASM inference
// never blocks terminal rendering. The model is downloaded from the Hugging
// Face hub on first use and cached locally afterwards.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

// English-only tiny model: best accuracy per downloaded byte for dictating
// shell commands. Swap for a larger Whisper variant to trade size for quality.
const MODEL_ID = 'onnx-community/whisper-tiny.en';

type WorkerRequest = { type: 'transcribe'; audio: Float32Array };
type WorkerResponse =
  | { type: 'loading'; progress: number | null }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let transcribe: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function loadPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcribe) return Promise.resolve(transcribe);
  loading ??= pipeline('automatic-speech-recognition', MODEL_ID, {
    device: 'wasm',
    // ORT's extended/all graph optimizations crash on whisper's merged decoder
    // ("Can't create a session" — TransposeDQWeightsForMatMulNBits cannot find
    // a scale for the shared embed_tokens weight). 'basic' skips that pass.
    session_options: { graphOptimizationLevel: 'basic' },
    progress_callback: (info: { status: string; progress?: number }) => {
      if (info.status === 'progress') {
        scope.postMessage({ type: 'loading', progress: info.progress ?? null });
      }
    }
  }).then((created) => {
    transcribe = created;
    return created;
  });
  return loading;
}

async function handleTranscribe(data: WorkerRequest): Promise<void> {
  try {
    const transcribePipeline = await loadPipeline();
    // No `task`/`language` options: whisper-tiny.en is English-only and
    // rejects both ("Cannot specify `task` or `language`...").
    const output = await transcribePipeline(data.audio);
    scope.postMessage({ type: 'result', text: output.text.trim() });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

// onmessage is typed as returning void, so the handler stays synchronous and
// the promise is consumed here. Assigning an async function returned a promise
// nobody awaited, leaving any rejection thrown outside the try/catch unhandled.
scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (!data || data.type !== 'transcribe' || !(data.audio instanceof Float32Array)) return;
  void handleTranscribe(data);
};
