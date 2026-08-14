import { describe, expect, it, vi } from 'vitest';
import {
  buildTranscriptionForm,
  encodeWav,
  isIpv6LoopbackEndpoint,
  isLoopbackEndpoint,
  parseTranscriptionText,
  transcribeViaServer
} from '../src/renderer/speech-server';

const ENDPOINT = 'http://127.0.0.1:8080/v1/audio/transcriptions';

function samples(values: number[]): Float32Array {
  return Float32Array.from(values);
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('isLoopbackEndpoint', () => {
  it('accepts this machine', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:8080/v1/audio/transcriptions')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:1234/inference')).toBe(true);
    expect(isLoopbackEndpoint('https://localhost:8443/v1/audio/transcriptions')).toBe(true);
    expect(isLoopbackEndpoint('http://studio.localhost/v1/audio/transcriptions')).toBe(true);
  });

  it('refuses IPv6 literals, which the renderer CSP cannot express', () => {
    // Chromium reports http://[::1] and http://[::1]:8080 as invalid CSP
    // sources and ignores them, so such a URL would pass validation here and
    // then be blocked with no explanation.
    expect(isLoopbackEndpoint('http://[::1]:8080/v1/audio/transcriptions')).toBe(false);
    expect(isIpv6LoopbackEndpoint('http://[::1]:8080/v1/audio/transcriptions')).toBe(true);
    expect(isIpv6LoopbackEndpoint('http://localhost:8080/v1/audio/transcriptions')).toBe(false);
    expect(isIpv6LoopbackEndpoint('not a url')).toBe(false);
  });

  it('refuses anything off this machine, however it is spelled', () => {
    // Recorded speech must not be postable to a host on the network just
    // because a URL was pasted into a settings field.
    expect(isLoopbackEndpoint('http://192.168.1.20:8080/v1/audio/transcriptions')).toBe(false);
    expect(isLoopbackEndpoint('https://api.example.com/v1/audio/transcriptions')).toBe(false);
    expect(isLoopbackEndpoint('http://localhost.example.com/v1/audio/transcriptions')).toBe(false);
    expect(isLoopbackEndpoint('file:///etc/passwd')).toBe(false);
    expect(isLoopbackEndpoint('ws://127.0.0.1:8080')).toBe(false);
    expect(isLoopbackEndpoint('not a url')).toBe(false);
    expect(isLoopbackEndpoint('')).toBe(false);
  });
});

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header for the given rate', () => {
    const buffer = encodeWav(samples([0, 0.5, -0.5]), 16000);
    const view = new DataView(buffer);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(view.getUint32(40, true)).toBe(6);
    expect(buffer.byteLength).toBe(44 + 6);
  });

  it('scales samples to int16', () => {
    const view = new DataView(encodeWav(samples([0, 1, -1]), 16000));
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32767);
  });

  it('clamps samples that exceed full scale instead of wrapping them', () => {
    // Decoded audio can overshoot ±1; wrapping would turn a loud syllable into
    // the opposite polarity and sound like a click to the model.
    const view = new DataView(encodeWav(samples([1.8, -1.8]), 16000));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });
});

describe('buildTranscriptionForm', () => {
  it('sends the audio as a wav file with the model name', () => {
    const form = buildTranscriptionForm({ url: ENDPOINT, model: 'Qwen3-ASR-0.6B', language: 'auto', audio: samples([0.1, 0.2]) });
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe('audio/wav');
    expect(form.get('model')).toBe('Qwen3-ASR-0.6B');
    expect(form.get('response_format')).toBe('json');
  });

  it('omits the language when set to automatic', () => {
    // Servers that validate the field reject the literal string "auto".
    const auto = buildTranscriptionForm({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]) });
    expect(auto.get('language')).toBeNull();
    const german = buildTranscriptionForm({ url: ENDPOINT, model: 'm', language: 'de', audio: samples([0]) });
    expect(german.get('language')).toBe('de');
  });
});

describe('parseTranscriptionText', () => {
  it('reads the OpenAI shape', () => {
    expect(parseTranscriptionText({ text: '  git status  ' })).toBe('git status');
  });

  it('joins whisper.cpp segments', () => {
    expect(parseTranscriptionText({ segments: [{ text: 'git' }, { text: 'status' }] })).toBe('git status');
  });

  it('accepts a plain-text body', () => {
    expect(parseTranscriptionText('git status\n')).toBe('git status');
  });

  it('reports an error field as an error', () => {
    expect(() => parseTranscriptionText({ error: 'model not loaded' })).toThrow('model not loaded');
  });

  it('returns null when there is no transcript', () => {
    expect(parseTranscriptionText({})).toBeNull();
    expect(parseTranscriptionText({ text: '   ' })).toBeNull();
    expect(parseTranscriptionText('')).toBeNull();
    expect(parseTranscriptionText(null)).toBeNull();
  });
});

describe('transcribeViaServer', () => {
  it('posts to the endpoint and returns the transcript', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'git status' }));
    const text = await transcribeViaServer(
      { url: ENDPOINT, model: 'Qwen3-ASR-0.6B', language: 'auto', audio: samples([0.1, 0.2]) },
      fetchImpl as unknown as typeof fetch
    );

    expect(text).toBe('git status');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('tells the user what to type when they give an IPv6 literal', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'nope' }));
    await expect(
      transcribeViaServer(
        { url: 'http://[::1]:8080/v1/audio/transcriptions', model: 'm', language: 'auto', audio: samples([0]) },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow('Use http://localhost instead');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-loopback endpoint without sending anything', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'nope' }));
    await expect(
      transcribeViaServer(
        { url: 'https://api.example.com/v1/audio/transcriptions', model: 'm', language: 'auto', audio: samples([0]) },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow('must be on this machine');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a model name', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'nope' }));
    await expect(
      transcribeViaServer({ url: ENDPOINT, model: '  ', language: 'auto', audio: samples([0]) }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('model name is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces the server status and body when it fails', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('model not found', { status: 404 }));
    await expect(
      transcribeViaServer({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]) }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('Speech server returned 404: model not found');
  });

  it('explains an empty transcript rather than typing nothing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(
      transcribeViaServer({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]) }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('no transcript');
  });
});
