import type { PtyProcess, SpawnPty } from '../../src/main/session-service';

export type FakePty = {
  file: string;
  args: string[];
  /** Everything the service wrote to this pty, in order. */
  writes: string[];
  /** Push output as though the shell had produced it. */
  emit: (data: string) => void;
  killed: boolean;
};

/**
 * A stand-in for node-pty. Lets tests drive output and observe input without
 * starting a shell, so assertions do not depend on how fast the host spawns
 * bash or whether bash exists at all.
 */
export function createFakePty(): { spawn: SpawnPty; spawned: FakePty[] } {
  const spawned: FakePty[] = [];

  const spawn: SpawnPty = (file, args) => {
    let onData: (data: string) => void = () => undefined;
    let onExit: () => void = () => undefined;

    const record: FakePty = {
      file,
      args,
      writes: [],
      emit: (data) => onData(data),
      killed: false
    };
    spawned.push(record);

    const proc: PtyProcess = {
      write: (data) => { record.writes.push(data); },
      resize: () => undefined,
      kill: () => {
        if (record.killed) return;
        record.killed = true;
        onExit();
      },
      onData: (listener) => { onData = listener; },
      onExit: (listener) => { onExit = listener; }
    };
    return proc;
  };

  return { spawn, spawned };
}
