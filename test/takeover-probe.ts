/**
 * Takeover probe — the seventh host check (bun run test:takeover; ~3 min;
 * requires the omp binary).
 *
 * The other six probes never let the host reach a model, because their
 * models.yml points at a dead port. That shape can prove "the bridge runs
 * without model answers" and nothing else: a request to an unreachable provider
 * fails silently, so the old checks could not even count model *attempts* — the
 * blind spot the 2026-10-12 wake-up finding leaked through. This probe replaces
 * the dead port with a **counting sink**: a local listener that records every
 * model request that actually reaches the network.
 *
 * What it decides, in order:
 *
 *  1. deny armed from config (`host_llm: "deny"`) — a host turn is denied before
 *     a request is built: the sink stays at zero, the sentinel comes back,
 *     exactly one attempt (no retry loop), and a `bash` over the threshold runs
 *     to completion instead of becoming a background job (the noise layer).
 *  2. the bridge itself keeps serving while armed.
 *  3. `POST /host-llm {enabled:true}` restores: the same host turn reaches the
 *     sink, and the re-arm then still finds the provider to claim — which is how
 *     the undo is observed, since a restore that left the rows on the deny api
 *     silently degrades the next claim to tripwire-only. The sink is named
 *     `anthropic` so that it is a claimed provider at all (the cowork lane keys
 *     on the provider name); with a neutral name the claim would never be
 *     exercised here.
 *  4. re-arming denies again — the switch is reversible at runtime.
 *  5. a bypass lane is covered too: a task sub-agent builds its own model
 *     registry, and its first request to a configured endpoint is denied by
 *     the destination tripwire (`curl` from bash is a separate process and
 *     deliberately outside what takeover covers).
 *  6. every toggle left an audit record carrying the session that asked.
 *  7. a `transport: pi-native` row on an unclaimed provider makes arming
 *     refused, and the refusal names it.
 *  8. no arm in this run left the switch on over a session it could not deny
 *     (the degraded state, which is the one way `host_llm=deny` could be untrue).
 *  9. with the switch off — the default configuration, and the one every other
 *     zero here was *not* measured in — handling remote calls issues no model
 *     request of its own.
 *
 * Exit 1 on any unmet assertion; evidence kept in the tmp dir on failure.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditLogPath } from "../src/audit.ts";
import { linkExtension } from "./harness.ts";

const TOKEN = "takeover-probe-token-0123456789abcdef";
const tmp = mkdtempSync("/tmp/a2mcp-takeover-XXXXXX");
const agentDir = join(tmp, ".omp", "agent");
const cfgPath = join(agentDir, "a2mcp.json");
// The base name goes into the env; the bridge dates it, and the probe reads the
// dated file.
const auditBase = join(agentDir, "a2mcp.log");
const auditPath = auditLogPath({ A2MCP_AUDIT: auditBase });

const t0 = Date.now();
const stage = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: () => boolean, ms: number, label: string): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (what()) return true;
		await sleep(200);
	}
	stage(`(timeout waiting for ${label})`);
	return false;
}

/**
 * The sink: every model request that reaches the network lands here and is
 * counted.
 *
 * Counted by method, and the distinction is not cosmetic. Takeover promises zero
 * *inference* requests, and inference is a POST; the host also fetches provider
 * *metadata* (catalog refresh, model listing) to the same configured baseUrl, and
 * that traffic goes out through the registry's own captured fetch — outside both
 * the deny and the tripwire, by design. A sink that counted both would report a
 * metadata GET during the deny window as an inference leak, which reads as a deny
 * failure and is not one. So: POSTs are the assertion, non-POSTs are tallied
 * separately and printed at the end.
 */
let sinkHits = 0;
let sinkMeta = 0;
const sink = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (req) => {
		if (req.method === "POST") sinkHits++;
		else sinkMeta++;
		// 503, not 404: "model not found" shapes invite provider-specific retry
		// handling. The ON-state assertions must never be able to blame a nonzero
		// count on the sink's answer — with 503 there is no answer to react to.
		return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "probe sink refuses" } }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	},
});
const SINK = `http://127.0.0.1:${sink.port}`;
const PORT = 39_417;

