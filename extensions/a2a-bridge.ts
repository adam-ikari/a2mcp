import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { buildCallTool, buildToolCatalog, hasMainSession } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { hostLlmState, rearmMainSession, setEnabled } from "../src/takeover.ts";

let server: { port: number; fellBack: boolean; stop(): void } | null = null;
let cfg: BridgeConfig | null = null;
/**
 * The bind is not atomic — `loadConfig` and `startServer` both await — so a second
 * `session_start` can arrive while the first is still in flight. Without this guard
 * both would bind, and the module remembers only the last one: the first server keeps
 * a port nobody can stop, and the operator gets two announcements for two endpoints.
 */
let bringingUp: Promise<void> | null = null;

export default function a2aBridge(pi: ExtensionAPI): void {
	pi.on("session_start", async (_ev, ctx) => {
		// A rebuilt `Main` session arrives with a fresh model registry that nothing
		// has shadowed, so the operator's startup state is re-applied on every
		// start — before the endpoint guard, since the endpoint being up says
		// nothing about the registry being denied.
		if (cfg?.host_llm === "deny") {
			try {
				rearmMainSession();
			} catch (e) {
				ctx.ui.notify(`A2A takeover failed to arm: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		}
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
						ctx.ui.notify(`A2A takeover failed to arm: ${(e as Error)?.message ?? String(e)}`, "error");
					}
				}
				server = await startServer(cfg, {
					getTools: buildToolCatalog(pi),
					callTool: buildCallTool(pi, ctx),
					serverInfo: () => ({ name: "omp-a2a-bridge", version: "0.1.0" }),
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
				// diverges from the startup config until the next restart.
				const st = hostLlmState();
				ctx.ui.notify(
					`A2A bridge on ${url} (token ${cfg.token.slice(0, 6)}…, port ${server.port}) host_llm=${st.enabled ? "allow" : "deny"} denied=${st.denied}`,
				);
			} catch (e) {
				ctx.ui.notify(`A2A command failed: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		},
	});
}
