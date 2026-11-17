# ZeroG Terminal MCP intent map

This file is the project-local routing overlay for MCP-aware work. The detailed ZeroG endpoint contract is in [`docs/mcp.md`](docs/mcp.md). `MCP.local.md` may add machine-specific availability and must not contain secrets.

| Intent | Preferred route | Boundary |
|---|---|---|
| inspect or change ZeroG workspaces/sessions | ZeroG local MCP endpoint | loopback, bearer-authenticated, lease-controlled |
| request a terminal command | ZeroG MCP `zerog_request_command` | bounded request; exact renderer approval required |
| verify security findings | AuditScan MCP | read-only scan/triage unless explicitly authorized |
| research external sources | article-research MCP or web tools | preserve source URLs and distinguish leads from evidence |
| inspect projects and ports | launcher registry MCP | metadata only; check before binding |
| admit heavy builds/tests/agents | resource sentinel MCP | use a bounded lease when available |
| browser/runtime acceptance | BrowserOS/browser tools | verify visible behavior plus state readback |

Listed tools are not necessarily mounted in the current session. Check live availability or the dynamic proxy before declaring a specialty MCP unavailable. Do not put tokens, credentials, or private endpoints in this file.
