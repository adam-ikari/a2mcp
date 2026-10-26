/**
 * The extension entrypoint: what one session's start and shutdown do to a
 * process-level server.
 *
 * The host builds a fresh extension runner per session — a task subagent's, an ACP
 * session's, a persisted revive's — and re-invokes this factory for each, while the
 * module's `server`/`cfg` are shared because the module graph is not re-evaluated.
 * So the events are per session and the resource is per process, and the entrypoint
 * is the only place that has to reconcile them.
 *
 * Nothing here is mocked: `$A2MCP_CONFIG` points at a temp file, the port is
 * `0`, and the Main session is a fake registered in the real `AgentRegistry`. Every
 * claim is checked over HTTP against the port the bridge advertised, because that is
 * the only claim a caller can act on.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import a2mcpExtension from "../extensions/a2mcp.ts";
import { auditLogPath } from "../src/audit.ts";
import { configPath } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "a2mcp-entry-"));
const savedEnv = { ...process.env };
process.env.A2MCP_CONFIG = join(dir, "a2mcp.json");
process.env.A2MCP_AUDIT = join(dir, "audit.log");
// A 0700 dir, not the default 0755 temp dir: the read-only-file test needs the
// non-root owner to be refused, and a group/other-writable dir would let the write
// land from elsewhere.
chmodSync(dir, 0o700);

const TOKEN = "tok-entry-level-fixed-token-0123456789";
function writeConfig(cfg: Record<string, unknown>): void {
	writeFileSync(configPath(), `${JSON.stringify(cfg, null, "\t")}\n`, { mode: 0o600 });
}

/** POST initialize and report the HTTP status, or null when nothing answered. */
async function ping(port: number, token = TOKEN): Promise<number | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			method: "POST",
			// `connection: close`, so "null" really means a fresh connection was refused.
			// The bridge stops gracefully (src/server.ts), which lets an already-open
			// keep-alive connection answer one more request — a pooled socket from an
			// earlier ping would report 200 over a port that no longer accepts anything.
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "entry-test", version: "0" } },
			}),
		});
		return res.status;
	} catch {
		return null;
	}
}

interface Runner {
	notes: Array<{ text: string; level?: string }>;
	start(): Promise<void>;
	shutdown(): Promise<void>;
	command(args: string): Promise<void>;
	commandNames: string[];
	/** The port from the bridge's own announcement — parsed, not injected. */
	advertisedPort(): number | null;
}

const runners: Runner[] = [];

/**
 * One host session's worth of extension state: its own handlers and `ctx`, sharing
 * the module singleton. `uiThrowsOn` models a UI sink that refuses a notification.
 */
function newRunner(uiThrowsOn = ""): Runner {
	const handlers: Record<string, Array<(ev: unknown, ctx: ExtensionContext) => Promise<void>>> = {};
	const commandDefs: Array<{ name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }> = [];
	const notes: Array<{ text: string; level?: string }> = [];
	const ui = {
		notify: (text: string, level?: string) => {
			notes.push({ text, level });
			if (uiThrowsOn && text.includes(uiThrowsOn)) throw new Error("the ui sink is gone");
		},
	};
	const ctx = { ui, hasUI: true } as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (ev: unknown, c: ExtensionContext) => Promise<void>) => {
			const list = handlers[event] ?? [];
			list.push(handler);
			handlers[event] = list;
		},
		registerCommand: (name: string, def: { handler: (args: string, c: ExtensionContext) => Promise<void> }) => {
			commandDefs.push({ name, handler: def.handler });
		},
		getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
	} as unknown as ExtensionAPI;
	a2mcpExtension(pi);
	const runner: Runner = {
		notes,
		commandNames: commandDefs.map((c) => c.name),
		start: async () => {
			for (const h of handlers.session_start ?? []) await h({}, ctx);
		},
		shutdown: async () => {
			for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
		},
		command: async (args: string) => {
			for (const c of commandDefs) await c.handler(args, ctx);
		},
		advertisedPort: () => {
			const hit = /http:\/\/127\.0\.0\.1:(\d+)\//g.exec(notes.map((n) => n.text).join("\n"));
			return hit ? Number(hit[1]) : null;
		},
	};
	runners.push(runner);
	return runner;
}

const texts = (r: Runner) => r.notes.map((n) => n.text).join("\n");

