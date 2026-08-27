import { describe, expect, it, vi } from 'vitest';
import { SpeechClient, type SpeechProgress, type SpeechWorker } from '../src/renderer/speech';
import { DEFAULT_SETTINGS, updateSection } from '../src/renderer/settings';

const BUILTIN = DEFAULT_SETTINGS.speech;
const SERVER = updateSection(DEFAULT_SETTINGS, 'speech', {
  engine: 'server',
  serverUrl: 'http://127.0.0.1:8080/v1/audio/transcriptions',
  serverModel: 'Qwen3-ASR-0.6B'
}).speech;

/** A worker that records what it was sent and can be replied to by hand. */
function fakeWorker() {
  const sent: Array<Record<string, any>> = [];
  let terminated = 0;
  const worker: SpeechWorker = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => { sent.push(message as Record<string, any>); },
    terminate: () => { terminated += 1; }
  };
  return {
    worker,
    sent,
    terminatedCount: () => terminated,
    reply(message: Record<string, unknown>) { worker.onmessage?.({ data: message }); },
    fail(message: string) { worker.onerror?.({ message }); }
  };
}

function audio(values = [0.1, 0.2]) {
  return Float32Array.from(values);
}

describe('SpeechClient with the built-in engine', () => {
  it('sends the configured model, precision, device and task to the worker', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    const settings = updateSection(DEFAULT_SETTINGS, 'speech', {
      model: 'onnx-community/whisper-small',
      precision: 'fp16',
      device: 'webgpu',
      language: 'de',
      task: 'translate'
    }).speech;

    const pending = client.transcribe(audio(), settings);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].config).toEqual({
      model: 'onnx-community/whisper-small',
      precision: 'fp16',
      device: 'webgpu',
      language: 'de',
      task: 'translate',
      multilingual: true
    });

    fake.reply({ type: 'result', id: fake.sent[0].id, text: '  git status  ', elapsedMs: 1200 });
    await expect(pending).resolves.toEqual({ text: '  git status  ', elapsedMs: 1200, engine: 'builtin' });
  });

  it('tells the worker when the model is English-only', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    void client.transcribe(audio(), BUILTIN);
    expect(fake.sent[0].config.multilingual).toBe(false);
  });

  it('creates the worker once and correlates concurrent requests by id', async () => {
    const fake = fakeWorker();
    let created = 0;
    const client = new SpeechClient({ createWorker: () => { created += 1; return fake.worker; } });

    const first = client.transcribe(audio(), BUILTIN);
    const second = client.transcribe(audio(), BUILTIN);
    expect(created).toBe(1);

    const [firstId, secondId] = fake.sent.map((message) => message.id);
    expect(firstId).not.toBe(secondId);

    // Replied to out of order: each promise must still get its own transcript.
    fake.reply({ type: 'result', id: secondId, text: 'second', elapsedMs: 2 });
    fake.reply({ type: 'result', id: firstId, text: 'first', elapsedMs: 1 });
    await expect(first).resolves.toMatchObject({ text: 'first' });
    await expect(second).resolves.toMatchObject({ text: 'second' });
  });

  it('reports download progress and device notices', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    const progress: SpeechProgress[] = [];

    const pending = client.transcribe(audio(), BUILTIN, (update) => progress.push(update));
    const id = fake.sent[0].id;
    fake.reply({ type: 'loading', id, progress: 42 });
    fake.reply({ type: 'notice', id, message: 'WebGPU unavailable; using WASM' });
    fake.reply({ type: 'result', id, text: 'ok', elapsedMs: 5 });
    await pending;

    expect(progress).toEqual([
      { kind: 'loading', progress: 42 },
      { kind: 'notice', message: 'WebGPU unavailable; using WASM' }
    ]);
  });

  it('rejects with the worker error message', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    const pending = client.transcribe(audio(), BUILTIN);
    fake.reply({ type: 'error', id: fake.sent[0].id, message: 'Can\'t create a session' });
    await expect(pending).rejects.toThrow("Can't create a session");
  });

  it('fails in-flight requests when the worker dies, instead of hanging the mic', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    const pending = client.transcribe(audio(), BUILTIN);
    fake.fail('module load failed');
    await expect(pending).rejects.toThrow('module load failed');
  });

  it('ignores replies that match no request', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    void client.transcribe(audio(), BUILTIN);
    expect(() => {
      fake.reply({ type: 'result', id: 999, text: 'stray', elapsedMs: 1 });
      fake.reply({ nonsense: true });
    }).not.toThrow();
  });

  it('terminates the worker on dispose', async () => {
    const fake = fakeWorker();
    const client = new SpeechClient({ createWorker: () => fake.worker });
    const pending = client.transcribe(audio(), BUILTIN);
    client.dispose();
    await expect(pending).rejects.toThrow('disposed');
    expect(fake.terminatedCount()).toBe(1);
  });
});

