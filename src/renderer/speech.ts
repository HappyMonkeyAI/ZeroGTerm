// One way in for speech recognition, whichever engine is configured.
//
// Callers hand over an utterance and get back a transcript: the pane mic, the
// settings page's test button and anything added later all take the same path,
// so an engine or model change cannot apply to one and not the other. The
// worker is created on first built-in use, which means a user who only ever
// talks to a server never pays for loading Transformers.js.

import type { SpeechSettings } from './settings';
import { supportsLanguageSelection } from './speech-models';
import { transcribeViaServer } from './speech-server';

export type SpeechProgress =
  | { kind: 'loading'; progress: number | null }
  | { kind: 'notice'; message: string };

export type SpeechResult = {
  text: string;
  /** Wall-clock time for the transcription, including any model download. */
  elapsedMs: number;
  engine: SpeechSettings['engine'];
};

/** The worker surface used here; a fake stands in for it in tests. */
export type SpeechWorker = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

type WorkerResult = { text: string; elapsedMs: number };

type Pending = {
  resolve(result: WorkerResult): void;
  reject(error: Error): void;
  onProgress?: (progress: SpeechProgress) => void;
};

export type SpeechClientOptions = {
  createWorker: () => SpeechWorker;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Fetches the speech server key when one is needed.
   *
   * A function rather than a value because the key lives encrypted in the main
   * process: it is read for the request being made and not kept here, so a
   * key saved or cleared mid-session takes effect on the next utterance.
   */
  resolveApiKey?: () => Promise<string | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class SpeechClient {
  private worker: SpeechWorker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly options: SpeechClientOptions) {}

  async transcribe(
    audio: Float32Array,
    settings: SpeechSettings,
    onProgress?: (progress: SpeechProgress) => void
  ): Promise<SpeechResult> {
    if (settings.engine === 'server') {
      const now = this.options.now ?? (() => Date.now());
      const started = now();
      // A missing key is not an error here: plenty of local servers want none,
      // and the server itself says so with a 401 if it does.
      const apiKey = (await this.options.resolveApiKey?.().catch(() => null)) ?? undefined;
      const text = await transcribeViaServer(
        {
          url: settings.serverUrl,
          model: settings.serverModel,
          language: settings.language,
          audio,
          apiKey
        },
        this.options.fetchImpl
      );
      return { text, elapsedMs: now() - started, engine: 'server' };
    }

    const result = await this.transcribeInWorker(audio, settings, onProgress);
    return { ...result, engine: 'builtin' };
  }

  private transcribeInWorker(
    audio: Float32Array,
    settings: SpeechSettings,
    onProgress?: (progress: SpeechProgress) => void
  ): Promise<WorkerResult> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      worker.postMessage(
        {
          type: 'transcribe',
          id,
          audio,
          config: {
            model: settings.model,
            precision: settings.precision,
            device: settings.device,
            language: settings.language,
            task: settings.task,
            multilingual: supportsLanguageSelection(settings.model)
          }
        },
        // Transferring avoids copying seconds of audio; the caller must not
        // read the array afterwards, which is why RMS is measured before this.
        [audio.buffer]
      );
    });
  }

  private ensureWorker(): SpeechWorker {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      const message = isRecord(event) && typeof event.message === 'string' ? event.message : 'Speech worker failed';
      // A worker that dies takes every in-flight request with it; leaving them
      // pending would hang the mic in "transcribing" for the rest of the session.
      this.failAll(new Error(message));
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private handleMessage(data: unknown): void {
    if (!isRecord(data) || typeof data.id !== 'number') return;
    const pending = this.pending.get(data.id);
    if (!pending) return;

    if (data.type === 'loading') {
      pending.onProgress?.({ kind: 'loading', progress: typeof data.progress === 'number' ? data.progress : null });
      return;
    }
    if (data.type === 'notice') {
      pending.onProgress?.({ kind: 'notice', message: String(data.message) });
      return;
    }
    if (data.type === 'result') {
      this.pending.delete(data.id);
      pending.resolve({
        text: typeof data.text === 'string' ? data.text : '',
        elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : 0
      });
      return;
    }
    if (data.type === 'error') {
      this.pending.delete(data.id);
      pending.reject(new Error(typeof data.message === 'string' ? data.message : 'Transcription failed'));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /**
   * Drop the worker so the next built-in transcription starts a fresh one.
   *
   * Used when the app is done with speech, and after a change that the loaded
   * pipeline cannot be talked out of — the worker itself rebuilds on a model,
   * precision or device change, so ordinary settings edits do not need this.
   */
  dispose(): void {
    this.failAll(new Error('Speech client disposed'));
    this.worker?.terminate();
    this.worker = null;
  }
}
