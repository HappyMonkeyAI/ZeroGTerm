---
kind: decision
title: Open-cwd deep-link protocol
tags: [fileman, cwd, deep-link]
paths: [src/shared/open-cwd.ts, src/main/main.ts]
sha: e4ea2ba
agent: cursor
created: 2026-11-02
updated: 2026-11-02
---
# Open-cwd deep-link protocol

FileMan/CLI open a directory via --cwd <path> (preferred), ZEROG_OPEN_CWD env (cold start), or a bare absolute argv path. Term uses requestSingleInstanceLock; second launches must put cwd on argv because env is not forwarded. Renderer takeOpenCwd is one-shot; onOpenCwd handles subsequent launches.