/**
 * A provider claiming `transport: pi-native` (a provider-level key in the host
 * schema — model-level placement is silently dropped). pi-ai dispatches
 * pi-native before any extension-registered api, so a shadow cannot honestly
 * cover it — takeover refuses to arm when it sees one. The row is never called
 * in this check. If the host config loader rejects the key outright, the
 * refusal check accepts "boot failed" as the fail-closed shape and says which
 * one happened.
 */
const NATIVE_ROW = `  a2mcp-takeover-native:
    baseUrl: ${SINK}/native
    api: anthropic-messages
    apiKey: not-a-real-key
    transport: pi-native
    models:
      - id: nat
        contextWindow: 100000
`;

/**
 * The sink provider is named `anthropic` on purpose: that is the provider the
 * cowork lane keys on (`provider === "anthropic" && api === "anthropic-messages"`
 * — pi-ai/src/utils/transport-fetch.ts), so this probe drives the **claimed**
 * path, not only the tripwire one. The claim is the half of the deny that
 * replaces registry rows and has to put them back; with a neutrally named
 * provider nothing here would exercise it, and a claim that failed to restore
 * would leave the host unable to reason with the switch reporting allow.
 *
 * The http:// baseUrl is deliberate too: `coworkFetch` is TLS-only and falls
 * back to `globalThis.fetch` for anything else, so the ON state still reaches
 * the sink (through the fallback) while the lane itself is the one under test.
 */
