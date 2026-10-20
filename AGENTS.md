<!-- BEGIN brain.md -->
## Project Brain

This project keeps a **Project Brain**: a persistent memory layer of its durable decisions, requirements, and constraints. Read `./BRAIN.md` for the full read/write contract.

Maintain the brain as part of normal coding work — not as a separate task. While discussing or implementing features:
- **Start of a task:** load relevant context with the `brain` CLI (`list-pages`, `read-page`, `read-root`). Prefer a narrow read over scanning everything.
- **When a decision, requirement, constraint, or durable insight settles** (in chat or while coding): capture it immediately via the `brain` CLI. Do not wait to be asked and do not batch it for later.
- **Pure implementation with no new decision:** do not write to the brain.
- **When overturning a prior conclusion:** update the page (`update-truth` and/or `append-timeline` with `kind: reversal`, or `archive-page`).
- Only store what will still matter in six months and is hard to reconstruct from the code alone.
- All reads and writes go through the `brain` CLI — never hand-edit brain files.

The brain skills (`brain-setup`, `brain-page`, `brain-ingest`, `brain-bootstrap`) are installed in your global skills directory. Prefer `brain init` to scaffold a new project.
<!-- END brain.md -->

## What this is

Reuse the omp that is already running on this machine. Any MCP client — another omp, Claude Code, a curl script — points `mcp.json` at the endpoint and calls that omp's tools; the calls run in the host's `Main` session against real files and shell.

The bridge sends the call. It does not add meaning on the way.

## Principles

These follow from that one job, not from taste:

- **Don't rebuild what exists.** The host already has `read`/`bash`/`edit`. If a capability can be expressed with the host's own tools, write no new tool.
- **Don't implement a sandbox for omp.** The host already decides what its tools may touch. A second opinion about paths is a second authority, and nobody defined which one wins.
- **Don't filter on permission grounds.** `tools/list` is `pi.getAllTools()` verbatim — hidden tools and tools the host currently has disabled for its own model included. Whatever permissions omp has are the permissions the bridge has.
- **Don't grow a second system.** A bridge-owned tool bypasses the host's approval gate, so it would need its own sandbox — that is one decision, and both halves have to go together.

The test for a proposed change: does it make the bridge more transparent, or does it give the bridge an opinion? Anything that gives it an opinion is a second omp.

## The exceptions on record

Four paths give the bridge an opinion it does not otherwise have, and all four are
paid for with auditing and documentation:

- `POST /host-llm` reaches into the host session directly: shadowing registry rows,
  overriding settings, replacing the process `fetch`. What it limits is the host's own
  inference, and it acts only on the word of whoever holds the token. Its guarantee, its
  degraded state, and its residuals (lane refusals, the tripwire, and the request path
  that is not the global `fetch`) are in `docs/protocol.md` under 宿主推理切换.
- The three `xfer_*` tools (`xfer_share` / `xfer_status` / `xfer_stop`, `src/xfer.ts`)
  are served by the bridge rather than forwarded to the host: they resolve the path
  themselves, put `dufs` on it bound to loopback, and mount it as the `/xfer/` route on the
  bridge's own port — and they are appended to `tools/list` after the host registry, so they
  bypass the host's approval gate and bring no sandbox of their own. The cost is auditing
  (`tool: "xfer"`, one record per call) and documentation; what bounds the route is the same
  Bearer token that opens the port. The tool returns no credential, and it opens no tunnel:
  going outside is the operator's `/a2mcp tunnel`, not the tool's decision. While that
  tunnel is up, `xfer_share` and `xfer_status` report the hostname it already has as
  `publicUrl` — reading a state that exists, not adding a way out. Asked for by the
  maintainer; the contract and usage are in
  `docs/protocol.md` under 桥自己的工具 (`xfer_*`) and in the README under 传文件.
- `src/obtain.ts` puts a binary on the host's disk. When a name in the `xfer` block
  answers to nothing on PATH, the bridge downloads the pinned release asset, checks its
  sha256 against the hash pinned next to the version, and installs it into its own bin
  directory (`~/.local/bin`, or `%LOCALAPPDATA%\a2mcp\bin` on Windows). This is the
  smallest possible package manager, and the honest description of what it adds is one
  opinion rather than a new authority: the bridge already chose `dufs`, so the only
  question left was where those bytes come from. What bounds it: no `latest`, no
  checksum taken from the download host, no write to a file it did not install, no fetch
  at all for a configured value containing `/` or `\` (that is the escape hatch), and an
  `install` audit record beside the `share` one. The pin table is the other half of the
  bargain: five targets per binary, each row added because upstream publishes that asset
  and its bytes were hashed, not because a platform looked missing — `win32-arm64` has no
  row because cloudflared ships no Windows ARM64 executable, and the bridge says so rather
  than installing half a pair.
- `/a2mcp tunnel` puts a public hostname in front of the bridge's own port. It is the
  operator's command in the host session — not a tool, not an HTTP endpoint — and it runs
  `resolveBinary` + `openQuickTunnel` against `server.port`. A quick tunnel fronts exactly
  one origin, so that single hostname and single Bearer token carry both the MCP endpoint and
  the `/xfer/` file route, which makes the token the only gate between the Cloudflare edge
  and the host's tools. Runtime state like the takeover switch: never in the config, torn
  down with the port so a public hostname cannot outlive the bridge. Paid for with one
  `tool: "tunnel"` audit record per open and close and the 跨机转发 / 操作员的隧道 sections
  in the README and `docs/protocol.md`.

Everything else here still decides.

## Writing voice

All user-facing prose in this repo (README, CHANGELOG, `docs/`, site copy, commit messages) is written in a specific voice. Read the `write-like-adam` skill before editing any of it — it carries the rules distilled from the prose already in this repo, plus a self-check (compare the paragraph against the CHANGELOG; if it reads more polished than the entries there, cut it back).

`humanizer` removes AI tells but does not supply the target voice. Use it together, not instead.

Diagrams go through the `design-doc-mermaid` skill. No ASCII art.
