import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { SessionInfo } from '../shared/types.js';

export interface KnownConnection {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  source?: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/;

/**
 * Is this a hostname ZeroG will put in front of an SSH client?
 *
 * Exported so the port-forwarding side vets the far end of a tunnel by the same
 * rule that vets a HostName here, rather than carrying a second copy of it that
 * can drift. The leading-alphanumeric requirement is the load-bearing part: the
 * value ends up in an argv element, and one starting with '-' reads as an option.
 */
export function isSshHostName(value: string): boolean {
  return HOST.test(value);
}
// Must start alphanumeric like TOKEN/HOST above: the user is concatenated into
// `user@host`, so a leading '-' makes the whole destination look like an option
// to ssh's getopt (`-Fevil.cfg@host` reads an attacker-chosen config file).
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCREEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$/;

function words(value: string): string[] {
  const result: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (let match; (match = re.exec(value));) result.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  return result;
}

export function parseSshConfig(text: string, source?: string): KnownConnection[] {
  const entries: KnownConnection[] = [];
  let current: KnownConnection[] = [];
  const flush = () => { entries.push(...current); current = []; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const args = words(match[2].trim());
    if (key === 'host') {
      flush();
      const aliases = args.filter((alias) => !alias.includes('*') && !alias.includes('?') && TOKEN.test(alias));
      current = aliases.map((alias) => ({ alias, source }));
      continue;
    }
    if (!current.length || !args[0]) continue;
    const value = args[0];
    for (const entry of current) {
      if (key === 'hostname' && !entry.hostName) entry.hostName = value;
      else if (key === 'user' && !entry.user && USER.test(value)) entry.user = value;
      else if (key === 'port' && !entry.port && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) entry.port = Number(value);
      else if (key === 'identityfile' && !entry.identityFile) entry.identityFile = value;
    }
  }
  flush();
  return entries;
}

export async function listKnownConnections(path = `${homedir()}/.ssh/config`): Promise<KnownConnection[]> {
  try { return parseSshConfig(await readFile(path, 'utf8'), path); } catch { return []; }
}

export function validateKnownConnection(input: unknown): KnownConnection {
  if (!input || typeof input !== 'object') throw new Error('Invalid SSH connection.');
  const value = input as Record<string, unknown>;
  if (typeof value.alias !== 'string' || !TOKEN.test(value.alias)) throw new Error('Invalid SSH alias.');
  const result: KnownConnection = { alias: value.alias };
  if (value.hostName !== undefined) { if (typeof value.hostName !== 'string' || !HOST.test(value.hostName)) throw new Error('Invalid SSH hostname.'); result.hostName = value.hostName; }
  if (value.user !== undefined) { if (typeof value.user !== 'string' || !USER.test(value.user)) throw new Error('Invalid SSH user.'); result.user = value.user; }
  if (value.port !== undefined) { if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) throw new Error('Invalid SSH port.'); result.port = value.port as number; }
  if (value.identityFile !== undefined) { if (typeof value.identityFile !== 'string' || value.identityFile.length > 4096 || /[\0\r\n]/.test(value.identityFile)) throw new Error('Invalid identity file metadata.'); result.identityFile = value.identityFile; }
  if (value.source !== undefined && typeof value.source === 'string') result.source = value.source;
  return result;
}

function sshArgs(connection: KnownConnection): string[] {
  const c = validateKnownConnection(connection);
  const destination = c.user ? `${c.user}@${c.hostName ?? c.alias}` : (c.hostName ?? c.alias);
  const args: string[] = [];
  if (c.port) args.push('-p', String(c.port));
  args.push(destination, '--');
  return args;
}

export function buildRemoteScreenDiscoveryArgs(connection: KnownConnection): { file: string; args: string[] } {
  return { file: 'ssh', args: [...sshArgs(connection), 'screen', '-ls'] };
}

export function buildRemoteScreenAttachArgs(connection: KnownConnection, screenName: string): { file: string; args: string[] } {
  if (!SCREEN.test(screenName)) throw new Error('Invalid screen session name.');
  return { file: 'ssh', args: [...sshArgs(connection), 'screen', '-x', screenName] };
}

export function parseRemoteScreenList(output: string, host: string): SessionInfo[] {
  if (!TOKEN.test(host)) throw new Error('Invalid remote host identity.');
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^\d+\.(\S+)\s+\(([^)]+)\)/);
    if (!match || !SCREEN.test(match[1])) return [];
    const name = match[1];
    return [{ id: `remote:${host}:${name}`, name, kind: 'ssh', host, cwd: '~', status: /attached/i.test(match[2]) ? 'connected' : 'detached', lastSeen: new Date().toISOString(), persistence: 'screen', sshTarget: host, backend: 'screen', scope: 'remote', source: 'discovered', screenName: name }];
  });
}
