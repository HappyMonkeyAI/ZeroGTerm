/**
 * The message a main-process error actually carries.
 *
 * Electron wraps a rejected ipcMain handler as "Error invoking remote method
 * 'channel': Error: …", which buries a sentence written for the user behind two
 * layers of plumbing they have no use for. The main process takes trouble over
 * those sentences — "Port 3000 is already shared from build.example.com", "Could
 * not reach http://…/v1/chat/completions. Is the server running?" — and they are
 * worth showing as written.
 */
export function ipcMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error|TypeError):\s*/, '');
}
