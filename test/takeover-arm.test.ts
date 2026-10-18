/**
 * Arming and restoring, at the layer that owns process-global state.
 *
 * The pure layer (test/takeover.test.ts) pins what a deny overlay looks like;
 * this file pins the two invariants that only show up once `applyTakeover` is
 * allowed to touch things it cannot take back:
 *
 *  1. **Arming is a transaction.** Everything `applyTakeover` mutates — the deny
 *     api registration, the agent's model row, the settings overrides, the fetch
 *     tripwire — can throw. A throw must leave nothing behind, because the
 *     endpoint answers the refusal and the operator's next move is
 *     `enabled: true`, which has to mean it. This is the bug the 2026-10-13
 *     review measured on a real registry: a throw in the middle left 5457 of
 *     5457 rows denied while the switch reported `enabled: true` and
 *     `setEnabled(true)` could not undo it.
 *  2. **Arming is idempotent per session.** The host can drop the shadow
 *     underneath a takeover (its extension-source reconciliation prunes a source
 *     id that is not an extension path), so `session_start` re-arms
 *     unconditionally while the switch is on. A second arm must keep the row the
 *     first one saved, or restore would hand back a deny row and leave the host
 *     denied with the switch reporting otherwise.
 *
 * The session is a stub — a real `AgentSession` is the seventh host probe's job.
 * What is NOT stubbed is the registry-independent machinery: the custom-api
 * registry, pi-coding-agent's settings instance, and `globalThis.fetch` are the
 * host's own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { getCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const AGENT_DIR = `/tmp/a2mcp-takeover-arm-${process.pid}`;
rmSync(AGENT_DIR, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });
const previousAgentDir = process.env.OMP_AGENT_DIR;
process.env.OMP_AGENT_DIR = AGENT_DIR;

const { applyTakeover, restoreTakeover, hostLlmState, DENY_API } = await import("../src/takeover.ts");

type Row = Record<string, unknown> & { provider: string; id: string; api?: string };

const ROWS: Row[] = [
	{
		provider: "anthropic",
		id: "claude-x",
		name: "Claude X",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		provider: "openai",
		id: "gpt-z",
		name: "GPT Z",
		api: "openai-responses",
		baseUrl: "https://api.openai.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	},
];

interface Stub {
	session: AgentSession;
	registered: string[];
	/** What the agent currently holds. */
	held: () => Row | null;
	/** What the user picking a model from the TUI does. */
	pick: (row: Row) => void;
	rows: Row[];
}

const settings = await Settings.init({ agentDir: AGENT_DIR });

/**
 * A session stub over a plain array of rows. With the narrow shadow table the
 * only provider the deny claims here is `anthropic`, so the registry stub is
 * small on purpose — `test/registry-probe.ts` is where the real registry is
 * driven.
 */
function stubSession(rows: Row[] = ROWS): Stub {
	let current: Row | null = rows[0] ?? null;
	let refuseWith: string | null = null;
	const registered: string[] = [];
	const setModel = (m: Row): void => {
		if (refuseWith) throw new Error(refuseWith);
		current = m;
	};
	const registry = {
		getAll: () => rows,
		registerProvider: (provider: string) => {
			registered.push(provider);
		},
		clearSourceRegistrations: () => {},
		find: () => undefined,
	};
	return {
		registered,
		rows,
		held: () => current,
		pick: setModel,
		session: {
			modelRegistry: registry,
			get model() {
				return current;
			},
			settings,
			agent: { setModel },
			/** test hook: make the host refuse the swap, the way a detaching session does */
			_refuseWith: (why: string | null) => {
				refuseWith = why;
			},
		} as unknown as AgentSession,
	};
}

const refuseWith = (stub: Stub, why: string | null): void =>
	(stub.session as unknown as { _refuseWith: (w: string | null) => void })._refuseWith(why);

/** Every test gets its own armed state back, whatever it did in between. */
function armed(fn: (stub: Stub) => void): void {
	const stub = stubSession();
	try {
		fn(stub);
	} finally {
		restoreTakeover();
	}
}

