import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { auditHostLlm } from "../src/audit.ts";
import { buildCallTool, buildToolCatalog, hasMainSession } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { hostLlmState, rearmMainSession, setEnabled } from "../src/takeover.ts";
import { createXfer, XFER_TOOLS, type Xfer } from "../src/xfer.ts";

/**
 * The bridge's own version, from `package.json`.
 *
 * Read, not imported: the host loads this file through its own module shim, and
 * the packaged extension ships `src/` and `extensions/` beside a `package.json`
 * rather than a bundler output. Keeping it a literal is what this replaces — 0.2.0
 * went out answering `initialize` with `version: "0.1.0"` while
 * `docs/protocol.md` quoted that response and agreed with it, so nothing compared
 * the two.
 *
 * And it is a read that cannot throw, which is not obvious and was not the first
 * time: this runs at module top level, so an unreadable `package.json` takes the
 * whole extension down over a version string — and it did, in a layout where
 * `extensions/` sits directly under the agent directory with no package beside it.
 * A bridge whose version number is the reason it will not load is worse than one
 * that reports "unknown".
 */
function bridgeVersion(): string {
	try {
		const v = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: unknown })
			.version;
		return typeof v === "string" && v.length > 0 ? v : "unknown";
	} catch {
		return "unknown";
	}
}
const BRIDGE_VERSION = bridgeVersion();

let server: { port: number; fellBack: boolean; stop(): void } | null = null;
let cfg: BridgeConfig | null = null;
/**
 * The bind is not atomic — `loadConfig` and `startServer` both await — so a second
 * `session_start` can arrive while the first is still in flight. Without this guard
 * both would bind, and the module remembers only the last one: the first server keeps
 * a port nobody can stop, and the operator gets two announcements for two endpoints.
 */
let bringingUp: Promise<void> | null = null;
/**
 * The `tools/call` executor the live server dispatches through, replaced on every
 * `session_start`.
 *
 * The endpoint is process-level, but an `ExtensionContext` is not: the host rebuilds
 * the session (revive, ACP, a task runner) and hands the next `session_start` a fresh
 * one, while the first server — and the closure it was built with — lives on. A
 * captured context is exactly the thing the host warns about ("a saved context must
 * not retain a completed handler's stale signal", runner.ts): its `ui`, `abort`,
 * `isIdle` and `hasPendingMessages` all read the session that is already gone, and a
 * dead session's abort signal is aborted, so every remote tool call would fail on
 * arrival. Rebuilding the executor per start costs one closure.
 */
let liveCallTool: ReturnType<typeof buildCallTool> | null = null;

/**
 * The bridge's own transfer tools (src/xfer.ts), or `null` before the first start.
 * Module-level for the same reason `server` is: one endpoint per process, and the
 * shutdown path has to close it without a session in hand.
 */
let xfer: Xfer | null = null;

/** Report a takeover that could not be armed, in the three places an operator looks. */
function reportArmFailure(ctx: ExtensionContext, e: unknown): void {
	const why = (e as Error)?.message ?? String(e);
	// Two different failures, and they must not read the same. Nothing armed at all
	// means the switch is off and the host reasons under its own rules. A refusal
	// *while the switch is on* leaves the tripwire installed on a session that never
	// got the deny row or the claims — so the operator is told which of the two
	// happened, instead of the state bar claiming deny over a session that can.
	const st = hostLlmState();
	const detail = st.degraded ? `${why} — the switch is still on; this session is covered by the tripwire only` : why;
	// stderr outlives the toast, and the audit outlives the process: a refusal at
	// startup says the host was *supposed* to be denied and is not, and nothing else
	// in the bridge's record would say so later. `sid: null` because no caller asked.
	console.error(`[a2mcp] takeover failed to arm: ${detail}`);
	// Nothing waits on this one — it is a startup record with no request to answer,
	// and the process may be on its way out. `void` because the promise is real and
	// someone should have to think about it, not because it is unsafe to drop: the
	// chain never rejects.
	void auditHostLlm(null, false, detail.slice(0, 200));
	ctx.ui.notify(`a2mcp takeover failed to arm: ${detail}`, "error");
}

