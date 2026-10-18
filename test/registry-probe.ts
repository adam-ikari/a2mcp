/**
 * Registry probe — the eighth check, and the cheapest one (bun run test:registry;
 * seconds, no omp binary, no model credentials).
 *
 * The other seven probes answer questions about *behaviour over time*: a host
 * turn, an approval prompt, a background job waking the agent. This one answers
 * a question about the host's **data structures**, and it can, because the host's
 * `ModelRegistry` is constructible in-process: `AuthStorage.create` plus
 * `new ModelRegistry(...)` against a throwaway agent dir gives the real bundled
 * catalog (5457 rows over 70-odd providers on omp 18.8.7) with no host, no TUI
 * and no network.
 *
 * That tier is what the 2026-10-13 review needed and did not have. Reading
 * `src/takeover.ts` said it re-registered every provider and cleared the
 * registrations on restore; driving the real registry showed what those two
 * calls do to a provider **another extension** registered — they take the name
 * away and never give it back, because `clearSourceRegistrations` is the host's
 * "this extension unloaded" primitive, not "undo that one call". 138 unit tests
 * were green throughout, and so was this code.
 *
 * What it decides:
 *
 *  1. arming claims a provider name only where a lane forces it (the cowork
 *     lane's provider on a default install — one name, not seventy);
 *  2. a provider another source registered survives an arm/restore cycle intact,
 *     which is the regression this probe exists for;
 *  3. a provider the bridge does NOT claim is still covered, by the tripwire;
 *  4. restore puts the catalog back row for row, so `enabled: true` means it;
 *  5. a mid-arm throw rolls back — nothing half-applied, switch reporting on;
 *  6. the host's own extension-source reconciliation cannot silently un-deny a
 *     takeover, because the session_start re-arm is idempotent;
 *  7. a rebuilt session — a second registry over the same configuration — takes
 *     the deny over from the one it replaced, and hands both back on restore.
 *
 * Exit 1 on any unmet assertion. Nothing is left behind on success: the agent
 * dir is a mkdtemp under /tmp.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

import { applyTakeover, DENY_API, hostLlmState, restoreTakeover, SENTINEL, TAKEOVER_SOURCE } from "../src/takeover.ts";

const tmp = mkdtempSync(join(tmpdir(), "a2mcp-registry-XXXXXX"));
const agentDir = join(tmp, ".omp", "agent");

let failures = 0;
let rowCount = 0;
let armMs = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Did a fetch to `url` come back refused by the tripwire? */
async function refusedBy(url: string): Promise<string> {
	try {
		await globalThis.fetch(url, { method: "POST" });
		return "";
	} catch (e) {
		return (e as Error).message;
	}
}

type Row = Record<string, unknown> & { provider: string; id: string; api?: string; baseUrl?: string };
const FIELDS = ["api", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens", "cost", "name"] as const;
const keyOf = (r: Row) => `${r.provider}/${r.id}`;
const view = (rows: readonly Row[]) =>
	new Map(rows.map((r) => [keyOf(r), JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, r[f]])))]));