afterAll(() => {
	restoreTakeover();
	rmSync(AGENT_DIR, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
	else process.env.OMP_AGENT_DIR = previousAgentDir;
});

describe("applyTakeover / restoreTakeover", () => {
	test("arming pushes the deny row, registers the api, and wraps fetch", () => {
		armed((stub) => {
			const fetchBefore = globalThis.fetch;
			const lines: string[] = [];
			const realError = console.error;
			console.error = (line: string) => void lines.push(String(line));
			try {
				applyTakeover(stub.session);
			} finally {
				console.error = realError;
			}
			const armLine = lines.find((l) => l.includes("takeover armed")) ?? "";
			expect(hostLlmState().enabled).toBe(false);
			expect(stub.held()?.api).toBe(DENY_API);
			expect(getCustomApi(DENY_API)).toBeDefined();
			expect(globalThis.fetch).not.toBe(fetchBefore);
			// Only the cowork lane's provider is claimed: a name the bridge has no
			// reason to own is a name it cannot give back (test/registry-probe.ts).
			expect(stub.registered).toEqual(["anthropic"]);
			// The names go in the log line: that line is the operator's only view of
			// which provider names the bridge holds, and a count alone cannot say
			// whether the websocket lane's provider was among them.
			expect(armLine).toContain("(anthropic)");
		});
	});

	test("restoring puts the original row back and un-registers the api", () => {
		armed((stub) => {
			applyTakeover(stub.session);
			restoreTakeover();
			expect(hostLlmState().enabled).toBe(true);
			expect(stub.held()?.api).toBe("anthropic-messages");
			expect(getCustomApi(DENY_API)).toBeUndefined();
		});
	});

	test("a throw mid-arm leaves nothing behind and reports the switch as on", () => {
		armed((stub) => {
			const fetchBefore = globalThis.fetch;
			refuseWith(stub, "host refused setModel: session is detaching");
			expect(() => applyTakeover(stub.session)).toThrow(/detaching/);
			// The three things a half-arm would have left: the agent's row, the api
			// registration, and the switch's own answer to `enabled: true`.
			expect(stub.held()?.api).toBe("anthropic-messages");
			expect(getCustomApi(DENY_API)).toBeUndefined();
			expect(globalThis.fetch).toBe(fetchBefore);
			expect(hostLlmState().enabled).toBe(true);
		});
	});

	test("re-arming the same session keeps the row the first arm saved", () => {
		armed((stub) => {
			applyTakeover(stub.session);
			applyTakeover(stub.session); // what an unconditional session_start re-arm does
			expect(stub.held()?.api).toBe(DENY_API);
			restoreTakeover();
			// Not the deny row: restore must not hand the host back a row that refuses.
			expect(stub.held()?.api).toBe("anthropic-messages");
			expect(stub.held()?.id).toBe(ROWS[0].id);
		});
	});

	test("a model switch made while armed is the operator's, not stale state to undo", () => {
		armed((stub) => {
			applyTakeover(stub.session);
			stub.pick(ROWS[1]); // the user picks another model from the TUI
			restoreTakeover();
			expect(stub.held()?.id).toBe(ROWS[1].id);
		});
	});

	test("arming a second session restores the first", () => {
		const a = stubSession();
		const b = stubSession();
		try {
			applyTakeover(a.session);
			applyTakeover(b.session);
			expect(b.held()?.api).toBe(DENY_API);
			// One live session is denied, which is what the state means.
			expect(hostLlmState().enabled).toBe(false);
			// The fetch tripwire is process-global and was installed once, not twice.
			expect(a.held()?.api).toBe("anthropic-messages");
		} finally {
			restoreTakeover();
		}
	});

	test("an uncovered lane refuses the arm before anything is registered", () => {
		armed((stub) => {
			// On a provider nothing claims — the same transport on a claimed one is
			// covered, because its rows are replaced by overlays carrying no transport.
			(stub.session as unknown as { modelRegistry: { getAll: () => Row[] } }).modelRegistry.getAll = () => [
				{ ...ROWS[0], provider: "custom", id: "native-thing", transport: "pi-native" },
			];
			expect(() => applyTakeover(stub.session)).toThrow(/pi-native/);
			expect(stub.registered).toEqual([]);
			expect(getCustomApi(DENY_API)).toBeUndefined();
			expect(hostLlmState().enabled).toBe(true);
			expect(hostLlmState().degraded).toBe(false);
		});
	});

	test("a refusal while the switch is on reports degraded, not deny", () => {
		// The session is rebuilt and the new one's catalog holds a lane nothing here
		// can cover. The tripwire is process-global and still installed, so the fetch
		// lanes are covered and the two non-fetch ones are not — and `enabled:false`
		// alone would say the host cannot reason, which on those lanes is untrue.
		const good = stubSession();
		const bad = stubSession();
		(bad.session as unknown as { modelRegistry: { getAll: () => Row[] } }).modelRegistry.getAll = () => [
			{ ...ROWS[0], provider: "custom", id: "native-thing", transport: "pi-native" },
		];
		try {
			applyTakeover(good.session);
			expect(hostLlmState().degraded).toBe(false);
			expect(() => applyTakeover(bad.session)).toThrow(/pi-native/);
			expect(hostLlmState()).toMatchObject({ enabled: false, degraded: true });
			restoreTakeover();
			expect(hostLlmState()).toMatchObject({ enabled: true, degraded: false });
		} finally {
			restoreTakeover();
		}
	});
});