/** Every audit record on disk, parsed. The log spans the whole file, tests included. */
function auditRecords(): Array<Record<string, unknown>> {
	const file = auditLogPath();
	return (existsSync(file) ? readFileSync(file, "utf8") : "")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function mountMain(): void {
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "fake-main",
		kind: "main",
		// A model on the fake, because these tests are about a configured host: the
		// placeholder in src/auto-model.ts must stay out of the way when the session
		// already has one, and an empty slot here would notify into these notes.
		// `getAllToolInfos` is what the bridge's catalog reads (src/bridge.ts), so a
		// fake without it cannot answer `tools/list` at all.
		session: {
			getToolByName: () => undefined,
			getAllToolInfos: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
			model: { id: "fake-model" },
		} as never,
	});
}

/** The entrypoint's singleton survives across tests, so tear it down the real way. */
async function releaseBridge(): Promise<void> {
	AgentRegistry.resetGlobalForTests();
	for (const r of runners) await r.shutdown();
}

beforeEach(async () => {
	await releaseBridge();
	runners.length = 0;
	mountMain();
	writeConfig({ host: "127.0.0.1", port: 0, token: TOKEN });
});

afterAll(async () => {
	await releaseBridge();
	AgentRegistry.resetGlobalForTests();
	for (const key of ["A2MCP_CONFIG", "A2MCP_AUDIT"] as const) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	chmodSync(dir, 0o700);
	rmSync(dir, { recursive: true, force: true });
});

describe("session_start", () => {
	test("binds, and the port it advertises is the port that answers", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort();
		expect(port).not.toBeNull();
		expect(await ping(port as number)).toBe(200);
	});

	test("the /xfer route is on the bridge's port before anything is shared", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		// 404 rather than 405: the file route lives on the same port as the MCP endpoint,
		// is real whether or not a share is open, and says plainly that there is nothing
		// to serve yet. A 405 would tell a caller the bridge does not do files at all.
		const res = await fetch(`http://127.0.0.1:${port}/xfer/`, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("xfer_share");
		const dark = await fetch(`http://127.0.0.1:${port}/xfer/`);
		expect(dark.status).toBe(401);
	});

	test("announces a token prefix, never the whole token", async () => {
		const r = newRunner();
		await r.start();
		expect(texts(r)).toContain(`token ${TOKEN.slice(0, 6)}…`);
		expect(texts(r)).not.toContain(TOKEN);
	});

	test("a second session_start leaves one server and says nothing new", async () => {
		const main = newRunner();
		await main.start();
		const port = main.advertisedPort();
		const sub = newRunner();
		await sub.start();
		expect(sub.notes).toEqual([]);
		expect(await ping(port as number)).toBe(200);
	});

	test("warns when the configured port is taken, and serves on the new one", async () => {
		const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
		const wanted = squatter.port as number;
		writeConfig({ host: "127.0.0.1", port: wanted, token: TOKEN });
		const r = newRunner();
		await r.start();
		squatter.stop(true);
		const warning = r.notes.find((n) => n.level === "warning");
		expect(warning?.text).toContain(String(wanted));
		const port = r.advertisedPort();
		expect(port).not.toBe(wanted);
		expect(await ping(port as number)).toBe(200);
	});

	test("warns about binding to every interface", async () => {
		writeConfig({ host: "0.0.0.0", port: 0, token: TOKEN });
		const r = newRunner();
		await r.start();
		expect(r.notes.some((n) => n.level === "warning" && n.text.includes("0.0.0.0"))).toBe(true);
	});

	test("a malformed config binds nothing and names the file and field", async () => {
		writeConfig({ host: "127.0.0.1", port: "8787", token: TOKEN });
		const r = newRunner();
		await r.start();
		expect(r.advertisedPort()).toBeNull();
		const error = r.notes.find((n) => n.level === "error");
		expect(error?.text).toContain("port");
		expect(error?.text).toContain(configPath());
	});

	test("writes a config file when the host has none yet", async () => {
		rmSync(configPath(), { force: true });
		const r = newRunner();
		await r.start();
		expect(existsSync(configPath())).toBe(true);
		const saved = JSON.parse(readFileSync(configPath(), "utf8")) as { token: string };
		expect(saved.token).toHaveLength(43);
		expect(texts(r)).toContain(`token ${saved.token.slice(0, 6)}…`);
	});

	test("two session_starts in flight bind one server, not two", async () => {
		// The host awaits each runner's emit on its own async path, so a subagent's
		// session_start can land while the Main session's is still inside loadConfig.
		const main = newRunner();
		const sub = newRunner();
		await Promise.all([main.start(), sub.start()]);
		const bound = main.advertisedPort();
		expect(bound).not.toBeNull();
		expect(sub.advertisedPort()).toBeNull();
		AgentRegistry.resetGlobalForTests();
		await main.shutdown();
		// The leak is the point: a second bound server is stopped by nobody, because the
		// module only remembers the last one.
		expect(await ping(bound as number)).toBeNull();
	});

	test("a start that fails after binding leaves no half-initialized state", async () => {
		// The announce step throws. Before the catch cleared the module state, `a2mcp rotate`
		// reported success for a server nobody could reach.
		const r = newRunner("listening on");
		await r.start();
		const port = r.advertisedPort();
		expect(port).not.toBeNull();
		expect(await ping(port as number)).toBeNull();
		expect(r.notes.some((n) => n.level === "error" && n.text.includes("failed to start"))).toBe(true);
		const before = readFileSync(configPath(), "utf8");
		await r.command("rotate");
		expect(texts(r)).toContain("a2mcp not running");
		expect(readFileSync(configPath(), "utf8")).toBe(before);
	});
});

