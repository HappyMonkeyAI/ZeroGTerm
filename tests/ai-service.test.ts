import { describe, expect, it, vi } from 'vitest';
import { AiService, type FetchLike } from '../src/main/ai-service';
import type { AiSuggestionRequest } from '../src/shared/types';

const config = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder' };

const request: AiSuggestionRequest = {
  prompt: 'fix that',
  context: { shell: 'bash', cwd: '/srv/app' }
};

type Call = { url: string; init: RequestInit };

function harness(options: {
  reply?: unknown;
  status?: number;
  bodyText?: string;
  key?: string | null;
  json?: () => Promise<unknown>;
  behaviour?: FetchLike;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = options.behaviour ?? (async (url, init) => {
    calls.push({ url, init });
    const status = options.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: options.json ?? (async () => options.reply ?? {}),
      text: async () => options.bodyText ?? ''
    } as unknown as Response;
  });
  const service = new AiService({
    readApiKey: async () => (options.key === undefined ? null : options.key),
    fetch: (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    timeoutMs: 40
  });
  return { service, calls };
}

const suggestionReply = { choices: [{ message: { content: '{"command":"git push","explanation":"You meant push."}' } }] };

describe('suggest', () => {
  it('posts to chat/completions and returns the parsed suggestion', async () => {
    const { service, calls } = harness({ reply: suggestionReply });
    await expect(service.suggest(config, request)).resolves.toEqual({
      command: 'git push',
      explanation: 'You meant push.'
    });
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
  });

  it('sends no Authorization header when there is no key', async () => {
    // A local Ollama wants no header at all, and an empty Bearer is worse than
    // none.
    const { service, calls } = harness({ reply: suggestionReply, key: null });
    await service.suggest(config, request);
    expect(calls[0].init.headers).not.toHaveProperty('Authorization');
  });

  it('sends the key as a Bearer token when there is one', async () => {
    const { service, calls } = harness({ reply: suggestionReply, key: 'sk-test' });
    await service.suggest(config, request);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('refuses a base URL that is not one', async () => {
    const { service, calls } = harness({ reply: suggestionReply });
    await expect(service.suggest({ ...config, baseUrl: 'not a url' }, request)).rejects.toThrow(/http\(s\) base URL/);
    await expect(service.suggest({ ...config, baseUrl: 'file:///etc/passwd' }, request)).rejects.toThrow(/http\(s\) base URL/);
    expect(calls).toEqual([]);
  });

  it('validates the request before making one', async () => {
    const { service, calls } = harness({ reply: suggestionReply });
    await expect(service.suggest(config, { ...request, prompt: '  ' })).rejects.toThrow(/what you would like/i);
    await expect(service.suggest({ ...config, model: '' }, request)).rejects.toThrow(/model in Settings/i);
    expect(calls).toEqual([]);
  });

  it('gives up when the endpoint says nothing', async () => {
    const { service } = harness({
      behaviour: (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
    });
    await expect(service.suggest(config, request)).rejects.toThrow(/did not answer within/);
  });

  it('abandons a request in flight when a new one starts', async () => {
    // The old answer would arrive against a dialog that has moved on.
    //
    // The double has to reject on a signal that is *already* aborted, the way
    // fetch does: the abort lands while the service is still awaiting the stored
    // key, so by the time fetch is called there is no future event to listen for.
    let aborted = false;
    const abortError = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      return error;
    };
    const { service } = harness({
      behaviour: (_url, init) => new Promise((resolve, reject) => {
        if (init.signal?.aborted) {
          aborted = true;
          reject(abortError());
          return;
        }
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(abortError());
        });
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => suggestionReply, text: async () => '' } as unknown as Response), 5);
      })
    });
    const first = service.suggest(config, request).catch(() => 'abandoned');
    const second = service.suggest(config, request);
    await expect(first).resolves.toBe('abandoned');
    await second;
    expect(aborted).toBe(true);
  });

  it('explains a refused key rather than reporting a status', async () => {
    const { service } = harness({ status: 401, bodyText: '{"error":"invalid api key"}' });
    await expect(service.suggest(config, request)).rejects.toThrow(/refused the key \(401\).*invalid api key/s);
  });

  it('points at the base URL on a 404', async () => {
    const { service } = harness({ status: 404 });
    await expect(service.suggest(config, request)).rejects.toThrow(/ends in \/v1/);
  });

  it('says so when a server answers 200 with something other than JSON', async () => {
    const { service } = harness({ json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(service.suggest(config, request)).rejects.toThrow(/other than JSON/);
  });

  it('names the endpoint when nothing is listening', async () => {
    // What fetch throws is a TypeError with a message that helps nobody.
    const { service } = harness({ behaviour: async () => { throw new TypeError('fetch failed'); } });
    await expect(service.suggest(config, request)).rejects.toThrow(/Could not reach http:\/\/127\.0\.0\.1:11434\/v1\/chat\/completions/);
  });

  it('trims a very long error body', async () => {
    const { service } = harness({ status: 500, bodyText: 'x'.repeat(5000) });
    await expect(service.suggest(config, request)).rejects.toThrow(/…$/);
  });
});

describe('listModels', () => {
  it('gets the model ids from the endpoint', async () => {
    const { service, calls } = harness({ reply: { data: [{ id: 'llama3' }, { id: 'qwen2.5-coder' }] } });
    await expect(service.listModels(config.baseUrl)).resolves.toEqual(['llama3', 'qwen2.5-coder']);
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/models');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('refuses a base URL that is not one', async () => {
    const { service } = harness();
    await expect(service.listModels('nope')).rejects.toThrow(/http\(s\) base URL/);
  });
});

describe('test', () => {
  it('reports a working endpoint without throwing', async () => {
    const { service } = harness({ reply: { choices: [{ message: { content: 'ok' } }] } });
    const result = await service.test(config);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('qwen2.5-coder');
  });

  it('counts a reply that is not a suggestion as working', async () => {
    // The test is whether the model answered, not whether it answered in the
    // shape a suggestion needs.
    const { service } = harness({ reply: { choices: [{ message: { content: 'Hello!' } }] } });
    await expect(service.test(config)).resolves.toMatchObject({ ok: true });
  });

  it('reports a failure as a sentence rather than rejecting', async () => {
    const { service } = harness({ status: 401 });
    const result = await service.test(config);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused the key/);
  });

  it('asks for a model before testing', async () => {
    const { service, calls } = harness();
    await expect(service.test({ ...config, model: '' })).resolves.toMatchObject({ ok: false, message: 'Choose a model first.' });
    expect(calls).toEqual([]);
  });

  it('does not read a key it was not given', async () => {
    const readApiKey = vi.fn(async () => null);
    const service = new AiService({ readApiKey, fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }) as unknown as Response });
    await service.test(config);
    expect(readApiKey).toHaveBeenCalledTimes(1);
  });
});
