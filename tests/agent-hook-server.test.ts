import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentHookServer,
  buildHookSettings,
  buildLaunchCommand,
  parseHookPayload
} from '../src/main/agent-hook-server';
import type { AgentHookEvent } from '../src/main/pane-link';

describe('parseHookPayload', () => {
  it('reads a Stop payload', () => {
    expect(parseHookPayload('s1', { hook_event_name: 'Stop', last_assistant_message: 'hi', session_id: 'x' })).toEqual({
      sessionId: 's1',
      event: 'Stop',
      message: 'hi',
      notificationType: undefined,
      reason: undefined
    });
  });

  it('reads notification and session-end fields', () => {
    expect(parseHookPayload('s1', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })?.notificationType).toBe('permission_prompt');
    expect(parseHookPayload('s1', { hook_event_name: 'SessionEnd', reason: 'clear' })?.reason).toBe('clear');
  });

  it('ignores events it does not observe and malformed payloads', () => {
    expect(parseHookPayload('s1', { hook_event_name: 'PreToolUse' })).toBeUndefined();
    expect(parseHookPayload('s1', { hook_event_name: 42 })).toBeUndefined();
    expect(parseHookPayload('s1', null)).toBeUndefined();
    expect(parseHookPayload('s1', 'Stop')).toBeUndefined();
  });

  it('ignores non-string message fields instead of trusting them', () => {
    expect(parseHookPayload('s1', { hook_event_name: 'Stop', last_assistant_message: { x: 1 } })?.message).toBeUndefined();
  });
});

describe('buildHookSettings', () => {
  it('points the four observed events at one http hook and nothing else', () => {
    const settings = buildHookSettings('http://127.0.0.1:1/hook/abc');
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'SessionEnd', 'Stop', 'UserPromptSubmit']);
    for (const entries of Object.values(settings.hooks)) {
      expect(entries).toEqual([{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hook/abc' }] }]);
    }
  });
});

describe('buildLaunchCommand', () => {
  it('appends the settings file with forward slashes in double quotes', () => {
    expect(buildLaunchCommand('claude', 'C:\\Users\\Me Too\\pane-link\\agent-1.json')).toBe(
      'claude --settings "C:/Users/Me Too/pane-link/agent-1.json"'
    );
  });

  it('keeps the user command as configured', () => {
    expect(buildLaunchCommand('  claude --model opus ', '/tmp/a.json')).toBe('claude --model opus --settings "/tmp/a.json"');
  });

  it('refuses commands that could run more than one line', () => {
    expect(() => buildLaunchCommand('claude\nrm -rf /', '/tmp/a.json')).toThrow(/single line/);
    expect(() => buildLaunchCommand('cla\rude', '/tmp/a.json')).toThrow(/single line/);
    expect(() => buildLaunchCommand('', '/tmp/a.json')).toThrow(/1 to 200/);
    expect(() => buildLaunchCommand('x'.repeat(201), '/tmp/a.json')).toThrow(/1 to 200/);
  });

  it('refuses a settings path that would break out of the quotes', () => {
    expect(() => buildLaunchCommand('claude', '/tmp/a"b.json')).toThrow(/quote/);
  });
});

describe('AgentHookServer', () => {
  let dir: string;
  let events: AgentHookEvent[];
  let server: AgentHookServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zerog-hooks-test-'));
    events = [];
    server = new AgentHookServer({ settingsDir: dir, onEvent: (event) => events.push(event) });
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function hookUrl(sessionId: string): Promise<string> {
    const { settingsPath } = await server.register(sessionId);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    return settings.hooks.Stop[0].hooks[0].url as string;
  }

  const post = (url: string, body: unknown, method = 'POST') =>
    fetch(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });

  it('writes a settings file whose url is loopback-only and carries a long random token', async () => {
    const url = await hookUrl('s1');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]{48}$/);
  });

  it('delivers a hook event to the session that owns the token', async () => {
    const url = await hookUrl('s1');
    const response = await post(url, { hook_event_name: 'Stop', last_assistant_message: 'done' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(events).toMatchObject([{ sessionId: 's1', event: 'Stop', message: 'done' }]);
  });

  it('keeps two agents apart by token', async () => {
    const one = await hookUrl('s1');
    const two = await hookUrl('s2');
    expect(one).not.toBe(two);
    await post(two, { hook_event_name: 'UserPromptSubmit' });
    expect(events.map((event) => event.sessionId)).toEqual(['s2']);
  });

  it('does not let a payload claim to be another session', async () => {
    const url = await hookUrl('s1');
    await post(url, { hook_event_name: 'Stop', last_assistant_message: 'x', session_id: 's2', sessionId: 's2' });
    expect(events.map((event) => event.sessionId)).toEqual(['s1']);
  });

  it('answers 404 for an unknown token without calling the handler', async () => {
    const url = await hookUrl('s1');
    const wrong = url.replace(/[0-9a-f]{48}$/, '0'.repeat(48));
    const response = await post(wrong, { hook_event_name: 'Stop', last_assistant_message: 'x' });
    expect(response.status).toBe(404);
    expect(events).toEqual([]);
  });

  it('answers 405 to anything but POST', async () => {
    const url = await hookUrl('s1');
    expect((await post(url, undefined, 'GET')).status).toBe(405);
    expect(events).toEqual([]);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const url = await hookUrl('s1');
    const response = await fetch(url, { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
    expect(events).toEqual([]);
  });

  it('refuses a payload over the size limit', async () => {
    const url = await hookUrl('s1');
    const response = await post(url, { hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(3 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect(events).toEqual([]);
  });

  it('accepts but ignores events it does not observe', async () => {
    const url = await hookUrl('s1');
    expect((await post(url, { hook_event_name: 'PreToolUse' })).status).toBe(200);
    expect(events).toEqual([]);
  });

  it('revokes the token and deletes the settings file on unregister', async () => {
    const { settingsPath } = await server.register('s1');
    const url = JSON.parse(await readFile(settingsPath, 'utf8')).hooks.Stop[0].hooks[0].url as string;
    await server.unregister('s1');
    expect((await post(url, { hook_event_name: 'Stop', last_assistant_message: 'x' })).status).toBe(404);
    await expect(stat(settingsPath)).rejects.toThrow();
  });

  it('replaces the earlier registration when a session is registered again', async () => {
    const first = await hookUrl('s1');
    const second = await hookUrl('s1');
    expect(first).not.toBe(second);
    expect((await post(first, { hook_event_name: 'Stop', last_assistant_message: 'x' })).status).toBe(404);
    expect((await post(second, { hook_event_name: 'Stop', last_assistant_message: 'x' })).status).toBe(200);
  });

  it('removes every settings file when stopped', async () => {
    const { settingsPath } = await server.register('s1');
    await server.stop();
    await expect(stat(settingsPath)).rejects.toThrow();
  });
});