describe("session_shutdown", () => {
	test("a subagent finishing keeps the endpoint up for the Main session", async () => {
		const main = newRunner();
		await main.start();
		const port = main.advertisedPort();
		const sub = newRunner();
		await sub.start();
		// The subagent's runner is disposed while the Main session is still registered.
		await sub.shutdown();
		expect(await ping(port as number)).toBe(200);
	});

	test("the port is released once no Main session is left", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort();
		AgentRegistry.resetGlobalForTests();
		await r.shutdown();
		expect(await ping(port as number)).toBeNull();
		await r.command("status");
		expect(texts(r)).toContain("a2mcp not running");
	});

	test("a shutdown landing mid-bind leaves no orphan endpoint", async () => {
		const main = newRunner();
		// Fire the start and let it yield inside `loadConfig`: the bind is still in
		// flight, so the shutdown below sees `server` as null and has nothing to stop.
		const inFlight = main.start();
		AgentRegistry.resetGlobalForTests();
		await main.shutdown();
		await inFlight;
		// What the aborted start must not do is keep a port that already serves nobody:
		// it announced nothing, and the process-level state says the bridge is not running.
		expect(main.advertisedPort()).toBeNull();
		await main.command("status");
		expect(texts(main)).toContain("a2mcp not running");
		mountMain();
		const next = newRunner();
		await next.start();
		expect(await ping(next.advertisedPort() as number)).toBe(200);
	});

	test("a parked Main releases the port, because nothing can be served through it", async () => {
		const main = newRunner();
		await main.start();
		const port = main.advertisedPort();
		// The host's own sentinel: `AgentRef.session` is null exactly when the slot is
		// parked or aborted. The call path already refuses that state with "main session
		// not available", so the release rule has to read it the same way.
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "parked-main",
			kind: "main",
			status: "parked",
			session: null,
		});
		const sub = newRunner();
		await sub.shutdown();
		expect(await ping(port as number)).toBeNull();
	});

	test("a session_start after that binds a fresh port", async () => {
		const first = newRunner();
		await first.start();
		const old = first.advertisedPort();
		AgentRegistry.resetGlobalForTests();
		await first.shutdown();
		mountMain();
		const next = newRunner();
		await next.start();
		const fresh = next.advertisedPort();
		expect(fresh).not.toBe(old);
		expect(await ping(fresh as number)).toBe(200);
	});
});

