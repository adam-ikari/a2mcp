import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { auditBridge, auditHostLlm, auditIncognito, auditQuiet, auditTunnel, setAuditQuiet } from "../src/audit.ts";
import { ensurePlaceholderOnMainSession } from "../src/auto-model.ts";
import { buildCallTool, buildToolCatalog, hasMainSession } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";
import { resolveBinary } from "../src/obtain.ts";
import { startServer } from "../src/server.ts";
import { hostLlmState, rearmMainSession, setEnabled } from "../src/takeover.ts";
import { openQuickTunnel, type QuickTunnel } from "../src/tunnel.ts";
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

/**
 * The operator-opened quick tunnel in front of the bridge's port, or `null` — which
 * makes it the public face of the MCP endpoint and of `/xfer` at the same time, because
 * a quick tunnel fronts exactly one origin and both are served on it.
 *
 * Runtime state only — like the takeover toggle, it never touches the config
 * and dies with the bridge. One per process because `server` is one per
 * process; `tunnelOpening` is the same in-flight guard `bringingUp` is for the
 * bind: two concurrent `/a2mcp tunnel` calls would otherwise spawn two
 * cloudflared children and the module would only remember (and only be able
 * to stop) the last one.
 */
let mcpTunnel: QuickTunnel | null = null;
let tunnelOpening: Promise<void> | null = null;

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
		// A machine with no model configuration opens sessions that cannot take a
		// prompt ("No model selected"), even though the bridge itself binds fine —
		// so fill the empty slot with an unreachable placeholder before anything
		// else reads the session. It never touches a slot that already has a
		// model in it (see src/auto-model.ts).
		try {
			if (ensurePlaceholderOnMainSession()) {
				ctx.ui.notify(
					"a2mcp: no model configured — selected unreachable placeholder a2mcp/offline; /login or /model for real inference",
				);
			}
		} catch (e) {
			ctx.ui.notify(`a2mcp placeholder model failed: ${(e as Error)?.message ?? String(e)}`, "error");
		}
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
		// The token getter reads the config as it is now, so a rotation is covered:
		// the audit scrubs the credential that is live, not the one that was.
		// The incognito gate lives in src/audit.ts, where every record is written —
		// one switch for every writer, so "the log is silent" cannot mean "silent
		// except for whichever code path happened to be wired". The render events
		// read the same flag: they are what the host's session transcript is written
		// from, and a call the log does not keep must not land in the transcript
		// either.
		liveCallTool = buildCallTool(
			pi,
			ctx,
			() => cfg?.token ?? "",
			() => auditQuiet(),
		);
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
				// `bridgeUrl` is a getter because the share's advertised URL is this
				// process's own origin, and the port is only known after the bind.
				// `publicUrl` is the same idea one level out: the operator's tunnel may
				// open or close while a share lives, and the tool reports that state
				// without ever opening a tunnel of its own.
				xfer = createXfer(cfg.xfer, {
					bridgeUrl: () => (server && cfg ? `http://${cfg.host}:${server.port}` : ""),
					publicUrl: () => mcpTunnel?.url ?? null,
				});
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
					// The `/xfer` proxy asks this object where the file server is, per request
					// (src/server.ts). Structurally it is the seam `XferRouteDeps` declares.
					xfer,
				});
				// The instance's own span. The port in a tunnel or share record names
				// the instance that owned it, and a port on its own says nothing about
				// whether that instance is still up — so the instance records its own
				// bind and its own teardown, and a `start` with no matching `stop` is
				// an endpoint that died with its host.
				await auditBridge("start", { port: server.port, version: BRIDGE_VERSION }, null);
				if (!hasMainSession()) {
					// The session this start was for ended while the bind was in flight, and its
					// shutdown ran while `server` was still null, so nothing stopped this one.
					// Give the orphan up before saying anything: a "listening" line for a port
					// that is already closed would send the operator to a dead endpoint.
					const port = server.port;
					server.stop();
					server = null;
					cfg = null;
					await auditBridge("stop", { port, why: "session ended during start" }, null);
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
		// The share is a spawned file server plus a route on this port: the endpoint
		// going away has to take both with it, or `/xfer` would outlive the share it
		// forwards to. The MCP tunnel is the same kind of promise — a public hostname
		// pointing at a port this process is about to close, carrying the same `/xfer`
		// path.
		//
		// Both are audited on the way down, and neither was before: the tunnel's open
		// had a record and its death had none, so the log listed public hostnames that
		// had served the host's tools and never said which of them were still
		// answering. The share already wrote its `bridge stopped` close (src/xfer.ts);
		// the tunnel did not, which is one teardown running two rules. A `/xfer`
		// request still in flight when the file server dies gets the 502 the route
		// already answers with; the port is released last so an MCP call in flight can
		// still finish (src/server.ts).
		const closing = mcpTunnel;
		if (closing) {
			await closing.stop();
			await auditTunnel("stop", { url: closing.url, why: "bridge stopped" }, null);
		}
		mcpTunnel = null;
		tunnelOpening = null;
		await xfer?.stop();
		xfer = null;
		const port = server?.port;
		server?.stop();
		server = null;
		cfg = null;
		liveCallTool = null;
		// The incognito switch is runtime state like the rest of it: the decision
		// was about this stretch of time, and the bridge that carried it is gone.
		// Cleared before the stop record below, so the log ends with the bridge's
		// own closing line rather than with a gap nobody can explain.
		setAuditQuiet(false);
		// The instance's own span, for the same reason the tunnel's death needed one:
		// the port in a tunnel or share record names the instance that owned it, and
		// "the bridge restarted" is a different fact from "the tunnel closed".
		await auditBridge("stop", { port, why: "session shutdown" }, null);
	});

	pi.registerCommand("a2mcp", {
		description:
			"Show a2mcp status, rotate its token with `a2mcp rotate`, show the full token with `a2mcp token`, toggle incognito mode with `a2mcp incognito` (remote calls leave no record while it is on), or open (`a2mcp tunnel`) and close (`a2mcp tunnel stop`) a public quick tunnel in front of the bridge endpoint — tool calls and the /xfer file route both ride it.",
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
				if (args.trim() === "incognito") {
					// The one switch the remote side cannot reach: it is the operator's
					// machine and the operator's call.
					//
					// The switch's own record is written just outside the silent window:
					// the enable line before the silence starts, the disable line after
					// it ends. It is the only thing the log says about the mode —
					// without it, a quiet stretch reads as a bridge that was never
					// called. Everything else stops while it is on: the calls, the
					// shares, the tunnel, the instance, the arming.
					const on = !auditQuiet();
					if (on) await auditIncognito("enable", {}, null);
					setAuditQuiet(on);
					if (!on) await auditIncognito("disable", {}, null);
					ctx.ui.notify(
						on
							? "a2mcp incognito: on — the audit log is silent and the host's omp records nothing"
							: "a2mcp incognito: off — records are written again",
					);
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
				if (args.trim() === "tunnel" || args.trim() === "tunnel stop") {
					if (!server || !cfg) {
						ctx.ui.notify("a2mcp not running", "error");
						return;
					}
					// The endpoint and the config are module state that a shutdown can
					// null while this async path is in flight — read them into locals.
					const port = server.port;
					const conf = cfg;
					if (args.trim() === "tunnel stop") {
						if (!mcpTunnel) {
							ctx.ui.notify("a2mcp tunnel: none open");
							return;
						}
						const closing = mcpTunnel;
						await closing.stop();
						if (mcpTunnel === closing) mcpTunnel = null;
						await auditTunnel("stop", { url: closing.url }, null);
						ctx.ui.notify(`a2mcp tunnel closed: ${closing.url}/`);
						return;
					}
					if (tunnelOpening) {
						// A start is already in flight and it reports its own outcome; ride
						// along instead of spawning a second child nothing would remember.
						await tunnelOpening;
						if (mcpTunnel) ctx.ui.notify(`a2mcp tunnel already open: ${mcpTunnel.url}/`);
						return;
					}
					if (mcpTunnel) {
						ctx.ui.notify(
							`a2mcp tunnel already open: ${mcpTunnel.url}/ — public; the Bearer token is the only gate; /xfer/ rides it too; /a2mcp tunnel stop closes it`,
						);
						return;
					}
					tunnelOpening = (async () => {
						try {
							const cf = await resolveBinary("cloudflared", conf.xfer.cloudflared, null);
							const opened = await openQuickTunnel({ bin: cf.path, port });
							mcpTunnel = opened;
							await auditTunnel("start", { url: opened.url, port }, null);
							ctx.ui.notify(
								`a2mcp tunnel: ${opened.url}/ — public; the Bearer token is the only gate; /xfer/ rides it too; /a2mcp tunnel stop closes it`,
							);
						} catch (e) {
							const why = (e as Error)?.message ?? String(e);
							await auditTunnel("start", { port }, why);
							ctx.ui.notify(`a2mcp tunnel failed to open: ${why}`, "error");
						} finally {
							tunnelOpening = null;
						}
					})();
					await tunnelOpening;
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
					`a2mcp on ${url} (token ${cfg.token.slice(0, 6)}…, port ${server.port}) host_llm=${st.enabled ? "allow" : st.degraded ? "deny (tripwire only)" : "deny"} denied=${st.denied}${mcpTunnel ? ` tunnel=${mcpTunnel.url}` : ""} incognito=${auditQuiet() ? "on" : "off"}`,
				);
			} catch (e) {
				ctx.ui.notify(`a2mcp command failed: ${(e as Error)?.message ?? String(e)}`, "error");
			}
		},
	});
}
