import { describe, expect, it } from 'vitest';
import {
  createCommandCapture,
  parseExitCode,
  readBufferRange,
  type CapturedCommand,
  type Position
} from '../src/renderer/command-capture';

/**
 * A fake pane: lines of text and a cursor that can be moved.
 *
 * Stands in for xterm's buffer so the state machine is tested against what it
 * actually depends on — where the cursor was when each mark arrived — rather than
 * against a running terminal.
 */
function pane(lines: string[] = ['$ '], cursor: Position = { row: 0, col: 2 }) {
  let now = 1000;
  const state = { lines, cursor };
  const commands: CapturedCommand[] = [];
  const capture = createCommandCapture(
    {
      cursor: () => state.cursor,
      read: (from, to) => readBufferRange((row) => state.lines[row], from, to),
      now: () => now
    },
    (command) => commands.push(command)
  );
  return {
    capture,
    commands,
    /** Type at the cursor, as a shell echoing keystrokes would. */
    type(text: string) {
      const line = state.lines[state.cursor.row] ?? '';
      state.lines[state.cursor.row] = line.slice(0, state.cursor.col) + text;
      state.cursor = { row: state.cursor.row, col: state.cursor.col + text.length };
    },
    at(row: number, col: number) {
      state.cursor = { row, col };
    },
    advance(ms: number) {
      now += ms;
    }
  };
}

describe('a full prompt cycle', () => {
  it('records the command, its status and how long it took', () => {
    const p = pane();
    p.capture.handle('A');
    p.capture.handle('B');
    p.type('git status');
    p.advance(250);
    p.capture.handle('C');
    p.advance(1200);
    p.capture.handle('D;0');
    expect(p.commands).toEqual([{ command: 'git status', exitCode: 0, durationMs: 1200 }]);
  });

  it('records a failure as a failure', () => {
    const p = pane();
    p.capture.handle('B');
    p.type('git psuh');
    p.capture.handle('C');
    p.capture.handle('D;1');
    expect(p.commands[0]).toMatchObject({ command: 'git psuh', exitCode: 1 });
  });

  it('records several commands in order', () => {
    const p = pane(['$ ', '$ '], { row: 0, col: 2 });
    p.capture.handle('B');
    p.type('one');
    p.capture.handle('C');
    p.capture.handle('D;0');
    p.at(1, 2);
    p.capture.handle('B');
    p.type('two');
    p.capture.handle('C');
    p.capture.handle('D;0');
    expect(p.commands.map((c) => c.command)).toEqual(['one', 'two']);
  });
});

describe('what must not be recorded', () => {
  it('records nothing when the shell emits no marks', () => {
    // The whole point of reading marks rather than guessing: a pane with no
    // shell integration records nothing, instead of something wrong.
    const p = pane();
    p.type('git status');
    expect(p.commands).toEqual([]);
    expect(p.capture.hasMarks()).toBe(false);
  });

  it('records nothing for Enter on an empty prompt', () => {
    const p = pane();
    p.capture.handle('B');
    p.capture.handle('C');
    p.capture.handle('D;0');
    expect(p.commands).toEqual([]);
  });

  it('invents nothing when C arrives with no B before it', () => {
    // Some shells emit C for a command they ran themselves; there is no user
    // input to read, and reading the grid anyway would fabricate one.
    const p = pane(['$ some output here'], { row: 0, col: 18 });
    p.capture.handle('C');
    p.capture.handle('D;0');
    expect(p.commands).toEqual([]);
  });

  it('ignores a D with nothing pending', () => {
    const p = pane();
    p.capture.handle('D;0');
    expect(p.commands).toEqual([]);
  });

  it('drops a half-read command when a new prompt starts', () => {
    // A fresh A means the last prompt is over: Ctrl-C, or a resize redraw.
    const p = pane();
    p.capture.handle('B');
    p.type('abandoned');
    p.capture.handle('A');
    p.capture.handle('C');
    p.capture.handle('D;0');
    expect(p.commands).toEqual([]);
  });

  it('forgets a pending command when the pane is reset', () => {
    const p = pane();
    p.capture.handle('B');
    p.type('git status');
    p.capture.handle('C');
    p.capture.reset();
    p.capture.handle('D;0');
    expect(p.commands).toEqual([]);
  });
});

describe('reading the command out of the grid', () => {
  it('reads a command that wrapped across rows as one command', () => {
    // xterm reports a wrap as separate lines; joining with a newline would make
    // one command look like two.
    const p = pane(['$ grep -rn "something long" ', 'src/renderer --include=*.ts'], { row: 0, col: 2 });
    p.capture.handle('B');
    p.at(1, 27);
    p.capture.handle('C');
    p.capture.handle('D;0');
    expect(p.commands[0].command).toBe('grep -rn "something long" src/renderer --include=*.ts');
  });

  it('reads only what follows the prompt', () => {
    const p = pane(['user@host:~$ npm test'], { row: 0, col: 13 });
    p.capture.handle('B');
    p.at(0, 21);
    p.capture.handle('C');
    p.capture.handle('D;0');
    expect(p.commands[0].command).toBe('npm test');
  });
});

describe('hasMarks', () => {
  it('turns true on the first mark of any kind', () => {
    const p = pane();
    expect(p.capture.hasMarks()).toBe(false);
    p.capture.handle('A');
    expect(p.capture.hasMarks()).toBe(true);
  });
});

describe('parseExitCode', () => {
  it('reads the status out of a D payload', () => {
    expect(parseExitCode('D;0')).toBe(0);
    expect(parseExitCode('D;1')).toBe(1);
    expect(parseExitCode('D;130')).toBe(130);
  });

  it('is undefined for a D that reported none', () => {
    // "Finished, status unknown" is not the same as success, and recording it as
    // zero would let a failed command outrank a successful one.
    expect(parseExitCode('D')).toBeUndefined();
  });

  it('is undefined for a status that is not one', () => {
    expect(parseExitCode('D;')).toBeUndefined();
    expect(parseExitCode('D;oops')).toBeUndefined();
    expect(parseExitCode('D;-1')).toBeUndefined();
    expect(parseExitCode('D;999')).toBeUndefined();
    expect(parseExitCode('D;1.5')).toBeUndefined();
  });

  it('keeps the status when a payload carries extra parameters', () => {
    expect(parseExitCode('D;0;ms=120')).toBe(0);
  });
});

describe('readBufferRange', () => {
  const lines = ['first line', 'second line', 'third line'];
  const lineAt = (row: number) => lines[row];

  it('reads within one row', () => {
    expect(readBufferRange(lineAt, { row: 0, col: 6 }, { row: 0, col: 10 })).toBe('line');
  });

  it('reads across rows', () => {
    expect(readBufferRange(lineAt, { row: 0, col: 6 }, { row: 1, col: 6 })).toBe('linesecond');
  });

  it('is empty when the range is backwards or empty', () => {
    expect(readBufferRange(lineAt, { row: 1, col: 0 }, { row: 0, col: 5 })).toBe('');
    expect(readBufferRange(lineAt, { row: 0, col: 5 }, { row: 0, col: 5 })).toBe('');
  });

  it('tolerates a row that is not there', () => {
    expect(readBufferRange(lineAt, { row: 0, col: 0 }, { row: 9, col: 3 })).toBe('first linesecond linethird line');
  });

  it('drops the blank cells a terminal pads a row with', () => {
    expect(readBufferRange((row) => ['$ ls -la          '][row], { row: 0, col: 2 }, { row: 0, col: 18 })).toBe('ls -la');
  });
});