describe("the a2mcp command", () => {
	test("registers as `a2mcp` on every runner", () => {
		expect(newRunner().commandNames).toEqual(["a2mcp"]);
	});

	test("rotate persists the new token and the running server takes it", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		await r.command("rotate");
		const rotated = (JSON.parse(readFileSync(configPath(), "utf8")) as { token: string }).token;
		expect(rotated).not.toBe(TOKEN);
		expect(await ping(port, rotated)).toBe(200);
		expect(await ping(port)).toBe(401);
	});

	test("a rotate that cannot write the file leaves the live server on the old token", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		// Read-only file: `open(w)` on it fails for a non-root owner, so the write cannot land.
		chmodSync(configPath(), 0o400);
		try {
			await r.command("rotate");
		} finally {
			chmodSync(configPath(), 0o600);
		}
		expect(r.notes.some((n) => n.level === "error" && n.text.includes("a2mcp command failed"))).toBe(true);
		expect(await ping(port)).toBe(200);
		expect((JSON.parse(readFileSync(configPath(), "utf8")) as { token: string }).token).toBe(TOKEN);
	});

	test("`token` prints the whole token, status prints the prefix", async () => {
		const r = newRunner();
		await r.start();
		await r.command("token");
		// Read back through `configPath()` rather than trusting the constant the fixture
		// wrote: if the default filename and the seeded file ever disagree, the command
		// would be showing a token that came from a file nobody opens — which is exactly
		// how a half-done rename stays green.
		const onDisk = (JSON.parse(readFileSync(configPath(), "utf8")) as { token: string }).token;
		expect(texts(r)).toContain(onDisk);
		expect(onDisk).toBe(TOKEN);
		// A different runner reads the same singleton: status shows the prefix, not the token.
		const other = newRunner();
		await other.command("");
		expect(texts(other)).toContain(`token ${onDisk.slice(0, 6)}…`);
		expect(texts(other)).not.toContain(onDisk);
	});

	test("`prompt` prints the url, the token and the prompt to hand the remote agent", async () => {
		const r = newRunner();
		await r.start();
		await r.command("prompt");
		const out = texts(r);
		// The url a remote client can use, the token in full (the operator is the one
		// handing the credential to their own client, as `/a2mcp token` does), and
		// the prompt itself.
		expect(out).toContain("url:    http://127.0.0.1:");
		expect(out).toContain("loopback only");
		expect(out).toContain(`token:  ${TOKEN}`);
		expect(out).toContain("prompt:");
		// The prompt is English: it is read by a model on the other side.
		expect(out).toContain("You are connected over MCP to a live agent session on another machine.");
		expect(out).toContain("Give every call a timeout of your own.");
		// The known first-call failure: the host's `edit` is not oldString/newString.
		expect(out).toContain("takes a hashline patch");
		expect(out).toContain("File not found");
		// The reference client is not in the installed package; the prompt has to
		// say where to get it, because the prompt is all the caller sees.
		expect(out).toContain("https://github.com/adam-ikari/a2mcp");
		expect(out).toContain("not in the installed package");
		// General-purpose host: the prompt must not steer the model toward a device
		// toolchain it may not have, and must not let it build a new environment.
		expect(out).not.toContain("device lab");
		expect(out).not.toContain("adb");
		expect(out).toContain("Use only the tools in `tools/list`");
		expect(out).toContain("do not install packages, create environments, or compile");
		// The two things a first caller gets wrong: the machine is real, so what it
		// ran stays there; and file bytes move only over /xfer, never pasted into a
		// command or carried in a tool argument.
		expect(out).toContain("What you run there stays there");
		expect(out).toContain("Files move over the bridge's own WebDAV route");
		expect(out).toContain("Use an existing WebDAV client");
		// An agent read the share as download-only and opened a reverse tunnel to
		// push a file. The prompt has to say the share goes both ways, that the
		// existing tunnel is reused, and that a reverse one is not the exit.
		expect(out).toContain("The share is bidirectional");
		expect(out).toContain("do not expose your own machine");
		expect(out).toContain("the operator's existing tunnel");
		expect(out).toContain("not a reverse tunnel");
		expect(out).toContain("curl -fL -C -");
		// The edge in front of a public URL has its own cap; the prompt has to say so.
		expect(out).toContain("request body over 100 MB");
		expect(out).toContain("split -b 64m");
		expect(out).not.toContain("a2mcp-proxy.mjs");
		expect(out).toContain("One share at a time");
		// The one exit is the operator's: a tunnel the caller opens itself is not
		// behind the bridge's token, so the prompt has to say not to.
		expect(out).toContain("Do not start your own tunnel or second file server");
		expect(out).not.toContain("xfer_get");
		expect(out).not.toContain("xfer_put");
		expect(out).toContain("Never paste megabytes into a command.");
		// And it carries no credential: a token inside a prompt would put it in a
		// model's context, which is a wider place than a config file.
		expect(out.slice(out.indexOf("prompt:"))).not.toContain(TOKEN);
	});

	/**
	 * The text a client reads is English.
	 *
	 * The remote side is a model, and the wire is where it reads: the tool
	 * descriptions, the handshake, the error bodies, the prompt. English there is
	 * not a stylistic choice — the host's own tool descriptions are English, so a
	 * Chinese error body in an English catalog reads like a mistake to whoever is
	 * on the other side. The docs are Chinese on purpose (the site renders
	 * Chinese); this guard is about the wire.
	 *
	 * It covers the bridge's own strings. The host's descriptions are the host's,
	 * passed through verbatim — the bridge does not rewrite them.
	 */
	test("the text a client reads is English", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		// Han, the CJK punctuation, and the fullwidth forms: any of them in a
		// client-facing string is the bug this guard exists for.
		const cjk = /[　-〿一-鿿＀-￯]/;
		const post = (body: unknown, headers: Record<string, string> = {}) =>
			fetch(`http://127.0.0.1:${port}/`, {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			});

		const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		const sid = init.headers.get("mcp-session-id");
		expect(sid).toBeTruthy();
		expect(await init.text(), "the initialize result").not.toMatch(cjk);

		const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid as string });
		const catalog = (await listed.json()) as {
			result: {
				tools: Array<{
					name: string;
					description: string;
					inputSchema?: { properties?: Record<string, { description?: string }> };
				}>;
			};
		};
		expect(catalog.result.tools.length).toBeGreaterThan(0);
		for (const t of catalog.result.tools) {
			expect(t.description, `${t.name} description`).not.toMatch(cjk);
			for (const [prop, schema] of Object.entries(t.inputSchema?.properties ?? {})) {
				expect(schema.description ?? "", `${t.name}.${prop}`).not.toMatch(cjk);
			}
		}

		// The bridge's own error bodies are the same reading surface: a model
		// meets them when a call is refused.
		const dark = await fetch(`http://127.0.0.1:${port}/`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
		});
		expect(await dark.text(), "the 401 body").not.toMatch(cjk);
		const noShare = await fetch(`http://127.0.0.1:${port}/xfer/`, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(await noShare.text(), "the 404 body").not.toMatch(cjk);

		// And the prompt the operator hands the remote agent.
		await r.command("prompt");
		expect(texts(r), "the prompt block").not.toMatch(cjk);
	});

	test("every subcommand says not running when the bridge never started", async () => {
		rmSync(configPath(), { force: true });
		writeConfig({ port: "not a number" });
		const r = newRunner();
		await r.start();
		for (const args of ["rotate", "token", "status"]) await r.command(args);
		expect(r.notes.filter((n) => n.text === "a2mcp not running")).toHaveLength(3);
		// Fail-closed means leaving the file alone, not healing it into something else.
		expect(readFileSync(configPath(), "utf8")).toContain("not a number");
	});
});

