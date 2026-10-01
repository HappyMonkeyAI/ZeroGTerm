// PROTOTYPE - throwaway. Invoked by Claude Code as a Stop hook (via --settings).
// Appends the hook payload, tagged with this pane's id, to <ZEROG_HOOK_DIR>/events.jsonl.
// Exits 0 with no output so it never blocks or alters the agent.
import fs from 'node:fs';
import path from 'node:path';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const dir = process.env.ZEROG_HOOK_DIR;
  const pane = process.env.ZEROG_PANE_ID;
  if (!dir || !pane) process.exit(0);
  let payload = null;
  try { payload = JSON.parse(input); } catch { payload = { raw: input }; }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: Date.now(), pane, payload }) + '\n');
  process.exit(0);
});