describe('SpeechClient with the server engine', () => {
  it('never starts a worker', async () => {
    let created = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'git status' }), { status: 200 }));
    const client = new SpeechClient({
      createWorker: () => { created += 1; return fakeWorker().worker; },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1000
    });

    const result = await client.transcribe(audio(), SERVER);
    expect(result).toEqual({ text: 'git status', elapsedMs: 0, engine: 'server' });
    expect(created).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('measures how long the server took', async () => {
    const times = [1000, 1750];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    const client = new SpeechClient({
      createWorker: () => fakeWorker().worker,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => times.shift() ?? 2000
    });

    await expect(client.transcribe(audio(), SERVER)).resolves.toMatchObject({ elapsedMs: 750 });
  });

  it('reaches a server on the network', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'git status' }), { status: 200 }));
    const client = new SpeechClient({
      createWorker: () => fakeWorker().worker,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const onLan = updateSection(DEFAULT_SETTINGS, 'speech', {
      engine: 'server',
      serverUrl: 'http://10.0.10.46:8888/v1/audio/transcriptions',
      serverModel: 'Qwen3-ASR-0.6B'
    }).speech;

    await expect(client.transcribe(audio(), onLan)).resolves.toMatchObject({ text: 'git status', engine: 'server' });
  });

  it('asks for the key per request, so a change applies to the next utterance', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    const keys = ['sk-first', 'sk-second'];
    const resolveApiKey = vi.fn(async () => keys.shift() ?? null);
    const client = new SpeechClient({
      createWorker: () => fakeWorker().worker,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveApiKey
    });

    await client.transcribe(audio(), SERVER);
    await client.transcribe(audio(), SERVER);

    expect(resolveApiKey).toHaveBeenCalledTimes(2);
    const headerOf = (call: number) => (fetchImpl.mock.calls[call] as unknown as [string, RequestInit])[1].headers;
    expect(headerOf(0)).toEqual({ Authorization: 'Bearer sk-first' });
    expect(headerOf(1)).toEqual({ Authorization: 'Bearer sk-second' });
  });

  it('transcribes without a key when there is none, or when reading it fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    // A key store that throws must not stop transcription: plenty of servers
    // want no key at all, and the server itself says so with a 401 if it does.
    const client = new SpeechClient({
      createWorker: () => fakeWorker().worker,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveApiKey: async () => { throw new Error('no keyring'); }
    });

    await expect(client.transcribe(audio(), SERVER)).resolves.toMatchObject({ text: 'ok' });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it('surfaces a refused endpoint as an error', async () => {
    const client = new SpeechClient({
      createWorker: () => fakeWorker().worker,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch
    });
    const notAnAddress = updateSection(DEFAULT_SETTINGS, 'speech', {
      engine: 'server',
      serverUrl: 'file:///etc/passwd'
    }).speech;

    await expect(client.transcribe(audio(), notAnAddress)).rejects.toThrow('must be an http:// or https:// address');
  });
});