/**
 * `/a2mcp tunnel` against a stand-in cloudflared.
 *
 * The config's `xfer.cloudflared` is set to an absolute path, which is the obtain
 * escape hatch: no PATH lookup, no download, the file is used as given — so these
 * tests never touch the network and never install anything. The fake announces a
 * fixed `trycloudflare.com` hostname (the shape `openQuickTunnel` greps for) and
 * logs its own spawns and SIGTERMs, which is how "one child, not two" and "the
 * child died with the bridge" are checked without pid roulette.
 */
describe("the incognito switch", () => {
	// The operator's own switch, and the operator's own machine: while it is on, a
	// remote call leaves no record — neither in the audit log nor in the host's
	// session transcript, which the bridge's render events are written into. The
	// remote side cannot reach it: a caller who could silence its own record
	// would leave the log worthless as evidence, which is the one thing the log
	// is for.
	const incognitoRecords = () => auditRecords().filter((rec) => rec.tool === "incognito");

	test("the toggle flips it, says so, and records the switch", async () => {
		const r = newRunner();
		await r.start();
		await r.command("");
		expect(texts(r)).toContain("incognito=off");
		await r.command("incognito");
		expect(texts(r)).toContain("a2mcp incognito: on");
		await r.command("");
		expect(texts(r)).toContain("incognito=on");
		// The switch itself is recorded, so a quiet stretch in the log says why.
		const on = incognitoRecords().find((rec) => String(rec.args).includes("enable"));
		expect(on).toMatchObject({ sid: null, phase: "event", tool: "incognito", isError: false });
		await r.command("incognito");
		expect(texts(r)).toContain("a2mcp incognito: off");
		const off = incognitoRecords().find((rec) => String(rec.args).includes("disable"));
		expect(off).toMatchObject({ sid: null, tool: "incognito", isError: false });
		expect(incognitoRecords()).toHaveLength(2);
	});

	test("it is runtime state: a restart brings the bridge back unrecorded", async () => {
		const r = newRunner();
		await r.start();
		await r.command("incognito");
		await r.command("");
		expect(texts(r)).toContain("incognito=on");
		// The switch does not survive the process — it is a decision about this
		// stretch of time, not a property of the installation.
		await releaseBridge();
		runners.length = 0;
		mountMain();
		const r2 = newRunner();
		await r2.start();
		await r2.command("");
		expect(texts(r2)).toContain("incognito=off");
	});
});

