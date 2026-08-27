import { describe, expect, it, vi } from 'vitest';
import {
  buildTranscriptionForm,
  encodeWav,
  isLoopbackEndpoint,
  isSupportedEndpoint,
  parseTranscriptionText,
  sendsKeyInClear,
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

describe('isSupportedEndpoint', () => {
  it('accepts any http(s) host, on this machine or not', () => {
    expect(isSupportedEndpoint('http://127.0.0.1:8080/v1/audio/transcriptions')).toBe(true);
    expect(isSupportedEndpoint('http://localhost:1234/inference')).toBe(true);
    expect(isSupportedEndpoint('http://[::1]:8080/v1/audio/transcriptions')).toBe(true);
    expect(isSupportedEndpoint('http://10.0.10.46:8888/v1/audio/transcriptions')).toBe(true);
    expect(isSupportedEndpoint('https://api.example.com/v1/audio/transcriptions')).toBe(true);
  });

  it('refuses anything that is not an addressable http(s) URL', () => {
    // A typo or a non-HTTP scheme is refused here rather than becoming a
    // request that fails somewhere less explicable.
    expect(isSupportedEndpoint('file:///etc/passwd')).toBe(false);
    expect(isSupportedEndpoint('ws://127.0.0.1:8080')).toBe(false);
    expect(isSupportedEndpoint('not a url')).toBe(false);
    expect(isSupportedEndpoint('')).toBe(false);
  });

  it('refuses a URL with no host, however it is spelled', () => {
    // Every one of these fails to parse, because http is a special scheme —
    // but the validator asserts the outcome rather than the reason, so a
    // parser that returned an empty host instead would still be refused.
    for (const url of ['http://', 'https://', 'http:///', 'http://?q=1', 'http://#f', 'http://:8080/', 'http://@/x']) {
      expect(isSupportedEndpoint(url)).toBe(false);
    }
  });
});

describe('isLoopbackEndpoint', () => {
  it('recognises this machine, including IPv6 loopback', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:8080/v1/audio/transcriptions')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:1234/inference')).toBe(true);
    expect(isLoopbackEndpoint('https://localhost:8443/v1/audio/transcriptions')).toBe(true);
    expect(isLoopbackEndpoint('http://studio.localhost/v1/audio/transcriptions')).toBe(true);
    expect(isLoopbackEndpoint('http://[::1]:8080/v1/audio/transcriptions')).toBe(true);
  });

  it('reports a host off this machine, however it is spelled', () => {
    expect(isLoopbackEndpoint('http://192.168.1.20:8080/v1/audio/transcriptions')).toBe(false);
    expect(isLoopbackEndpoint('https://api.example.com/v1/audio/transcriptions')).toBe(false);
    expect(isLoopbackEndpoint('http://localhost.example.com/v1/audio/transcriptions')).toBe(false);
    expect(isLoopbackEndpoint('not a url')).toBe(false);
    expect(isLoopbackEndpoint('')).toBe(false);
  });
});

describe('sendsKeyInClear', () => {
  it('flags plain http to another host, where a key is readable on the wire', () => {
    expect(sendsKeyInClear('http://10.0.10.46:8888/v1/audio/transcriptions')).toBe(true);
    expect(sendsKeyInClear('http://asr.example.com/v1/audio/transcriptions')).toBe(true);
  });

  it('says nothing about loopback or https, where it is not in the clear', () => {
    expect(sendsKeyInClear('http://127.0.0.1:8080/v1/audio/transcriptions')).toBe(false);
    expect(sendsKeyInClear('http://localhost:8080/inference')).toBe(false);
    expect(sendsKeyInClear('https://api.example.com/v1/audio/transcriptions')).toBe(false);
    expect(sendsKeyInClear('not a url')).toBe(false);
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

  it('posts to a host on the network', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'git status' }));
    const lanEndpoint = 'http://10.0.10.46:8888/v1/audio/transcriptions';
    await expect(
      transcribeViaServer({ url: lanEndpoint, model: 'm', language: 'auto', audio: samples([0]) }, fetchImpl as unknown as typeof fetch)
    ).resolves.toBe('git status');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(lanEndpoint);
  });

  it('sends an api key as a bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'git status' }));
    await transcribeViaServer(
      { url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]), apiKey: '  sk-test-123  ' },
      fetchImpl as unknown as typeof fetch
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Trimmed: a pasted key often carries whitespace, and a header with it
    // fails authentication for a reason nothing reports.
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-test-123' });
  });

  it('sends no authorization header when there is no key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'git status' }));
    await transcribeViaServer({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]) }, fetchImpl as unknown as typeof fetch);
    const [, withoutKey] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(withoutKey.headers).toBeUndefined();

    // An empty or whitespace key is the same as none: a server that reads
    // Bearer would otherwise reject the empty one instead of ignoring it.
    await transcribeViaServer({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]), apiKey: '   ' }, fetchImpl as unknown as typeof fetch);
    const [, blankKey] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(blankKey.headers).toBeUndefined();
  });

  it('says a key is wanted when the server refuses an unauthenticated request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('invalid_api_key', { status: 401 }));
    await expect(
      transcribeViaServer({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]) }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('this server wants an API key');
  });

  it('does not blame a missing key when one was sent', async () => {
    // With a key in the request, a 401 means the key is wrong or expired —
    // pointing at the empty field would send the user the wrong way.
    const fetchImpl = vi.fn(async () => jsonResponse('invalid_api_key', { status: 401 }));
    await expect(
      transcribeViaServer({ url: ENDPOINT, model: 'm', language: 'auto', audio: samples([0]), apiKey: 'sk-wrong' }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/^Speech server returned 401: invalid_api_key$/);
  });

  it('refuses a URL that is not an http(s) address without sending anything', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'nope' }));
    await expect(
      transcribeViaServer(
        { url: 'ws://10.0.10.46:8888/v1/audio/transcriptions', model: 'm', language: 'auto', audio: samples([0]) },
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow('must be an http:// or https:// address');
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
