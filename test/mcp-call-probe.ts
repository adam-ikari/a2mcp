/**
 * Reference-client probe: does `scripts/mcp-call.py` actually speak the bridge?
 *
 *   bun run test:mcp-call
 *
 * The script exists because agents that are not MCP clients keep hand-writing an
 * `mcp_call.py` against the bridge. This probe is the counterweight: it drives the
 * real thing, over a real host, the way such a caller would, and checks the two
 * things a hand-rolled version usually gets wrong — the session lifecycle and the
 * exit code.
 *
 * Group A runs against a real host (same start as test/install-probe.ts section 4,
 * minus `omp install`: this only needs the bridge to come up, so it links the
 * extension the way section 5 does). Group B runs against a fake Bun server whose
 * only job is to expire a session mid-call, because a real 24h idle timeout is not
 * something a probe can wait for.
 *
 * Prerequisite: python3. The repo carries no other Python; CI images may not have
 * it. When it is missing the whole probe is an info line and exit 0 — the same
 * discipline the npm-install and binary groups in install-probe.ts follow.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { XFER_TOOL_NAMES } from "../src/xfer.ts";
import { linkExtension, seedModels } from "./harness";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "mcp-call.py");

let failures = 0;
function check(cond: unknown, label: string, detail = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
}

const python = Bun.which("python3");
if (!python) {
	console.log("info: no python3 on PATH — reference-client probe skipped");
	process.exit(0);
}

/** Run the client once; return its exit code plus stdout and stderr. */
function runClient(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((res) => {
		const p = spawn(python as string, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
	});
}

// --- A. the real host --------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), "mcp-call-e2e-"));
const agentDir = join(home, ".omp", "agent");
linkExtension(agentDir);
seedModels(agentDir);

const host = spawn("omp", ["--mode", "rpc"], {
	env: { ...process.env, HOME: home },
	stdio: ["pipe", "pipe", "pipe"],
});
let hostOut = "";
let hostErr = "";
host.stdout.on("data", (d) => (hostOut += d));
host.stderr.on("data", (d) => (hostErr += d));

try {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline && !hostOut.includes("a2mcp listening")) {
		host.stdin.write(""); // the host exits on EOF, so keep stdin open
		await Bun.sleep(300);
	}
	const announced = hostOut.match(/a2mcp listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
	check(
		!!announced,
		"the host comes up and the bridge announces itself",
		announced?.[0] ||
			[...`${hostOut}\n${hostErr}`.split("\n")]
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && l.length < 200)
				.filter((l) => /error|no model|not available|failed|refus|announc/i.test(l))
				.slice(0, 3)
				.join(" | ") ||
			"no announcement and no short error line",
	);
	const url = announced?.[1] ?? "";
	const token = url ? (JSON.parse(readFileSync(join(agentDir, "a2mcp.json"), "utf8")).token as string) : "";

	if (url && token) {
		// list: the host registry plus the three bridge-owned xfer_* tools. Reading the
		// xfer names from src/xfer.ts rather than a copy here keeps the assertion from
		// going stale on a rename.
		const listed = await runClient(["--url", url, "--token", token, "list"]);
		const toolNames = listed.stdout.split("\n").map((l) => l.split("\t")[0]);
		const owned = XFER_TOOL_NAMES.filter((n) => toolNames.includes(n));
		check(
			listed.code === 0 && owned.length === XFER_TOOL_NAMES.length,
			"`list` exits 0 and prints the bridge's own tools",
			`code=${listed.code}; xfer: ${owned.join(",") || "none"} of ${XFER_TOOL_NAMES.length}; ${toolNames.filter(Boolean).length} lines`,
		);

		// schema: the whole catalog entry for one tool, so a caller can read what
		// a tool wants without writing a client to ask for it. The tool named here
		// is the bridge's own, so the assertion cannot go stale on a host change.
		const schema = await runClient(["--url", url, "--token", token, "schema", "xfer_share"]);
		let schemaOk = false;
		try {
			const parsed = JSON.parse(schema.stdout) as {
				name?: string;
				inputSchema?: { properties?: Record<string, unknown> };
			};
			schemaOk =
				schema.code === 0 && parsed.name === "xfer_share" && typeof parsed.inputSchema?.properties?.path === "object";
		} catch {
			schemaOk = false;
		}
		check(
			schemaOk,
			"`schema` prints one tool's name, description and input schema",
			`code=${schema.code}; stdout=${JSON.stringify(schema.stdout.slice(0, 80))}`,
		);

		// call bash: the README's promise, a remote tool call running on this machine.
		const called = await runClient([
			"--url",
			url,
			"--token",
			token,
			"call",
			"bash",
			JSON.stringify({ command: "echo mcp-call-ok" }),
		]);
		check(
			called.code === 0 && called.stdout.includes("mcp-call-ok"),
			"`call bash` runs locally, prints the output, exits 0",
			`code=${called.code}; stdout=${JSON.stringify(called.stdout.slice(0, 80))}`,
		);

		// unknown tool: the bridge answers with isError, and the caller's signal is the
		// non-zero exit — the thing a hand-rolled script most often forgets.
		const bogus = await runClient(["--url", url, "--token", token, "call", "no-such-tool-zzz", "{}"]);
		check(
			bogus.code !== 0,
			"calling a tool that does not exist exits non-zero",
			`code=${bogus.code}; stderr=${JSON.stringify(bogus.stderr.slice(0, 120))}`,
		);

		// wrong token: 401, named, non-zero. The token here is deliberately the wrong one.
		const bad = await runClient(["--url", url, "--token", "definitely-not-the-token", "list"]);
		check(
			bad.code !== 0 && /401/.test(bad.stderr),
			"a bad token fails non-zero and names the 401",
			`code=${bad.code}; stderr=${JSON.stringify(bad.stderr.slice(0, 120))}`,
		);
	}
} finally {
	host.kill("SIGTERM");
	rmSync(home, { recursive: true, force: true });
}