describe("the a2mcp tunnel command", () => {
	let fakeCount = 0;
	function fakeCloudflared(): { bin: string; spawns: () => number; terms: () => number } {
		const tag = `cf${fakeCount++}`;
		const log = join(dir, `${tag}.log`);
		const bin = join(dir, `${tag}-cloudflared`);
		writeFileSync(
			bin,
			`#!/usr/bin/env bun
import { appendFileSync, writeSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, \`spawn \${process.pid}\\n\`);
process.on("SIGTERM", () => {
	appendFileSync(${JSON.stringify(log)}, \`term \${process.pid}\\n\`);
	process.exit(0);
});
writeSync(1, "https://entry-tunnel.trycloudflare.com\\n");
setTimeout(() => process.exit(0), 60_000);
`,
			{ mode: 0o755 },
		);
		const count = (kind: string) =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter((l) => l.startsWith(kind)).length
				: 0;
		return { bin, spawns: () => count("spawn"), terms: () => count("term") };
	}

	// The fake's hostname is fixed, so an URL assertion is really an "openQuickTunnel
	// found the announcement" assertion.
	const URL = "https://entry-tunnel.trycloudflare.com";

	async function startWithFake(cf: { bin: string }): Promise<Runner> {
		writeConfig({ host: "127.0.0.1", port: 0, token: TOKEN, xfer: { cloudflared: cf.bin } });
		const r = newRunner();
		await r.start();
		return r;
	}

	const tunnelRecords = () => auditRecords().filter((rec) => rec.tool === "tunnel");

	test("opens the tunnel, prints the URL and the only-gate warning, and audits the start", async () => {
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("tunnel");
		expect(texts(r)).toContain(`a2mcp tunnel: ${URL}/ — public; the Bearer token is the only gate`);
		expect(texts(r)).not.toContain(TOKEN);
		expect(cf.spawns()).toBe(1);
		const started = tunnelRecords().find((rec) => !rec.isError && String(rec.args).includes("start"));
		expect(started).toMatchObject({ sid: null, phase: "event", tool: "tunnel" });
		expect(String(started?.args)).toContain(URL);
	});

	test("incognito silences the bridge's own records too, not just the calls", async () => {
		// The mode's promise is one sentence — the host-side omp does not record the
		// call — and the bridge's own audit log goes quiet with it. The switch's own
		// line is written just outside the silent window, so the stretch is
		// explained; the tunnel's opening, which is the bridge's own doing, is not
		// written while it is on.
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("incognito");
		const before = tunnelRecords().length;
		await r.command("tunnel");
		expect(tunnelRecords().length).toBe(before);
		// Off again: the records come back.
		await r.command("incognito");
		// The close, this time: the tunnel is already open, and a second `tunnel`
		// reuses it and writes nothing at all.
		await r.command("tunnel stop");
		expect(tunnelRecords().length).toBe(before + 1);
	});

	test("`prompt` names the tunnel when one is open", async () => {
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("tunnel");
		await r.command("prompt");
		const out = texts(r);
		expect(out).toContain("url:    https://entry-tunnel.trycloudflare.com/");
		expect(out).toContain("public tunnel");
	});

	test("a second tunnel reuses the open one and spawns nothing", async () => {
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("tunnel");
		const recordsBefore = tunnelRecords().length;
		await r.command("tunnel");
		expect(texts(r)).toContain(`a2mcp tunnel already open: ${URL}/`);
		expect(cf.spawns()).toBe(1);
		// Idempotence is the whole claim here: one child, one audit line, one URL.
		expect(tunnelRecords()).toHaveLength(recordsBefore);
	});

	test("tunnel stop closes the child, audits it, and then says none is open", async () => {
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("tunnel");
		// Counted, not searched: the log spans every test in this file, and a
		// teardown now writes a stop of its own.
		const stopsBefore = tunnelRecords().filter((rec) => String(rec.args).includes("stop")).length;
		await r.command("tunnel stop");
		expect(texts(r)).toContain(`a2mcp tunnel closed: ${URL}/`);
		expect(cf.terms()).toBe(1);
		const stopped = tunnelRecords().filter((rec) => String(rec.args).includes("stop"));
		expect(stopped).toHaveLength(stopsBefore + 1);
		expect(stopped[stopsBefore]).toMatchObject({ sid: null, isError: false });
		await r.command("tunnel stop");
		expect(texts(r)).toContain("a2mcp tunnel: none open");
		expect(tunnelRecords().filter((rec) => String(rec.args).includes("stop"))).toHaveLength(stopsBefore + 1);
	});

	test("the endpoint going down takes the tunnel child with it", async () => {
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("tunnel");
		const port = r.advertisedPort() as number;
		expect(await ping(port)).toBe(200);
		AgentRegistry.resetGlobalForTests();
		await r.shutdown();
		// The public hostname must not outlive the bridge that opened it: the child
		// got its SIGTERM and the port is gone in the same breath.
		expect(cf.terms()).toBe(1);
		expect(await ping(port)).toBeNull();
		// And the death is a record like the opening was. Without it the log lists
		// public hostnames that have served the host's tools and never says which of
		// them are still answering — the share next to it already wrote its
		// `bridge stopped` close, so one teardown was running two rules.
		const stopped = tunnelRecords().find((rec) => String(rec.args).includes("stop"));
		expect(stopped).toMatchObject({ sid: null, phase: "event", tool: "tunnel", isError: false });
		expect(String(stopped?.args)).toContain("bridge stopped");
	});
});

