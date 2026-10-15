import { createRequire } from 'node:module';
import type { PtyProcess, SpawnPty } from './session-service.js';

const require = createRequire(import.meta.url);

/** All three PTY owners must finish native teardown before Electron exits. */
export class PtyLifecycle {
  private closing = false;
  private readonly processes = new Map<PtyProcess, Promise<void>>();
  constructor(private readonly spawn: SpawnPty) {}

  readonly start: SpawnPty = (file, args, options) => {
    if (this.closing) throw new Error('The application is shutting down.');
    const process = this.spawn(file, args, options);
    let exited!: () => void;
    this.processes.set(process, new Promise<void>((resolve) => { exited = resolve; }));
    process.onExit(() => { this.processes.delete(process); exited(); });
    return process;
  };

  async shutdown(timeoutMs = 6000): Promise<void> {
    this.closing = true;
    const waiting = [...this.processes.values()];
    for (const process of this.processes.keys()) {
      try { process.kill(); } catch { /* exit callback may already be queued */ }
    }
    if (!waiting.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(waiting),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PTY shutdown timed out.')), timeoutMs);
        })
      ]);
    } finally { clearTimeout(timer); }
  }
}

const lifecycle = new PtyLifecycle((file, args, options) => require('node-pty').spawn(file, args, options));
export const spawnManagedPty = lifecycle.start;
export const shutdownPtys = () => lifecycle.shutdown();
