// System clipboard writes, verified.
//
// Only the main process can reach the OS clipboard, and Electron's writeText
// returns nothing: when the write loses a race for the clipboard — common on
// Windows, where a single owner holds it and clipboard-history tools poll it —
// the renderer has no way to know the text never landed. Reading back turns
// that silent loss into a retry, and then into a reportable error.

/** The slice of Electron's clipboard module used here. */
export type ClipboardSurface = {
  writeText(text: string): void;
  readText(): string;
};

/**
 * Did the text land, allowing for line-ending translation?
 *
 * Windows stores clipboard text with CRLF line endings, so a multi-line copy
 * legitimately reads back changed. Comparing raw would report every multi-line
 * copy as a failure.
 */
export function clipboardTextMatches(written: string, readBack: string): boolean {
  return written.replace(/\r\n/g, '\n') === readBack.replace(/\r\n/g, '\n');
}

/**
 * Write text to the clipboard and confirm it is there, retrying once.
 *
 * The retry is the useful part: clipboard ownership contention is momentary,
 * and a second attempt normally succeeds where the first was refused.
 */
export function writeClipboardText(clipboard: ClipboardSurface, text: string): boolean {
  clipboard.writeText(text);
  if (clipboardTextMatches(text, clipboard.readText())) return true;
  clipboard.writeText(text);
  return clipboardTextMatches(text, clipboard.readText());
}
