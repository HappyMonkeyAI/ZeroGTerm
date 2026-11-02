---
kind: checkpoint
created: 2026-11-02T17:50:53Z
agent: cursor
sha: e1f352e
branch: main
paths: [src/shared/open-cwd.ts, src/main/main.ts, src/main/preload.cjs, src/renderer/main.tsx, tests/open-cwd.test.ts]
verification: {V0: pass, V1: pass, V2: skip, V3: skip, V4: skip}
id: 2026-11-02T1750Z-honor-fileman-cli-cwd-and-zerog-open-cwd-parse-h
---
# Checkpoint: Honor FileMan/CLI --cwd and ZEROG_OPEN_CWD: parse hint, single-instance handoff…

## Summary

Honor FileMan/CLI --cwd and ZEROG_OPEN_CWD: parse hint, single-instance handoff, open local shell pane.

## Done

- parseOpenCwd + sessionNameForCwd + tests
- requestSingleInstanceLock + app:takeOpenCwd / app:open-cwd
- Renderer opens local session at cwd on cold start and second-instance

## Next

- Manual smoke: FileMan Terminal button with Term launcher

## Blockers

- (none)

## Decisions

- (none)
