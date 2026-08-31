// Named secrets, encrypted at rest by the operating system.
//
// The renderer keeps its settings in localStorage, which is a plain file on
// disk: fine for a font choice, wrong for an API key. So keys live here
// instead, in the main process, encrypted through Electron's safeStorage —
// DPAPI on Windows, Keychain on macOS, libsecret or kwallet on Linux. The
// ciphertext file is useless to another user account on the same machine, and
// nothing readable is written anywhere the renderer can reach.
//
// safeStorage can report that encryption is unavailable, which happens on a
// Linux box with no keyring configured. When it does, storing is refused
// rather than quietly downgraded to plaintext: a key the user believes is
// protected must not be written in the clear. The caller is told, and can
// offer to hold the key in memory for the session instead.
//
// The crypto is injected so this module can be tested without Electron.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;

type SecretsFile = { version: number; secrets: Record<string, string> };

/** The part of Electron's safeStorage this needs. */
export type SecretCrypto = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

export type SecretStoreOptions = {
  filePath: string;
  crypto: SecretCrypto;
};

/** Thrown when the platform cannot encrypt, so nothing was written. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('This system has no secret store available, so the key cannot be saved safely.');
    this.name = 'EncryptionUnavailableError';
  }
}

export class SecretStore {
  private readonly filePath: string;
  private readonly crypto: SecretCrypto;
  /** Serialised so two saves in flight cannot interleave read-modify-write. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: SecretStoreOptions) {
    this.filePath = options.filePath;
    this.crypto = options.crypto;
  }

  /** Can this platform encrypt at all? Asked before offering to store a key. */
  encryptionAvailable(): boolean {
    try {
      return this.crypto.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Is a secret stored under this name? Does not decrypt it. */
  async has(name: string): Promise<boolean> {
    const secrets = await this.read();
    return typeof secrets[name] === 'string';
  }

  /**
   * The stored secret, or null when there is none.
   *
   * A value that will not decrypt is treated as absent: that is what a file
   * copied from another machine or another user account looks like, and there
   * is nothing to do with it but ask for the key again.
   */
  async get(name: string): Promise<string | null> {
    const stored = (await this.read())[name];
    if (typeof stored !== 'string') return null;
    try {
      const value = this.crypto.decryptString(Buffer.from(stored, 'base64'));
      return value || null;
    } catch {
      return null;
    }
  }

  /** Store a secret, replacing any previous one of that name. */
  async set(name: string, value: string): Promise<void> {
    if (!value) {
      await this.clear(name);
      return;
    }
    if (!this.encryptionAvailable()) throw new EncryptionUnavailableError();
    const encrypted = this.crypto.encryptString(value).toString('base64');
    await this.update((secrets) => ({ ...secrets, [name]: encrypted }));
  }

  /** Forget a secret. Returns whether there was one. */
  async clear(name: string): Promise<boolean> {
    let existed = false;
    await this.update((secrets) => {
      existed = typeof secrets[name] === 'string';
      const next = { ...secrets };
      delete next[name];
      return next;
    });
    return existed;
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!isSecretsFile(parsed)) return {};
      return parsed.secrets;
    } catch {
      // No file yet, or one this version cannot read: no secrets stored.
      return {};
    }
  }

  private async update(change: (secrets: Record<string, string>) => Record<string, string>): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const secrets = change(await this.read());
      const snapshot: SecretsFile = { version: SCHEMA_VERSION, secrets };
      await mkdir(dirname(this.filePath), { recursive: true });
      if (Object.keys(secrets).length === 0) {
        // Nothing left to keep: remove the file rather than leaving an empty
        // one behind, so "no key stored" looks the same as never having one.
        await unlink(this.filePath).catch(() => undefined);
        return;
      }
      const temp = join(dirname(this.filePath), `.secrets.tmp-${process.pid}-${randomUUID()}`);
      // 0600, and written whole then renamed, so a crash cannot leave a
      // half-written key behind for the next read to find.
      await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
      try {
        await rename(temp, this.filePath);
      } catch (error) {
        // The temp file holds the same ciphertext under the same 0600 as the
        // destination, so this is tidiness rather than a leak — but an orphan
        // per failed write, each with a key the user may since have rotated,
        // is not something to leave lying around.
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
    await this.writeQueue;
  }
}

function isSecretsFile(value: unknown): value is SecretsFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as { version?: unknown; secrets?: unknown };
  if (file.version !== SCHEMA_VERSION) return false;
  if (typeof file.secrets !== 'object' || file.secrets === null) return false;
  return Object.values(file.secrets as Record<string, unknown>).every((entry) => typeof entry === 'string');
}

export function defaultSecretsPath(userDataPath: string): string {
  return join(userDataPath, 'secrets.json');
}

/** The name the speech server key is stored under. */
export const SPEECH_API_KEY = 'speech.serverApiKey';

/**
 * The name the AI endpoint key is stored under.
 *
 * Separate from the speech key: the two point at different services often
 * enough — a local Ollama and a hosted transcription server, say — that sharing
 * one key would be wrong more often than right.
 */
export const AI_API_KEY = 'ai.serverApiKey';
