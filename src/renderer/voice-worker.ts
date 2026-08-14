// Whisper transcription worker. Runs off the main thread so WASM inference
// never blocks terminal rendering. The model is downloaded from the Hugging
// Face hub on first use and cached locally afterwards.
//
// The model, precision and device come from settings with every request rather
// than being fixed here: the pipeline is expensive to build, so it is cached
// and only rebuilt when that configuration actually changes.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

export type WorkerConfig = {
  model: string;
  /** Transformers.js dtype: 'q8' | 'q4' | 'fp16' | 'fp32'. */
  precision: string;
  device: 'wasm' | 'webgpu';
  /** 'auto', or a Whisper language code. Multilingual models only. */
  language: string;
  task: 'transcribe' | 'translate';
  /** English-only checkpoints reject `language` and `task` outright. */
  multilingual: boolean;
};

type WorkerRequest = { type: 'transcribe'; id: number; audio: Float32Array; config: WorkerConfig };
type WorkerResponse =
  | { type: 'loading'; id: number; progress: number | null }
  | { type: 'notice'; id: number; message: string }
  | { type: 'result'; id: number; text: string; elapsedMs: number }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

type LoadedPipeline = {
  key: string;
  device: WorkerConfig['device'];
  pipeline: AutomaticSpeechRecognitionPipeline;
};

let loaded: LoadedPipeline | null = null;
let loading: Promise<LoadedPipeline> | null = null;

function configKey(config: WorkerConfig): string {
  return `${config.model}|${config.precision}|${config.device}`;
}

async function build(config: WorkerConfig, device: WorkerConfig['device'], id: number): Promise<LoadedPipeline> {
  const created = await pipeline('automatic-speech-recognition', config.model, {
    device,
    dtype: config.precision as 'q8',
    // ORT's extended/all graph optimizations crash on whisper's merged decoder
    // ("Can't create a session" — TransposeDQWeightsForMatMulNBits cannot find
    // a scale for the shared embed_tokens weight). 'basic' skips that pass.
    session_options: { graphOptimizationLevel: 'basic' },
    progress_callback: (info: { status: string; progress?: number }) => {
      if (info.status === 'progress') {
        scope.postMessage({ type: 'loading', id, progress: info.progress ?? null });
      }
    }
  });
  return { key: configKey(config), device, pipeline: created };
}

async function loadPipeline(config: WorkerConfig, id: number): Promise<LoadedPipeline> {
  const key = configKey(config);
  if (loaded && loaded.key === key) return loaded;
  if (loading) {
    const pending = await loading;
    if (pending.key === key) return pending;
  }

  // A different model is being asked for: release the old session before
  // building the new one, or both sets of weights sit in memory at once.
  if (loaded) {
    try {
      await loaded.pipeline.dispose();
    } catch {
      // A pipeline that refuses to dispose must not block the new one.
    }
    loaded = null;
  }

  loading = build(config, config.device, id)
    .catch(async (error) => {
      // WebGPU is unavailable in more setups than it looks — the app disables
      // hardware acceleration by default — and failing over to WASM is far
      // better than refusing to transcribe.
      if (config.device !== 'webgpu') throw error;
      scope.postMessage({
        type: 'notice',
        id,
        message: `WebGPU unavailable (${error instanceof Error ? error.message : String(error)}); using WASM`
      });
      return build(config, 'wasm', id);
    })
    .then((result) => {
      loaded = result;
      loading = null;
      return result;
    })
    .catch((error) => {
      loading = null;
      throw error;
    });

  return loading;
}

async function handleTranscribe(data: WorkerRequest): Promise<void> {
  const started = Date.now();
  try {
    const active = await loadPipeline(data.config, data.id);
    // whisper-*.en is English-only and rejects both options ("Cannot specify
    // `task` or `language`..."), so they are only sent when the checkpoint is
    // multilingual — and `auto` means "let the model detect it", i.e. send
    // nothing.
    const options = data.config.multilingual
      ? {
          task: data.config.task,
          ...(data.config.language && data.config.language !== 'auto' ? { language: data.config.language } : {})
        }
      : {};
    const output = await active.pipeline(data.audio, options);
    scope.postMessage({ type: 'result', id: data.id, text: output.text.trim(), elapsedMs: Date.now() - started });
  } catch (error) {
    scope.postMessage({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) });
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
