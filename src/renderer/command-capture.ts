// Knowing what command was run, from the marks a shell volunteers.
//
// OSC 133 is the semantic prompt protocol: `A` where the prompt starts, `B`
// where the user's input starts, `C` when the command is handed to the shell,
// and `D;<exit>` when it finishes. VS Code, kitty, WezTerm, Ghostty and Windows
// Terminal all consume these, which is the point of using them rather than
// inventing a ZeroG sequence that carried the command text outright: anyone who
// already has shell integration installed gets this having added nothing.
//
// The marks say where and when, never what. The command text is read from the
// grid between the `B` mark and the cursor at `C` — the same approach VS Code
// takes. That is why this module is given a way to read the grid rather than a
// stream to parse.
//
// The same bargain cwd-tracker.ts makes applies here: read what the shell
// volunteers, and report nothing rather than guessing when it volunteers
// nothing. A pane whose shell emits no marks records no commands, and the
// settings panel says so instead of quietly recording something wrong.

export type Position = { row: number; col: number };

/** The grid, and the clock, as this module needs them. */
export type CaptureIo = {
  cursor(): Position;
  /** Plain text between two positions, with the trailing blank cells dropped. */
  read(from: Position, to: Position): string;
  now(): number;
};

export type CapturedCommand = {
  command: string;
  /** Absent when the shell reported no status, which older marks do not. */
  exitCode?: number;
  /** How long the command ran, when both C and D arrived. */
  durationMs?: number;
};

export type CommandCapture = {
  /**
   * Handle one OSC 133 payload — the part after `133;`.
   *
   * Returns true to say the sequence was consumed. It has no visual meaning, so
   * there is nothing for xterm to do with it afterwards.
   */
  handle(payload: string): boolean;
  /** Whether this pane's shell has ever emitted a mark. */
  hasMarks(): boolean;
  /**
   * Is the shell waiting for input right now?
   *
   * True between `B` and `C`: input has started and no command is running. That
   * is the only moment it is safe to type something into a pane on the user's
   * behalf — a `cd` sent while vim or an agent holds the terminal goes to that
   * program instead. Only meaningful when hasMarks() is true; a shell that
   * reports nothing cannot be asked.
   */
  atPrompt(): boolean;
  /** Forget a half-finished command, for when the pane is reattached. */
  reset(): void;
};

export function createCommandCapture(io: CaptureIo, onCommand: (command: CapturedCommand) => void): CommandCapture {
  let inputStart: Position | null = null;
  let pending: { command: string; startedAt: number } | null = null;
  let sawMark = false;

  return {
    handle(payload: string): boolean {
      const kind = payload.charAt(0);
      sawMark = true;

      if (kind === 'A') {
        // A fresh prompt. Anything half-read belongs to the last one.
        inputStart = null;
        return true;
      }

      if (kind === 'B') {
        inputStart = io.cursor();
        return true;
      }

      if (kind === 'C') {
        // No B means there is nothing to read between: some shells emit C for a
        // command they ran themselves, and guessing at the text would invent one.
        if (!inputStart) return true;
        const command = io.read(inputStart, io.cursor()).trim();
        inputStart = null;
        // An empty line is Enter on an empty prompt, which is not a command.
        if (command) pending = { command, startedAt: io.now() };
        return true;
      }

      if (kind === 'D') {
        const command = pending;
        pending = null;
        if (!command) return true;
        const exitCode = parseExitCode(payload);
        onCommand({
          command: command.command,
          ...(exitCode === undefined ? {} : { exitCode }),
          durationMs: Math.max(0, io.now() - command.startedAt)
        });
        return true;
      }

      // An unknown mark. Consumed rather than passed on: it is still OSC 133,
      // and nothing else in the app has a use for it.
      return true;
    },

    hasMarks(): boolean {
      return sawMark;
    },

    atPrompt(): boolean {
      return inputStart !== null && pending === null;
    },

    reset(): void {
      inputStart = null;
      pending = null;
    }
  };
}

/**
 * The status out of a `D` payload.
 *
 * `D` alone is legal and means "finished, status unknown" — which is different
 * from success, and must not be recorded as zero. A non-numeric status is
 * treated the same way rather than guessed at.
 */
export function parseExitCode(payload: string): number | undefined {
  const parts = payload.split(';');
  if (parts.length < 2) return undefined;
  // Digits only, and at least one: `Number('')` is 0, which would record a
  // status-less `D;` as a success and let a failed command outrank one that
  // worked.
  const text = parts[1].trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return value <= 255 ? value : undefined;
}

/**
 * Read a range out of an xterm buffer.
 *
 * Kept here beside the state machine that needs it, but taking the two buffer
 * methods rather than a Terminal, so the walk itself can be tested against a
 * plain array of lines.
 */
export function readBufferRange(
  lineAt: (row: number) => string | undefined,
  from: Position,
  to: Position
): string {
  if (to.row < from.row || (to.row === from.row && to.col <= from.col)) return '';
  const lines: string[] = [];
  for (let row = from.row; row <= to.row; row += 1) {
    const line = lineAt(row) ?? '';
    const start = row === from.row ? from.col : 0;
    const end = row === to.row ? to.col : line.length;
    lines.push(line.slice(start, end));
  }
  // A command wrapped across rows is one command: xterm reports the wrap as
  // separate lines, and joining with a newline would make it look like two.
  return lines.join('').replace(/\s+$/, '');
}