try {
	process.env.OMP_AGENT_DIR = agentDir;
	const settings = await Settings.init({ agentDir });
	const auth = await AuthStorage.create(join(agentDir, "auth.db"));
	const reg = new ModelRegistry(auth as never, join(agentDir, "models.yml"), {
		settings: settings as never,
		cacheDbPath: join(agentDir, "models.db"),
	});

	const rows = () => reg.getAll() as unknown as Row[];
	const sessionFor = (refuseWith: string | null = null) => {
		let held: Row | null = rows()[0] ?? null;
		const refuse = refuseWith;
		return {
			get held() {
				return held;
			},
			session: {
				modelRegistry: reg,
				get model() {
					return held;
				},
				settings,
				agent: {
					setModel(m: Row) {
						if (refuse) throw new Error(refuse);
						held = m;
					},
				},
			} as never,
		};
	};

	const before = view(rows());
	rowCount = before.size;
	check("the real catalog is loaded in-process", rowCount > 1000, `${rowCount} rows`);

	// Another extension's provider, registered exactly the way a pi extension does
	// (`ModelRegistry.registerProvider(name, config, sourceId)`).
	reg.registerProvider(
		"myprov",
		{
			baseUrl: "https://myprov.example/v1",
			apiKey: "MY_PROV_KEY",
			api: "openai-completions",
			models: [
				{
					id: "m1",
					name: "M1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8000,
					maxTokens: 4096,
				},
				{
					id: "m2",
					name: "M2",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8000,
					maxTokens: 4096,
				},
			],
		},
		"other-extension",
	);
	const mineRows = () => rows().filter((r) => r.provider === "myprov");
	const mineBefore = mineRows().length;
	const snapshot = view(rows());

	// --- arm ---
	const a = sessionFor();
	const t0 = performance.now();
	applyTakeover(a.session);
	armMs = performance.now() - t0;

	const deniedProviders = new Set(
		rows()
			.filter((r) => r.api === DENY_API)
			.map((r) => r.provider),
	);
	check(
		"arming claims exactly the two non-fetch lanes' providers",
		[...deniedProviders].sort().join(",") === "anthropic,openai-codex",
		`denied providers: ${[...deniedProviders].join(",") || "(none)"}`,
	);
	check(
		"every other provider keeps its own api (covered by the tripwire instead)",
		rows()
			.filter((r) => r.provider === "myprov")
			.every((r) => r.api === "openai-completions"),
	);
	check("the deny api is registered", getCustomApi(DENY_API) !== undefined);
	check("the agent holds a deny row", a.held?.api === DENY_API, `${a.held?.provider}/${a.held?.id}`);
	check("the switch reports deny", hostLlmState().enabled === false);
	check("arming is cheap: it no longer recomposes the whole catalog", armMs < 50, `${armMs.toFixed(1)}ms`);

	// --- 3: an unclaimed provider is still covered ---
	const mineRefused = await refusedBy("https://myprov.example/v1/chat/completions");
	check(
		"a request to an unclaimed provider's destination is refused",
		mineRefused === SENTINEL,
		mineRefused.slice(0, 80) || "(it went out)",
	);
	const claimedRefused = await refusedBy("https://api.anthropic.com/v1/messages");
	check(
		"a request to a claimed provider's destination is refused",
		claimedRefused === SENTINEL,
		claimedRefused.slice(0, 80) || "(it went out)",
	);
	const unrelated = await refusedBy("https://example.invalid/nothing");
	check("an unrelated destination is not the bridge's to judge", unrelated !== SENTINEL);

	// --- restore ---
	restoreTakeover();
	const after = view(rows());
	const missing = [...snapshot.keys()].filter((k) => !after.has(k));
	const extra = [...after.keys()].filter((k) => !snapshot.has(k));
	const changed = [...snapshot.keys()].filter((k) => after.has(k) && after.get(k) !== snapshot.get(k));
	check(
		"restore returns every row",
		missing.length === 0 && extra.length === 0,
		`missing=${missing.length} extra=${extra.length}`,
	);
	check("restore returns every row unchanged", changed.length === 0, changed.slice(0, 3).join(", "));
	check("the agent holds its original row back", a.held?.api !== DENY_API, `${a.held?.provider}/${a.held?.id}`);
	check("the deny api is gone", getCustomApi(DENY_API) === undefined);
	check("the switch reports allow", hostLlmState().enabled === true);
	check(
		"another extension's provider survived the cycle (the regression this probe exists for)",
		mineRows().length === mineBefore && mineBefore === 2,
		`myprov rows ${mineBefore} -> ${mineRows().length}`,
	);

	// --- 5: a mid-arm throw rolls back ---
	const fetchBefore = globalThis.fetch;
	const b = sessionFor("host refused setModel: session is detaching");
	let threw = "";
	try {
		applyTakeover(b.session);
	} catch (e) {
		threw = (e as Error).message;
	}
	check("a mid-arm throw propagates", threw.includes("detaching"), threw.slice(0, 80));
	check("...leaves the agent's row alone", b.held?.api !== DENY_API);
	check("...leaves no deny api registered", getCustomApi(DENY_API) === undefined);
	check("...restores fetch", globalThis.fetch === fetchBefore);
	check("...and the switch reads as allow, so `enabled:true` means it", hostLlmState().enabled === true);
	check("...and the catalog is untouched", view(rows()).size === after.size);

	// --- 6: the host prunes source ids that are not extension paths ---
	applyTakeover(a.session);
	const deniedBefore = rows().filter((r) => r.api === DENY_API).length;
	reg.syncExtensionSources(["/some/other/extension.ts"]);
	applyTakeover(a.session); // what session_start does while the switch is on
	const deniedAfter = rows().filter((r) => r.api === DENY_API).length;
	check(
		"a host prune cannot leave the takeover silently un-darmed",
		getCustomApi(DENY_API) !== undefined && deniedAfter >= deniedBefore,
		`denied rows ${deniedBefore} -> ${deniedAfter}`,
	);
	restoreTakeover();

	// --- 7: a rebuilt session, which is what a second registry stands in for ---
	// The deny has to be re-applied whenever the host builds a new Main session, and
	// the substance of that is a *fresh registry over the same configuration* — which
	// is what a revive or an ACP attach produces. It cannot be driven from a host
	// probe: `session_start` has three emitters (runtime-init on session creation,
	// acp-agent on attach, and the interactive UI), and rpc exposes none of them for
	// Main — `new_session` is `AgentSession.newSession()`, which keeps the same
	// session object and its listeners and never emits the event. So the rebuild is
	// stood in for here, on the real thing rather than a stub.
	const auth2 = await AuthStorage.create(join(agentDir, "auth2.db"));
	const reg2 = new ModelRegistry(auth2 as never, join(agentDir, "models.yml"), {
		settings: settings as never,
		cacheDbPath: join(agentDir, "models2.db"),
	});
	const rows2 = () => reg2.getAll() as unknown as Row[];
	const deniedIn = (get: () => Row[]) => get().filter((r) => r.api === DENY_API).length;
	// Baselines taken here, not from the earlier snapshot: section 6's prune removed
	// the other extension's provider from registry A (that is what pruning a source
	// does), and registry B never had it. Comparing against the old counts would be
	// measuring the prune, not the swap.
	const baseA = view(rows()).size;
	const baseB = view(rows2()).size;
	const b2 = sessionFor();
	(b2.session as unknown as { modelRegistry: unknown }).modelRegistry = reg2;

	applyTakeover(a.session);
	applyTakeover(b2.session); // the rebuilt session's session_start
	const secondDenied = deniedIn(rows2);
	check(
		"the rebuilt session's fresh registry is denied by the re-arm",
		secondDenied > 0 && getCustomApi(DENY_API) !== undefined,
		`denied rows on the new registry: ${secondDenied}/${rows2().length}`,
	);
	check(
		"the registry it replaced is handed back its own rows",
		deniedIn(rows) === 0 && view(rows()).size === baseA,
		`denied rows on the old registry: ${deniedIn(rows)}`,
	);
	check(
		"the agent row follows the session: old back, new denied",
		a.held?.api !== DENY_API && b2.held?.api === DENY_API,
	);
	// One refused request must count once. A double-wrapped tripwire would log twice
	// per call, which is the shape a restore-then-rearm on the same global produces if
	// the fetch reference is mishandled — and it would also mean the operator's denial
	// count drifts away from the attempts.
	const deniedCountBefore = hostLlmState().denied;
	try {
		await globalThis.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
	} catch {}
	check(
		"the tripwire is installed once, not wrapped around itself across the swap",
		hostLlmState().denied === deniedCountBefore + 1,
		`denied ${deniedCountBefore} -> ${hostLlmState().denied}`,
	);
	restoreTakeover();
	check(
		"...and restoring hands the new registry its rows back too",
		deniedIn(rows2) === 0 && view(rows2()).size === baseB && getCustomApi(DENY_API) === undefined,
		`denied rows on the new registry after restore: ${deniedIn(rows2)}`,
	);

	console.log(`\nregistry: ${rowCount} rows, ${armMs.toFixed(1)}ms to arm, source id ${TAKEOVER_SOURCE}`);
} catch (e) {
	console.error(`probe crashed: ${(e as Error)?.stack ?? String(e)}`);
	failures++;
} finally {
	restoreTakeover();
	if (failures > 0) {
		console.error(`FAIL: ${failures} assertion(s); agent dir kept at ${tmp}`);
		process.exitCode = 1;
	} else {
		rmSync(tmp, { recursive: true, force: true });
		console.log(`registry probe: all assertions met (${rowCount} rows against the real registry)`);
	}
}