export default function a2mcpExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_ev, ctx) => {
		// Re-arm whenever the switch is on, not only when the config says so: the
		// config only decides the *startup* state, while a runtime-armed takeover has
		// to survive a rebuilt Main session (fresh registry, nothing denied) and a
		// shared one the host's own extension-source reconciliation may have pruned
		// the shadow out of. This runs before the endpoint guard — the endpoint being
		// up says nothing about the registry being denied.
		if (!hostLlmState().enabled) {
			try {
				rearmMainSession();
			} catch (e) {
				reportArmFailure(ctx, e);
			}
		}
		liveCallTool = buildCallTool(pi, ctx);
		if (server) return; // one endpoint per process
		if (bringingUp) {
			// Ride along with the start already in flight rather than bind a second one.
			await bringingUp;
			return;
		}
		bringingUp = (async () => {
			try {
				cfg = await loadConfig();
				if (!existsSync(configPath())) await saveConfig(cfg);
				if (cfg.host_llm === "deny") {
					// Deny the host's inference before the port opens: a caller that
					// arrives between the bind and the arming would otherwise see one
					// window where the host could still reason on its own.
					try {
						rearmMainSession();
					} catch (e) {
						reportArmFailure(ctx, e);
					}
				}
				// Before the port opens: `getTools` and `callTool` below close over it.
				xfer = createXfer(cfg.xfer);
				server = await startServer(cfg, {
					// The host's registry verbatim, plus the bridge's own transfer tools:
					// `xfer_*` is served by this process (src/xfer.ts), not forwarded to the
					// host, which is why it is appended here at the composition point rather
					// than inside the catalog builder.
					getTools: async () => [...(await buildToolCatalog(pi)()), ...XFER_TOOLS],
					// Read through the live executor: the one captured here would keep
					// answering out of the first session's context after a rebuild.
					callTool: async (name, args, sid) => {
						// Bridge-owned first: `xfer_*` is not in the host registry, so the
						// host executor would only refuse it.
						if (xfer?.handles(name)) return xfer.call(name, args, sid);
						if (!liveCallTool)
							return { content: [{ type: "text", text: "main session not available" }], isError: true };
						return liveCallTool(name, args, sid);
					},
					// From package.json rather than a literal: it was a literal, and the
					// protocol page quotes this response verbatim — so 0.2.0 shipped with
					// the code still answering "0.1.0" and the page agreeing with the
					// code. Two copies of a version number, and nothing compares them.
					serverInfo: () => ({ name: "a2mcp", version: BRIDGE_VERSION }),
					takeover: { setEnabled },
				});
				if (!hasMainSession()) {
					// The session this start was for ended while the bind was in flight, and its
					// shutdown ran while `server` was still null, so nothing stopped this one.
					// Give the orphan up before saying anything: a "listening" line for a port
					// that is already closed would send the operator to a dead endpoint.
					server.stop();
					server = null;
					cfg = null;
					return;
				}
				const url = `http://${cfg.host}:${server.port}/`;
				if (server.fellBack) {
					ctx.ui.notify(
						`a2mcp: configured port ${cfg.port} is busy — bound ${server.port} instead; update remote mcp.json`,
						"warning",
					);
				}
				const tokenBrief = cfg.token.slice(0, 6);
				ctx.ui.notify(`a2mcp listening on ${url} (token ${tokenBrief}…)`);
				if (cfg.host === "0.0.0.0") {
					ctx.ui.notify("a2mcp bound to 0.0.0.0 — ensure firewall restricts access", "warning");
				}
			} catch (e) {
				// Leave no half-initialized state: a failed start must not let
				// `/a2mcp rotate` report success for a server that never bound.
				server?.stop();
				server = null;
				cfg = null;
				ctx.ui.notify(`a2mcp failed to start: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		})();
		try {
			await bringingUp;
		} finally {
			bringingUp = null;
		}
	});

	pi.on("session_shutdown", async () => {
		// The server is a process-level resource, but this event is per session: a task
		// subagent's runner gets its own handlers, and finishing (or idle-parking) that
		// subagent emits it while the Main session is alive. Stopping here would take the
		// endpoint down with a session that was never ours to serve.
		if (hasMainSession()) return;
		// The share holds a public URL and a spawned server; the endpoint going away
		// has to take both with it, or the hostname outlives the bridge that opened it.
		await xfer?.stop();
		xfer = null;
		server?.stop();
		server = null;
		cfg = null;
		liveCallTool = null;
	});

	pi.registerCommand("a2mcp", {
		description: "Show a2mcp status, rotate its token with `a2mcp rotate`, or show the full token with `a2mcp token`.",
		handler: async (args, ctx) => {
			try {
				if (args.trim() === "rotate") {
					if (!server || !cfg) {
						ctx.ui.notify("a2mcp not running", "error");
						return;
					}
					const next = generateToken();
					// Persist first, then hand the new token to the live server: the server reads
					// `cfg.token` per request, so assigning before a failed write would rotate the
					// running bridge while the file still holds the old token — and the operator
					// gets an error saying nothing happened.
					await saveConfig({ ...cfg, token: next });
					cfg.token = next;
					ctx.ui.notify("a2mcp token rotated — update remote mcp.json");
					return;
				}
				if (args.trim() === "token") {
					if (!server || !cfg) {
						ctx.ui.notify("a2mcp not running", "error");
						return;
					}
					ctx.ui.notify(`a2mcp token: ${cfg.token}`);
					return;
				}
				if (!server || !cfg) {
					ctx.ui.notify("a2mcp not running", "error");
					return;
				}
				const url = `http://${cfg.host}:${server.port}/`;
				// `host_llm` is the runtime state, not the config value: a remote toggle
				// diverges from the startup config until the next restart. A degraded
				// state says deny over a session the deny never reached — spelled out
				// rather than left to be inferred from `denied=0`.
				const st = hostLlmState();
				ctx.ui.notify(
					`a2mcp on ${url} (token ${cfg.token.slice(0, 6)}…, port ${server.port}) host_llm=${st.enabled ? "allow" : st.degraded ? "deny (tripwire only)" : "deny"} denied=${st.denied}`,
				);
			} catch (e) {
				ctx.ui.notify(`a2mcp command failed: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		},
	});
}
