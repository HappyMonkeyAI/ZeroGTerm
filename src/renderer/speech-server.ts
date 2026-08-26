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

import { WHISPER_SAMPLE_RATE } from './voice';

export type ServerTranscriptionRequest = {
  url: string;
  model: string;
  /** A Whisper language code, or 'auto' to let the server decide. */
  language: string;
  audio: Float32Array;
  sampleRate?: number;
};

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** Long enough for a slow first load of a large local model. */
const REQUEST_TIMEOUT_MS = 120000;
/** Enough of a failing server's reply to identify the problem in a status bar. */
const ERROR_BODY_CHARS = 300;

function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.toLowerCase();
    // http and https are special schemes, so a missing host is a parse failure
    // rather than an empty hostname — every spelling of `http://` throws above.
    // The check is kept anyway: this is the one gate before a request is made,
    // and it should not rest on a parser detail holding everywhere.
    if (!hostname) return null;
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Can a transcription request be made to this URL?
 *
 * Any reachable host is allowed — loopback, LAN, or the public internet — but
 * it has to be an http(s) URL naming a host. A `file://` path, a `ws://` URL or
 * a half-typed address is refused here rather than turning into a request that
 * fails obscurely later.
 */
export function isSupportedEndpoint(url: string): boolean {
  return hostnameOf(url) !== null;
}

/**
 * Does this endpoint keep the audio on this machine?
 *
 * Nothing is refused on this basis; the settings panel uses it to say plainly
 * when recorded speech is about to leave the machine. `*.localhost` resolves to
 * loopback by specification, so it counts.
 */
export function isLoopbackEndpoint(url: string): boolean {
  const hostname = hostnameOf(url);
  if (hostname === null) return false;
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

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

  const response = await fetchImpl(request.url, {
    method: 'POST',
    body: buildTranscriptionForm(request),
    signal: timeoutSignal()
  });

  const body = await response.text();
  if (!response.ok) {
    const detail = body.slice(0, ERROR_BODY_CHARS).trim();
    throw new Error(`Speech server returned ${response.status}${detail ? `: ${detail}` : ''}`);
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