describe("the bridge instance's own span", () => {
	// The port in a tunnel or share record names the instance that owned it, and a
	// port on its own says nothing about whether that instance is still up. The
	// instance records its own bind and its own teardown, so a `start` with no
	// matching `stop` is an endpoint that died with its host — which for a public
	// hostname is the difference between "this URL was exposed" and "this URL is
	// still answering".
	const bridgeRecords = () => auditRecords().filter((rec) => rec.tool === "bridge");

	test("a bind records the instance, and the teardown closes it", async () => {
		const r = newRunner();
		await r.start();
		const port = r.advertisedPort() as number;
		const mine = () => bridgeRecords().filter((rec) => String(rec.args).includes(`"port":${port}`));
		const started = mine().find((rec) => String(rec.args).includes("start"));
		expect(started).toMatchObject({ sid: null, phase: "event", tool: "bridge", isError: false });
		AgentRegistry.resetGlobalForTests();
		await r.shutdown();
		const stopped = mine().find((rec) => String(rec.args).includes("stop"));
		expect(stopped).toMatchObject({ sid: null, tool: "bridge", isError: false });
		expect(String(stopped?.args)).toContain("session shutdown");
	});

	test("a start that loses its session mid-bind closes the span it opened", async () => {
		// The bind outlives the session that asked for it: the instance existed for
		// a moment and then went away. A `start` with no `stop` would read as an
		// endpoint that is still up.
		const r = newRunner();
		AgentRegistry.resetGlobalForTests();
		await r.start();
		const mine = bridgeRecords().filter((rec) => String(rec.args).includes("start"));
		const opened = mine[mine.length - 1];
		expect(opened).toMatchObject({ tool: "bridge", isError: false });
		const port = /"port":(\d+)/.exec(String(opened?.args))?.[1];
		expect(port).toBeTruthy();
		const closed = bridgeRecords().filter((rec) => String(rec.args).includes(`"port":${port}`));
		expect(closed.some((rec) => String(rec.args).includes("stop"))).toBe(true);
	});
});
