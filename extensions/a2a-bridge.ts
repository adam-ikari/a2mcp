import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { auditHostLlm } from "../src/audit.ts";
import { buildCallTool, buildToolCatalog, hasMainSession } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { hostLlmState, rearmMainSession, setEnabled } from "../src/takeover.ts";

/**
 * The bridge's own version, from `package.json`.
 *
 * Read, not imported: the host loads this file through its own module shim, which
 * rewrites bare specifiers like `@oh-my-pi/*`, and the packaged extension ships
 * `src/` alongside `extensions/` rather than a bundler output — so this must be a
 * path relative to this file, and it is (`../package.json`). Keeping it a literal
 * instead is what this note replaces: 0.2.0 went out answering `initialize` with
 * `version: "0.1.0"` while `docs/protocol.md` quoted that response and agreed with
 * it. Nothing compared the two.
 */
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };

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
	console.error(`[a2a-bridge] takeover failed to arm: ${detail}`);
	// Nothing waits on this one — it is a startup record with no request to answer,
	// and the process may be on its way out. `void` because the promise is real and
	// someone should have to think about it, not because it is unsafe to drop: the
	// chain never rejects.
	void auditHostLlm(null, false, detail.slice(0, 200));
	ctx.ui.notify(`A2A takeover failed to arm: ${detail}`, "error");
}

export default function a2aBridge(pi: ExtensionAPI): void {
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
				server = await startServer(cfg, {
					getTools: buildToolCatalog(pi),
					// Read through the live executor: the one captured here would keep
					// answering out of the first session's context after a rebuild.
					callTool: async (name, args, sid) => {
						if (!liveCallTool)
							return { content: [{ type: "text", text: "main session not available" }], isError: true };
						return liveCallTool(name, args, sid);
					},
					// From package.json rather than a literal: it was a literal, and the
					// protocol page quotes this response verbatim — so 0.2.0 shipped with
					// the code still answering "0.1.0" and the page agreeing with the
					// code. Two copies of a version number, and nothing compares them.
					serverInfo: () => ({ name: "omp-a2a-bridge", version: pkg.version }),
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
						`A2A bridge: configured port ${cfg.port} is busy — bound ${server.port} instead; update remote mcp.json`,
						"warning",
					);
				}
				const tokenBrief = cfg.token.slice(0, 6);
				ctx.ui.notify(`A2A bridge listening on ${url} (token ${tokenBrief}…)`);
				if (cfg.host === "0.0.0.0") {
					ctx.ui.notify("A2A bridge bound to 0.0.0.0 — ensure firewall restricts access", "warning");
				}
			} catch (e) {
				// Leave no half-initialized state: a failed start must not let
				// `/a2a rotate` report success for a server that never bound.
				server?.stop();
				server = null;
				cfg = null;
				ctx.ui.notify(`A2A bridge failed to start: ${(e as Error)?.message ?? String(e)}`, "error");
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
		server?.stop();
		server = null;
		cfg = null;
		liveCallTool = null;
	});

	pi.registerCommand("a2a", {
		description: "Show A2A bridge status, rotate its token with `a2a rotate`, or show the full token with `a2a token`.",
		handler: async (args, ctx) => {
			try {
				if (args.trim() === "rotate") {
					if (!server || !cfg) {
						ctx.ui.notify("A2A bridge not running", "error");
						return;
					}
					const next = generateToken();
					// Persist first, then hand the new token to the live server: the server reads
					// `cfg.token` per request, so assigning before a failed write would rotate the
					// running bridge while the file still holds the old token — and the operator
					// gets an error saying nothing happened.
					await saveConfig({ ...cfg, token: next });
					cfg.token = next;
					ctx.ui.notify("A2A token rotated — update remote mcp.json");
					return;
				}
				if (args.trim() === "token") {
					if (!server || !cfg) {
						ctx.ui.notify("A2A bridge not running", "error");
						return;
					}
					ctx.ui.notify(`A2A token: ${cfg.token}`);
					return;
				}
				if (!server || !cfg) {
					ctx.ui.notify("A2A bridge not running", "error");
					return;
				}
				const url = `http://${cfg.host}:${server.port}/`;
				// `host_llm` is the runtime state, not the config value: a remote toggle
				// diverges from the startup config until the next restart. A degraded
				// state says deny over a session the deny never reached — spelled out
				// rather than left to be inferred from `denied=0`.
				const st = hostLlmState();
				ctx.ui.notify(
					`A2A bridge on ${url} (token ${cfg.token.slice(0, 6)}…, port ${server.port}) host_llm=${st.enabled ? "allow" : st.degraded ? "deny (tripwire only)" : "deny"} denied=${st.denied}`,
				);
			} catch (e) {
				ctx.ui.notify(`A2A command failed: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		},
	});
}