function writeHome(extraModels = "") {
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:
  anthropic:
    baseUrl: ${SINK}/v1
    api: anthropic-messages
    apiKey: not-a-real-key
    models:
      - id: small
        contextWindow: 100000
${extraModels}`,
	);
	// The model line matters: rpc mode picks the first configured model, and the
	// registry rows are what the deny claims. low threshold + long command timeout
	// so a 3s sleep WOULD auto-background if the noise layer did not stop it.
	writeFileSync(
		join(agentDir, "settings.yml"),
		`model: anthropic/small
bash:
  autoBackground:
    thresholdMs: 1500
  timeoutMs: 120000
`,
	);
	writeFileSync(cfgPath, JSON.stringify({ port: PORT, host: "127.0.0.1", token: TOKEN, host_llm: "deny" }, null, 2));
}

interface Host {
	child: ChildProcess;
	out: string;
	err: string;
}

function startHost(): Host {
	const h: Host = { child: null as unknown as ChildProcess, out: "", err: "" };
	h.child = spawn(process.env.OMP_BIN ?? "omp", ["--mode", "rpc"], {
		cwd: tmp,
		env: { ...process.env, HOME: tmp, A2MCP_CONFIG: cfgPath, A2MCP_AUDIT: auditBase },
		stdio: ["pipe", "pipe", "pipe"],
	});
	h.child.stdout?.on("data", (d) => (h.out += d));
	h.child.stderr?.on("data", (d) => (h.err += d));
	return h;
}

const AUTH = { authorization: `Bearer ${TOKEN}` };
const base = `http://127.0.0.1:${PORT}/`;

async function mcp(body: unknown, sid?: string, ms = 30000): Promise<Response> {
	return fetch(base, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH, ...(sid ? { "mcp-session-id": sid } : {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(ms),
	});
}

async function toggle(
	enabled: boolean,
	sid: string,
): Promise<{ enabled?: boolean; denied?: number; degraded?: boolean; error?: string }> {
	const r = await fetch(`${base}host-llm`, {
		method: "POST",
		headers: { "content-type": "application/json", ...AUTH, "mcp-session-id": sid },
		body: JSON.stringify({ enabled }),
		signal: AbortSignal.timeout(10000),
	});
	return (await r.json().catch(() => ({}))) as { enabled?: boolean; denied?: number; error?: string };
}

/** Drive a host turn over stdin JSONL and wait for its terminal prompt_result frame. */
async function hostTurn(h: Host, id: string, message: string, ms: number): Promise<Record<string, unknown> | null> {
	sendTurn(h, id, message);
	return awaitResult(h, id, ms);
}

function sendTurn(h: Host, id: string, message: string): void {
	h.child.stdin?.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
}

async function awaitResult(h: Host, id: string, ms: number): Promise<Record<string, unknown> | null> {
	// rpc mode answers the command with a `response` ack first; the terminal
	// frame is `prompt_result`, correlated on the same id (rpc-types.ts).
	const hasResult = () =>
		h.out.split("\n").some((l) => l.includes(`"id":"${id}"`) && l.includes(`"type":"prompt_result"`));
	const ok = await waitFor(hasResult, ms, `prompt_result for ${id}`);
	if (!ok) return null;
	const line = h.out
		.split("\n")
		.filter((l) => l.includes(`"id":"${id}"`) && l.includes(`"type":"prompt_result"`))
		.pop();
	try {
		return line ? (JSON.parse(line) as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function kill(h: Host | null, tag = ""): Promise<void> {
	if (!h) return;
	h.child.kill("SIGTERM");
	await sleep(400);
	if (h.child.exitCode === null) h.child.kill("SIGKILL");
	// Keep the host streams for post-mortem: the checks count lines that were
	// collected in memory, and a failing count is unreadable without them.
	writeFileSync(join(tmp, `host${tag}.out.log`), h.out);
	writeFileSync(join(tmp, `host${tag}.err.log`), h.err);
}

let host: Host | null = null;

try {
	linkExtension(agentDir);
	writeHome();
	stage(`sink on ${SINK}; bridge port ${PORT}`);

	const h = startHost();
	host = h;
	const armed = await waitFor(() => h.err.includes("takeover armed"), 40000, "takeover armed at boot");
	check("deny from config arms at session_start", armed);
	const arm = /takeover armed: (\d+) provider\(s\) shadowed(?: \(([^)]*)\))?, (\d+) tripwire key\(s\)/.exec(host.err);
	check("the arm reports what it shadowed", !!arm, arm?.[0] ?? "(no arm line)");
	check("the sink destination is among the tripwire keys", arm ? Number(arm[3]) >= 2 : false, `keys=${arm?.[3]}`);
	// The names, not just the count. The websocket lane's provider is the second
	// entry in the claim table and nothing else here would ever exercise it — the
	// count alone cannot say which two providers those were, so this line is what
	// gives that lane any coverage at all. It is also the operator's only view of
	// which provider names the bridge holds, given that a claim cannot be returned.
	const claimedNames = (arm?.[2] ?? "")
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	check(
		"the arm names the claimed providers, both non-fetch lanes among them",
		claimedNames.includes("anthropic") && claimedNames.includes("openai-codex"),
		`claimed: ${claimedNames.join(", ") || "(none)"}`,
	);
	// Which row is not pinned on purpose: naming the provider `anthropic` merges
	// the custom model with the host's bundled catalog, and rpc mode picks the
	// first configured row rather than settings.yml's `model:`. The claim is
	// per-provider, so any anthropic row exercises the same path.
	check(
		"the arm pushed the current model onto its deny row",
		/model pushed: anthropic\//.test(host.err),
		/(takeover armed[^\n]*)/.exec(host.err)?.[1] ?? "(no arm line)",
	);

	const sid = await (async () => {
		for (let i = 0; i < 30; i++) {
			try {
				const r = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
				if (r.status === 200) return r.headers.get("mcp-session-id") ?? "";
			} catch {}
			await sleep(300);
		}
		return "";
	})();
	check("the bridge serves an MCP session while armed", sid.length > 0);

	// --- 1. a host turn is denied at the registry layer ---
	const hitsBefore = sinkHits;
	const p1 = await hostTurn(host, "t1", "say hi", 60000);
	check(
		"the denied turn settles as an error, not a phantom success",
		!!p1 && p1.status === "error",
		p1 ? JSON.stringify(p1.error ?? null).slice(0, 200) : "(no result)",
	);
	check("the sink heard nothing during the denied turn", sinkHits === hitsBefore, `hits=${sinkHits}`);
	const denials = (host.err.match(/takeover denied a model request/g) ?? []).length;
	check("exactly one attempt — the sentinel does not feed a retry loop", denials === 1, `denials=${denials}`);
	check(
		"the sentinel text reaches the caller or the log",
		`${host.out}\n${host.err}`.includes("host inference is disabled in this mode"),
		JSON.stringify(p1 ?? null).slice(0, 240),
	);

	// --- 2. a long bash runs instead of backgrounding (noise layer) ---
	const marker = join(tmp, "bg-marker.txt");
	const bashBody = (await (
		await mcp(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "bash", arguments: { command: `sleep 3; echo done > ${marker}` } },
			},
			sid,
			60000,
		)
	).json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
	const bashText = (bashBody.result?.content ?? []).map((c) => c.text ?? "").join("\n");
	check("the 3s bash did not become a background job", !/background/i.test(bashText), bashText.slice(0, 100));
	check("it ran to completion synchronously", existsSync(marker), `isError=${bashBody.result?.isError}`);
	check("still nothing reached the sink", sinkHits === hitsBefore, `hits=${sinkHits}`);

	// --- 3. state reads back armed, with a denial count ---
	const st = await toggle(false, sid);
	check("host-llm reports the armed state", st.enabled === false, JSON.stringify(st));
	check("the denial counter is live", typeof st.denied === "number" && st.denied >= 1, JSON.stringify(st));

	// --- 4. restore: the same turn now reaches the sink (negative control) ---
	const on = await toggle(true, sid);
	check("enabled:true restores", on.enabled === true, JSON.stringify(on));
	check("the restore is logged", host.err.includes("takeover restored"));
	const hitsBefore2 = sinkHits;
	sendTurn(host, "t2", "say hi again");
	// The sink answers 503 and a restored host retries that shape for a long
	// time (17 hits in one observed window). The negative control settles on
	// the FIRST hit; pulling the plug back while the turn is still live is
	// exactly what the remote operator does, and it drains the storm before
	// the next baseline is measured.
	const firstHit = await waitFor(() => sinkHits > hitsBefore2, 30000, "first ON-state hit at the sink");
	check("after restore a host turn reaches the sink", firstHit, `hits ${hitsBefore2} -> ${sinkHits}`);
	// Whether the undo really took, which the sink hit above cannot tell: the
	// agent's own row is restored separately and the tripwire is gone, so a host
	// holding that row dials the sink either way (measured — this line stays green
	// with the undo removed). The bridge's own post-restore check is the observer,
	// and it reads a path that composes the catalog fresh rather than answering
	// from the cached snapshot. Its absence is the assertion.
	check(
		"the restore found the claimed provider serving its pre-arm rows",
		!host.err.includes("takeover restore left"),
		host.err
			.split("\n")
			.find((l) => l.includes("takeover restore left"))
			?.slice(0, 200) ?? "",
	);

	// --- 5. re-arm denies again ---
	const re = await toggle(false, sid);
	check("re-arming reports deny", re.enabled === false, JSON.stringify(re));
	const p2 = await awaitResult(host, "t2", 90000); // its retry loop now hits the tripwire
	check("the interrupted ON turn settles", !!p2, p2 ? `status=${p2.status}` : "(no result)");
	await sleep(3000); // let any in-flight request from the ON window land
	const hitsBefore3 = sinkHits;
	const denialsBefore3 = (host.err.match(/takeover denied a model request/g) ?? []).length;
	const p3 = await hostTurn(host, "t3", "say hi once more", 60000);
	check(
		"re-armed: the turn is denied again at the registry",
		!!p3 && p3.status === "error" && (host.err.match(/takeover denied a model request/g) ?? []).length > denialsBefore3,
		`status=${p3?.status} denials ${denialsBefore3} -> ${(host.err.match(/takeover denied a model request/g) ?? []).length}`,
	);
	check("re-armed: the sink stops hearing", sinkHits === hitsBefore3, `hits ${hitsBefore3} -> ${sinkHits}`);
	// Whether the *undo* took, observed from the only place it is visible: the
	// next arm reads the registry snapshot to decide which providers to claim. A
	// restore that left the rows on the deny api means the snapshot no longer has
	// an anthropic-messages row, so the re-arm claims nothing — the claim quietly
	// degrades to tripwire-only, which is the residual this whole probe exists to
	// catch. Measured: with the undo removed, this reports 0.
	const arms = [...host.err.matchAll(/takeover armed: (\d+) provider\(s\) shadowed/g)].map((m) => Number(m[1]));
	const degraded = host.err.includes("switch is still on; this session is covered by the tripwire only");
	check(
		"no arm in this run left the switch on over a session it could not deny",
		!degraded,
		"a degraded state means the non-fetch lanes were unguarded on the live session",
	);
	check(
		"re-armed: the claim still finds its providers, so the restore really undid it",
		arms.length >= 2 && arms[arms.length - 1] >= 1,
		`shadowed per arm: ${arms.join(", ")}`,
	);

	// --- 6. a bypass lane (task sub-agent) is covered too ---
	// curl from a bash tool is a separate process and OUTSIDE the promise
	// takeover makes; the task sub-agent is inside the host's own reach. It
	// resolves its own model through its own freshly built registry, so the
	// deny row the main agent holds is not its row — what stops it is the
	// destination tripwire, since every request it forms ends up in
	// globalThis.fetch, which it looks up at call time. Either way: zero
	// egress, and the denial is counted on the same stderr line.
	const cat = (await (await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, sid)).json()) as {
		result?: {
			tools?: {
				name: string;
				inputSchema?: { required?: string[]; properties?: Record<string, { type?: string; enum?: string[] }> };
			}[];
		};
	};
	const tools = cat.result?.tools ?? [];
	const taskTool = tools.find((t) => t.name === "task");
	if (!taskTool) {
		check(
			"the host offers a task tool (bypass-registry lane)",
			false,
			`catalog: ${tools.map((t) => t.name).join(",")}`,
		);
	} else {
		// Synthesize minimal arguments from the tool's own schema instead of
		// hard-coding field names that drift with the host version. The one
		// shape that cannot be guessed generically is `tasks`: the executor
		// wants at least one { task } item (its own validation error says so).
		const props = taskTool.inputSchema?.properties ?? {};
		const args: Record<string, unknown> = {};
		for (const key of taskTool.inputSchema?.required ?? ["prompt"]) {
			const p = props[key];
			if (key === "tasks") args[key] = [{ task: "respond with the single word hi" }];
			else args[key] = p?.enum?.[0] ?? (p?.type === "string" || !p?.type ? "respond with the single word hi" : "");
		}
		const hitsBefore4 = sinkHits;
		const denialsBefore4 = (host.err.match(/takeover denied/g) ?? []).length;
		const tr = (await (
			await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "task", arguments: args } }, sid, 90000)
		).json()) as {
			result?: { isError?: boolean; content?: { text?: string }[] };
			error?: unknown;
		};
		// the tool call returns when the agent is SPAWNED; the job settles a
		// moment later — its result is delivered into the session as a notice.
		const stopped = await waitFor(
			() =>
				(h.err.match(/takeover denied/g) ?? []).length > denialsBefore4 ||
				/task-result[^\n]*status=\\"failed/.test(h.out),
			20000,
			"sub-agent job failed or request denied",
		);
		const trText = (tr.result?.content ?? [])
			.map((c) => c.text ?? "")
			.join(" ")
			.slice(0, 240);
		check(
			"the sub-agent's model request never reached the sink",
			sinkHits === hitsBefore4,
			`hits ${hitsBefore4} -> ${sinkHits}; text=${trText}`,
		);
		check(
			"the sub-agent was stopped, not silently successful",
			stopped,
			`denials ${denialsBefore4} -> ${(host.err.match(/takeover denied/g) ?? []).length}`,
		);
	}

	// --- 7. every toggle from this run left an audit record ---
	// Read BEFORE the pi-native boot wipes the log: these are the records this
	// probe produced (three POSTs above: arm-check, restore, re-arm).
	await sleep(1500); // audit lands through the per-process write queue
	const audit = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";
	const llm = audit.split("\n").filter((l) => l.includes('"tool":"host_llm"'));
	check("each toggle was audited", llm.length >= 3, `host_llm records=${llm.length}`);
	check(
		"the records carry the MCP session that asked",
		llm.length >= 3 && llm.every((l) => l.includes(`"sid":"${sid}"`)),
		llm[0]?.slice(0, 160),
	);

	// --- 8. the bridge itself asks for nothing, with the switch OFF ---
	// Every zero above was measured with `host_llm: "deny"` — the one configuration
	// where the host is not supposed to reason anyway. The project's first sentence is
	// that the bridge itself never issues a model request (one remote call is
	// "receive, run the tool, answer"), and in the *default* configuration nothing was
	// counting it. The harness's placeholder provider is unreachable on purpose, so a
	// request to it fails silently and cannot be counted: the same blind spot the sink
	// was invented for, sitting on the other side of the switch.
	//
	// What this pins, and what it does not: that the bridge's own request handling
	// never reasons. It says nothing about a tool — `tools/call task` legitimately
	// does, and that is the deny subject measured above, not this window.
	const allowState = await toggle(true, sid);
	check(
		"the switch is off again for this window",
		allowState.enabled === true && !allowState.degraded,
		JSON.stringify(allowState),
	);
	const hitsBefore7 = sinkHits;
	const metaBefore7 = sinkMeta;
	await mcp({ jsonrpc: "2.0", id: 20, method: "tools/list", params: {} }, sid);
	await mcp(
		{
			jsonrpc: "2.0",
			id: 21,
			method: "tools/call",
			params: { name: "read", arguments: { path: join(tmp, "bg-marker.txt") } },
		},
		sid,
	);
	await mcp(
		{
			jsonrpc: "2.0",
			id: 22,
			method: "tools/call",
			params: { name: "bash", arguments: { command: "echo bridge-asked-for-nothing" } },
		},
		sid,
	);
	await sleep(2500); // long enough for a retry loop to have shown itself, had there been one
	check(
		"with the switch off, handling remote calls still issues no model request",
		sinkHits === hitsBefore7,
		`inference posts ${hitsBefore7} -> ${sinkHits} (host metadata traffic in the same window: ${sinkMeta - metaBefore7} non-POSTs)`,
	);

	// --- 9. a pi-native row refuses arming ---
	await kill(host, "-main");
	host = null;
	writeHome(NATIVE_ROW);
	rmSync(auditBase, { force: true });
	const h2 = startHost();
	const noticed = await waitFor(
		() => h2.err.includes("pi-native") || h2.out.includes("pi-native") || h2.err.includes("failed to start"),
		40000,
		"pi-native refusal or boot failure",
	);
	const h2text = `${h2.out}\n${h2.err}`;
	check("the pi-native row is noticed at boot", noticed);
	check(
		"the refusal names the transport it cannot cover",
		/transport 'pi-native'/.test(h2text),
		h2text
			.split("\n")
			.find((l) => l.includes("cannot arm"))
			?.slice(0, 160) ?? "else boot refused the config key",
	);
	check("no claim of arming without a shadow", !h2text.includes("takeover armed") || h2text.includes("failed to arm"));
	await kill(h2, "-native");
} catch (e) {
	stage(`probe crashed: ${(e as Error)?.message ?? String(e)}`);
	failures++;
} finally {
	await kill(host);
	sink.stop(true);
	if (failures > 0) {
		console.error(`FAIL: ${failures} assertion(s); evidence kept at ${tmp}`);
		process.exitCode = 1;
	} else {
		rmSync(tmp, { recursive: true, force: true });
		console.log(
			`takeover probe: all assertions met (${((Date.now() - t0) / 1000).toFixed(1)}s, inference posts=${sinkHits}, metadata non-POSTs=${sinkMeta})`,
		);
	}
}
