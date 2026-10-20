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

function mountMain(): void {
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "fake-main",
		kind: "main",
		// A model on the fake, because these tests are about a configured host: the
		// placeholder in src/auto-model.ts must stay out of the way when the session
		// already has one, and an empty slot here would notify into these notes.
		session: { getToolByName: () => undefined, model: { id: "fake-model" } } as never,
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

	const tunnelRecords = () =>
		(existsSync(join(dir, "audit.log")) ? readFileSync(join(dir, "audit.log"), "utf8") : "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((rec) => rec.tool === "tunnel");

	test("opens the tunnel, prints the URL and the only-gate warning, and audits the start", async () => {
		const cf = fakeCloudflared();
		const r = await startWithFake(cf);
		await r.command("tunnel");
		expect(texts(r)).toContain(`a2mcp tunnel: ${URL}/ — public; the Bearer token is the only gate`);
		expect(texts(r)).not.toContain(TOKEN);
		expect(cf.spawns()).toBe(1);
		const started = tunnelRecords().find((rec) => !rec.isError && String(rec.args).includes("start"));
		expect(started).toMatchObject({ sid: null, phase: "done", tool: "tunnel" });
		expect(String(started?.args)).toContain(URL);
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
		await r.command("tunnel stop");
		expect(texts(r)).toContain(`a2mcp tunnel closed: ${URL}/`);
		expect(cf.terms()).toBe(1);
		const stopped = tunnelRecords().find((rec) => String(rec.args).includes("stop"));
		expect(stopped).toMatchObject({ sid: null, isError: false });
		await r.command("tunnel stop");
		expect(texts(r)).toContain("a2mcp tunnel: none open");
		expect(tunnelRecords().filter((rec) => String(rec.args).includes("stop"))).toHaveLength(1);
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
	});
});
