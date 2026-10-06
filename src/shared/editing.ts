// What the built-in editor and the main process both need to agree on.

/** The largest file the editor will open or save. Past this it is not a text file to edit by hand. */
export const MAX_EDIT_BYTES = 1024 * 1024;

/**
 * What a refused save says when the file changed after it was loaded.
 *
 * The renderer tells this apart from any other failure by the text, because an
 * IPC rejection carries nothing but its message — and the two deserve different
 * responses: a conflict offers to overwrite or reload, a failure just says so.
 */
export const EDIT_CONFLICT_MESSAGE = 'This file changed on disk after it was opened.';