// --- B. the 404 self-recovery path -------------------------------------------

// A real session expires after 24h idle; a probe cannot wait for that. This fake
// server speaks the handshake and expires the session on the first tools/call, so
// the only thing under test is the client's re-handshake-and-retry — which is the
// behaviour the bridge's own 404 contract demands and a hand-rolled caller lacks.
{
	let seenSid: string | null = null;
	let callsSeen = 0;
	let recovered = false;
	const fake = Bun.serve({
		port: 0,
		async fetch(req) {
			const sid = req.headers.get("mcp-session-id");
			// The client's teardown is a bodyless DELETE; parse a method only where
			// there is a JSON-RPC body to read.
			if (req.method === "DELETE") return new Response(null, { status: 204 });
			const body = (await req.json()) as { method?: string };
			if (body.method === "initialize") {
				const fresh = `fake-sid-${Date.now()}`;
				// Second handshake, after the forced 404, is the recovery the probe asserts.
				if (seenSid !== null) recovered = true;
				seenSid = fresh;
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {} } }),
					{ headers: { "content-type": "application/json", "mcp-session-id": fresh } },
				);
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (body.method === "tools/call") {
				callsSeen++;
				// Expire the session exactly once, on the first call, after the client
				// already has a sid: that is the 404 the client must survive.
				if (callsSeen === 1) return new Response("unknown session", { status: 404 });
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { content: [{ type: "text", text: "recovered\n" }], isError: false },
					}),
					{ headers: { "content-type": "application/json", "mcp-session-id": sid ?? "" } },
				);
			}
			return new Response("{}", { headers: { "content-type": "application/json", "mcp-session-id": sid ?? "" } });
		},
	});
	try {
		const r = await runClient(["--url", `http://127.0.0.1:${fake.port}/`, "--token", "any", "call", "bash", "{}"]);
		check(
			r.code === 0 && r.stdout.includes("recovered") && recovered,
			"a 404 mid-call makes the client re-handshake and retry once",
			`code=${r.code}; stdout=${JSON.stringify(r.stdout.trim())}; re-handshook=${recovered}`,
		);
	} finally {
		fake.stop();
	}
}

if (failures > 0) {
	console.error(`\nMCP-CALL: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nMCP-CALL OK: scripts/mcp-call.py speaks the bridge");
