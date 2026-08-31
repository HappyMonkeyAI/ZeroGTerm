// The server speech engine: hand the recorded audio to a transcription server
// instead of to the in-process ONNX pipeline.
//
// This is how models the built-in engine cannot load become usable. A GGUF
// build such as unslothai/Qwen3-ASR-0.6B-GGUF needs a llama.cpp-family
// runtime, and an ONNX export for another runtime is not laid out the way
// Transformers.js expects; either way the model has to be hosted by something
// else. Anything exposing the OpenAI transcription shape works — whisper.cpp's
// server, LM Studio, faster-whisper-server, Unsloth Studio — because that is
// the one request format they have in common.
//
// The host is the operator's choice: loopback, a box on the LAN, or a hosted
// service. Audio of someone at their keyboard is a sensitive payload, so where
// it goes is a decision worth making deliberately — but it is the user's to
// make, not ours to refuse. What is still enforced is the shape of the target:
// an http(s) URL with a host, so a typo or a file:// path cannot become a
// request. See SECURITY.md.
//
// A key, where the server wants one, is sent as `Authorization: Bearer`. It
// arrives as an argument and is never stored here: the main process holds it
// encrypted and hands it over per request. See src/main/secret-store.ts.

import { WHISPER_SAMPLE_RATE } from './voice';
// The endpoint rules live in shared/ because the AI suggestion path asks the same
// questions of the same kind of URL. Re-exported so existing importers of this
// module do not have to know that.
import { isLoopbackEndpoint, isSupportedEndpoint, sendsKeyInClear } from '../shared/endpoints';

export { isLoopbackEndpoint, isSupportedEndpoint, sendsKeyInClear };

export type ServerTranscriptionRequest = {
  url: string;
  model: string;
  /** A Whisper language code, or 'auto' to let the server decide. */
  language: string;
  audio: Float32Array;
  sampleRate?: number;
  /**
   * Bearer token for servers that want one. Absent for a local server that
   * does not, which is why it is optional rather than an empty string.
   */
  apiKey?: string;
};

/** Long enough for a slow first load of a large local model. */
const REQUEST_TIMEOUT_MS = 120000;
/** Enough of a failing server's reply to identify the problem in a status bar. */
const ERROR_BODY_CHARS = 300;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * Wrap mono Float32 samples in a 16-bit PCM WAV container.
 *
 * Servers accept an audio file, not an array of samples, and WAV is the format
 * every one of them can decode without pulling in an encoder here. The samples
 * are already at Whisper's 16 kHz mono from decodeToWhisperInput, so this is a
 * header plus a scale to int16 — no resampling.
 */
export function encodeWav(samples: Float32Array, sampleRate: number = WHISPER_SAMPLE_RATE): ArrayBuffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    // Clamp before scaling: decoded audio can exceed ±1 and would wrap around.
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * bytesPerSample, Math.round(sample * 0x7fff), true);
  }

  return buffer;
}

/**
 * Pull the transcript out of a server reply.
 *
 * OpenAI-compatible servers answer `{ "text": "..." }`, but whisper.cpp builds
 * sometimes answer with segments instead, and a server set to a plain-text
 * response format answers with the bare transcript. All three are accepted
 * because the user picked the server, not us.
 */
export function parseTranscriptionText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) return record.text.trim();
  const segments = record.segments;
  if (Array.isArray(segments)) {
    const joined = segments
      .map((segment) => (typeof segment === 'object' && segment !== null ? (segment as Record<string, unknown>).text : null))
      .filter((text): text is string => typeof text === 'string')
      .join(' ')
      .trim();
    if (joined) return joined;
  }
  if (typeof record.error === 'string') throw new Error(record.error);
  return null;
}

/** The form fields sent to the endpoint, split out so a test can read them. */
export function buildTranscriptionForm(request: ServerTranscriptionRequest): FormData {
  const wav = encodeWav(request.audio, request.sampleRate ?? WHISPER_SAMPLE_RATE);
  const form = new FormData();
  form.set('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.set('model', request.model);
  form.set('response_format', 'json');
  // 'auto' means "no opinion": sending it as a language code makes servers that
  // validate the field reject the request.
  if (request.language && request.language !== 'auto') form.set('language', request.language);
  return form;
}

function timeoutSignal(): AbortSignal | undefined {
  // AbortSignal.timeout exists in Chromium and Node 18+, but a missing one must
  // not stop transcription — it only removes the ceiling on a hung request.
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/**
 * Post the utterance to the configured server and return its transcript.
 *
 * `fetchImpl` is injectable so the request shape can be tested without a
 * server; production passes the renderer's fetch.
 */
export async function transcribeViaServer(
  request: ServerTranscriptionRequest,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (!isSupportedEndpoint(request.url)) {
    throw new Error('Speech server URL must be an http:// or https:// address, e.g. http://10.0.10.46:8888/v1/audio/transcriptions');
  }
  if (!request.model.trim()) {
    throw new Error('Speech server model name is required');
  }

  const key = request.apiKey?.trim();
  const response = await fetchImpl(request.url, {
    method: 'POST',
    // Bearer is what every OpenAI-compatible server reads, including the ones
    // that ignore it. No Content-Type: fetch sets the multipart boundary.
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    body: buildTranscriptionForm(request),
    signal: timeoutSignal()
  });

  const body = await response.text();
  if (!response.ok) {
    const detail = body.slice(0, ERROR_BODY_CHARS).trim();
    // 401 with no key is the commonest way a hosted endpoint fails, and the
    // server's own wording rarely says which key it wanted.
    const hint = !key && (response.status === 401 || response.status === 403) ? ' — this server wants an API key' : '';
    throw new Error(`Speech server returned ${response.status}${detail ? `: ${detail}` : ''}${hint}`);
  }

  let payload: unknown = body;
  try {
    payload = JSON.parse(body);
  } catch {
    // Not JSON: a plain-text transcript is a valid response format.
  }
  const text = parseTranscriptionText(payload);
  if (text === null) throw new Error('Speech server returned no transcript');
  return text;
}
