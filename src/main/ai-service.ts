// The request to an OpenAI-compatible endpoint.
//
// In the main process rather than the renderer, for two reasons. A renderer
// fetch is a cross-origin request, and Ollama refuses those unless
// OLLAMA_ORIGINS is set — so the most obvious local setup would fail for a
// reason the user cannot see. And the API key never has to enter the renderer at
// all: it is read here, used for one request, and not held.
//
// Bounded and cancellable, as CONTEXT.md asks of AI output capture: every call
// carries an AbortController and a timeout, so a server that accepts a
// connection and then says nothing cannot leave a dialog waiting forever.

import {
  AI_TIMEOUT_MS,
  ERROR_BODY_CHARS,
  buildSuggestionRequest,
  chatCompletionsUrl,
  modelsUrl,
  parseModelList,
  parseSuggestion
} from './ai-protocol.js';
import { isSupportedEndpoint } from '../shared/endpoints.js';
import type { AiSuggestion, AiSuggestionRequest, AiTestResult } from '../shared/types.js';

export type AiConfig = {
  baseUrl: string;
  model: string;
};

/** Just enough of fetch to be replaced in a test. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type AiServiceOptions = {
  /** Reads the stored key, or nothing when the endpoint needs none. */
  readApiKey: () => Promise<string | null>;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export class AiService {
  private readonly readApiKey: () => Promise<string | null>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  /** The request in flight, so a new one supersedes it rather than racing it. */
  private inFlight: AbortController | null = null;

  constructor(options: AiServiceOptions) {
    this.readApiKey = options.readApiKey;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  }

  /** Abandon whatever is in flight. The dialog closing is a reason to. */
  cancel(): void {
    this.inFlight?.abort();
    this.inFlight = null;
  }

  async suggest(config: AiConfig, request: AiSuggestionRequest): Promise<AiSuggestion> {
    requireEndpoint(config.baseUrl);
    const body = buildSuggestionRequest({
      prompt: request.prompt,
      model: config.model,
      context: request.context
    });
    // Only one suggestion is ever wanted at a time, and the old one's answer
    // would arrive against a dialog that has moved on.
    this.cancel();
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const payload = await this.send(chatCompletionsUrl(config.baseUrl), body, controller);
      return parseSuggestion(payload);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  async listModels(baseUrl: string): Promise<string[]> {
    requireEndpoint(baseUrl);
    const controller = new AbortController();
    const payload = await this.send(modelsUrl(baseUrl), undefined, controller);
    return parseModelList(payload);
  }

  /**
   * Ask the endpoint for one token, and report what happened in a sentence.
   *
   * A real completion rather than a reachability check: a server can accept a
   * connection, list models, and still refuse to run the model that is
   * configured. That is the failure worth catching before the user needs it.
   */
  async test(config: AiConfig): Promise<AiTestResult> {
    try {
      requireEndpoint(config.baseUrl);
      if (!config.model.trim()) throw new Error('Choose a model first.');
      const controller = new AbortController();
      const payload = await this.send(
        chatCompletionsUrl(config.baseUrl),
        { model: config.model.trim(), max_tokens: 8, messages: [{ role: 'user', content: 'Reply with: ok' }] },
        controller
      );
      const suggestion = parseSuggestion(payload);
      // A reply that did not parse is still a working endpoint: the test is
      // whether the model answered, not whether it answered in the shape a
      // suggestion needs.
      return { ok: true, message: `${config.model} replied${suggestion.explanation ? `: ${trim(suggestion.explanation)}` : '.'}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async send(url: string, body: unknown, controller: AbortController): Promise<unknown> {
    const key = await this.readApiKey();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          // Only when there is one: a local Ollama wants no header at all, and
          // an empty Bearer is worse than none.
          ...(key ? { Authorization: `Bearer ${key}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });

      if (!response.ok) throw new Error(await describeFailure(response));
      try {
        return await response.json();
      } catch {
        // A server that answers 200 with HTML is usually a proxy or a wrong
        // path, and saying so beats "Unexpected token <".
        throw new Error('The endpoint answered with something other than JSON. Check the base URL ends in /v1.');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`The endpoint did not answer within ${Math.round(this.timeoutMs / 1000)}s.`);
      }
      if (error instanceof TypeError) {
        // What fetch throws when nothing is listening, with a message that names
        // no host and helps nobody.
        throw new Error(`Could not reach ${url}. Is the server running?`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireEndpoint(baseUrl: string): void {
  if (!isSupportedEndpoint(baseUrl)) {
    throw new Error('Set an http(s) base URL in Settings, such as http://127.0.0.1:11434/v1.');
  }
}

/**
 * A failing response, as a sentence.
 *
 * The status alone does not distinguish a wrong key from a missing model, and
 * these servers put the difference in the body — so the body is read, trimmed,
 * and quoted.
 */
async function describeFailure(response: Response): Promise<string> {
  const detail = await response.text().then(trim).catch(() => '');
  if (response.status === 401 || response.status === 403) {
    return `The endpoint refused the key (${response.status}).${detail ? ` ${detail}` : ''}`;
  }
  if (response.status === 404) {
    return `Not found (404). Check the base URL ends in /v1 and the model exists.${detail ? ` ${detail}` : ''}`;
  }
  return `The endpoint returned ${response.status}.${detail ? ` ${detail}` : ''}`;
}

function trim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > ERROR_BODY_CHARS ? `${clean.slice(0, ERROR_BODY_CHARS - 1)}…` : clean;
}
