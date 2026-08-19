// Turning terminal output back into plain text.
//
// Both the renderer (prompt sniffing) and the main process (reading the sftp
// client's answers off a pty) have to inspect output that was written to be
// displayed, not parsed: it carries colour, cursor movement and window-title
// sequences, and on Windows ConPTY it carries them even when the program itself
// emitted none.
//
// The patterns are built from named character constants rather than written as
// regex literals: an escape or bell inside a literal is an invisible control
// character in the source, which is both easy to destroy in a later edit and
// reported as a probable mistake by static analysis. Here it is deliberate.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** OSC (window title, cwd reports), terminated by BEL or ESC backslash. */
export const OSC_SEQUENCE = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
/** CSI (colour, cursor movement, erase). */
export const CSI_SEQUENCE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
/** Two-character escapes: charset selects, keypad mode, save/restore cursor. */
const SHORT_ESCAPE = new RegExp(ESC + '[()#%*+][0-9A-Za-z]|' + ESC + '[=><78MDEHc]', 'g');

/**
 * Drop the display control sequences, keeping the characters a person would see.
 *
 * Carriage returns are kept: a progress meter overwrites its own line with them,
 * and the reader needs to see that a new meter frame started. Line feeds are
 * kept for the same reason — they separate the records being parsed.
 */
export function stripAnsi(value: string): string {
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(SHORT_ESCAPE, '')
    .replace(new RegExp(BEL, 'g'), '');
}
