import type { PtyProcess, SpawnPty } from '../../src/main/session-service';

export type FakePty = {
  file: string;
  args: string[];
  /** The size the shell was started at. */
  size: { cols: number; rows: number };
  /** Every resize that reached this pty, in order. */
  resizes: { cols: number; rows: number }[];
  /** Everything the service wrote to this pty, in order. */
  writes: string[];
  /** Push output as though the shell had produced it. */
  emit: (data: string) => void;
  /**
   * End the process as though it had exited on its own.
   *
   * Distinct from `killed`, which records the service deciding to end it: a
   * client that quits by itself is what a failed `ssh -o ExitOnForwardFailure`
   * does, and the service has to handle that without having asked for it.
   */
  exit: () => void;
  killed: boolean;
};

/**
 * A stand-in for node-pty. Lets tests drive output and observe input without
 * starting a shell, so assertions do not depend on how fast the host spawns
 * bash or whether bash exists at all.
 */
export function createFakePty(): { spawn: SpawnPty; spawned: FakePty[] } {
  const spawned: FakePty[] = [];

  const spawn: SpawnPty = (file, args, options) => {
    let onData: (data: string) => void = () => undefined;
    let onExit: () => void = () => undefined;
    let ended = false;

    const record: FakePty = {
      file,
      args,
      size: { cols: options.cols, rows: options.rows },
      resizes: [],
      writes: [],
      emit: (data) => onData(data),
      exit: () => {
        if (ended) return;
        ended = true;
        onExit();
      },
      killed: false
    };
    spawned.push(record);

    const proc: PtyProcess = {
      write: (data) => { record.writes.push(data); },
      resize: (cols, rows) => { record.resizes.push({ cols, rows }); },
      kill: () => {
        if (record.killed) return;
        record.killed = true;
        if (ended) return;
        ended = true;
        onExit();
      },
      onData: (listener) => { onData = listener; },
      onExit: (listener) => { onExit = listener; }
    };
    return proc;
  };

  return { spawn, spawned };
}
