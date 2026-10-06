// What makes a file safe to put in the editor's text box, shared by the local and
// the remote read so the two cannot disagree about it.

import { MAX_EDIT_BYTES } from '../shared/editing.js';

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Throws unless a file of this size may be opened. */
export function checkEditableSize(size: number): void {
  if (size > MAX_EDIT_BYTES) {
    throw new Error(`That file is ${megabytes(size)}; the editor opens files up to ${megabytes(MAX_EDIT_BYTES)}.`);
  }
}

/**
 * The file's bytes as text, or the reason it cannot be edited.
 *
 * Refused rather than coaxed: a NUL byte (the usual mark of a binary) and bytes
 * that are not valid UTF-8 would each be damaged by a round trip through a text
 * box, and a refused open costs nothing where a corrupted save does. The BOM is
 * kept as a character so a save writes it back.
 */
export function decodeEditable(bytes: Uint8Array): string {
  checkEditableSize(bytes.length);
  if (bytes.includes(0)) throw new Error('That looks like a binary file, so it was not opened.');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('That file is not valid UTF-8, so it was not opened.');
  }
}
