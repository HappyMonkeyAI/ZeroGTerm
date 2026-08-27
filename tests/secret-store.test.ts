import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptionUnavailableError, SPEECH_API_KEY, SecretStore, defaultSecretsPath } from '../src/main/secret-store';

/**
 * Stands in for Electron's safeStorage. The "encryption" is a reversible
 * transform: what matters to these tests is that the store round-trips
 * whatever the platform gives it and never writes the plaintext itself.
 */
function fakeCrypto(options: { available?: boolean } = {}) {
  const available = options.available ?? true;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`.split('').reverse().join(''), 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8').split('').reverse().join('');
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return text.slice(4);
    }
  };
}

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'zerog-secrets-')), 'secrets.json');
}

describe('secret store', () => {
  it('round trips a secret through the platform crypto', async () => {
    const path = await file();
    const store = new SecretStore({ filePath: path, crypto: fakeCrypto() });
    await store.set(SPEECH_API_KEY, 'sk-test-123');

    expect(await store.has(SPEECH_API_KEY)).toBe(true);
    expect(await store.get(SPEECH_API_KEY)).toBe('sk-test-123');
    // A second store reading the same file: this is what a restart looks like.
    expect(await new SecretStore({ filePath: path, crypto: fakeCrypto() }).get(SPEECH_API_KEY)).toBe('sk-test-123');
  });

  it('never writes the plaintext to disk', async () => {
    const path = await file();
    await new SecretStore({ filePath: path, crypto: fakeCrypto() }).set(SPEECH_API_KEY, 'sk-secret-value');
    const written = await readFile(path, 'utf8');
    expect(written).not.toContain('sk-secret-value');
    expect(written).toContain('speech.serverApiKey');
  });

  it('refuses to store anything when the platform cannot encrypt', async () => {
    const path = await file();
    const store = new SecretStore({ filePath: path, crypto: fakeCrypto({ available: false }) });
    // Refused rather than downgraded: a key the user believes is protected
    // must not end up in the clear.
    await expect(store.set(SPEECH_API_KEY, 'sk-test-123')).rejects.toThrow(EncryptionUnavailableError);
    expect(store.encryptionAvailable()).toBe(false);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('treats an empty value as clearing, and removes the file with nothing left', async () => {
    const path = await file();
    const store = new SecretStore({ filePath: path, crypto: fakeCrypto() });
    await store.set(SPEECH_API_KEY, 'sk-test-123');
    await store.set(SPEECH_API_KEY, '');

    expect(await store.has(SPEECH_API_KEY)).toBe(false);
    expect(await store.get(SPEECH_API_KEY)).toBeNull();
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('reports whether there was a secret to clear', async () => {
    const store = new SecretStore({ filePath: await file(), crypto: fakeCrypto() });
    expect(await store.clear(SPEECH_API_KEY)).toBe(false);
    await store.set(SPEECH_API_KEY, 'sk-test-123');
    expect(await store.clear(SPEECH_API_KEY)).toBe(true);
  });

  it('keeps other secrets when one is cleared', async () => {
    const store = new SecretStore({ filePath: await file(), crypto: fakeCrypto() });
    await store.set(SPEECH_API_KEY, 'sk-speech');
    await store.set('other', 'sk-other');
    await store.clear(SPEECH_API_KEY);

    expect(await store.get(SPEECH_API_KEY)).toBeNull();
    expect(await store.get('other')).toBe('sk-other');
  });

  it('serialises concurrent writes rather than losing one', async () => {
    const store = new SecretStore({ filePath: await file(), crypto: fakeCrypto() });
    await Promise.all([store.set('a', '1'), store.set('b', '2'), store.set('c', '3')]);

    expect(await store.get('a')).toBe('1');
    expect(await store.get('b')).toBe('2');
    expect(await store.get('c')).toBe('3');
  });

  it('treats a value it cannot decrypt as no value at all', async () => {
    const path = await file();
    // What a file copied from another machine or user account looks like: the
    // ciphertext is there, but this system's key will not open it.
    await writeFile(path, JSON.stringify({ version: 1, secrets: { [SPEECH_API_KEY]: Buffer.from('garbage').toString('base64') } }));
    const store = new SecretStore({ filePath: path, crypto: fakeCrypto() });

    expect(await store.has(SPEECH_API_KEY)).toBe(true);
    expect(await store.get(SPEECH_API_KEY)).toBeNull();
  });

  it('tolerates a malformed or unreadable file', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    expect(await new SecretStore({ filePath: path, crypto: fakeCrypto() }).get(SPEECH_API_KEY)).toBeNull();

    await writeFile(path, JSON.stringify({ version: 99, secrets: { [SPEECH_API_KEY]: 'x' } }));
    expect(await new SecretStore({ filePath: path, crypto: fakeCrypto() }).has(SPEECH_API_KEY)).toBe(false);
  });

  it('puts the file next to the app data, not in the project', () => {
    expect(defaultSecretsPath('/home/u/.config/ZeroG')).toBe(join('/home/u/.config/ZeroG', 'secrets.json'));
  });
});
