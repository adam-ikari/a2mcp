/**
 * Takeover: the remote caller's switch for whether this host may reason at all.
 *
 * A remote `tools/call` runs in the host's live session, and tool execution can
 * leave session-level side effects (a long `bash` becoming a background job, a
 * background job completing and delivering its result) that wake the host's own
 * agent loop — dozens of real inference turns paid by the host (measured
 * 2026-10-12, see CHANGELOG). The user-level decision this module implements:
 * while takeover is armed, the host issues **zero** model requests; whether the
 * host may reason is decided by whoever holds the token, not by the host.
 *
 * ## How the guarantee is built
 *
 * Three layers, each covering a lane the others cannot see. The lanes were read
 * off the host, not assumed — `pi-ai/src/utils/transport-fetch.ts` is the one
 * fetch every inference request goes through, and it picks its base like this:
 *
 * ```ts
 * const base = given ?? (model.provider === "anthropic" && model.api === "anthropic-messages"
 *   ? coworkFetch            // node:https, never globalThis.fetch
 *   : globalThis.fetch);     // read at call time, so a wrapper on the global sees it
 * ```
 *
 * 1. **The deny api, plus the agent's own model row.** `a2a-deny` is registered
 *    as a custom api whose `streamSimple` only counts and fails, and the row the
 *    agent holds is swapped for a copy of the live one carrying that api
 *    (`agent.setModel`, because the agent holds the `Model` object it captured,
 *    not a lookup). The host's own turn is then refused before a request is
 *    built: one attempt, no retry loop, no credential resolution.
 * 2. **A destination-keyed `globalThis.fetch` tripwire.** Every request whose URL
 *    host matches a `baseUrl` seen in the pre-arm registry snapshot is refused
 *    there. This is what covers everything that resolves a model on its own —
 *    task subagents, websearch, commit generation — because their request ends
 *    up in `globalThis.fetch`, which they look up at call time.
 * 3. **Registry shadowing, for the providers whose requests skip the global.**
 *    `coworkFetch` is a raw `node:https` client and the Codex transport opens a
 *    websocket; neither is a fetch, so those provider names are re-registered
 *    behind the deny api. Two names on a stock install, out of 73.
 *
 * Layer 3 is the one that costs something, and it is deliberately narrow: see
 * "Why only these providers" below.
 *
 * Plus a noise layer: runtime setting overrides that silence the sources known
 * to wake a host on their own (auto-background, retry, ttsr, …). These do not
 * add safety — the deny does — they keep refused turns out of the host's
 * history.
 *
 * ## Why only these providers
 *
 * Shadowing a provider name is not free. `ModelRegistry.registerProvider(name, …,
 * sourceId)` records `sourceId` as that name's owner and, when somebody else
 * owned it, clears the incumbent's runtime state before taking over
 * (`#clearRuntimeProviderState`: runtime overlays, dynamic-model managers,
 * discovery state, the runtime api key). `clearSourceRegistrations` — the only
 * undo the public API offers — cannot give any of that back. So a bridge that
 * shadowed every provider in the catalog would delete every provider another
 * extension registered, once per arm, and never restore it (measured 2026-10-13
 * against the real registry: a provider an extension had registered went from two
 * rows to none after one arm/restore cycle). It also puts a synthetic source id
 * into `#registeredProviderSources`, which the host prunes on the next session
 * construction (`syncExtensionSources(extensionPaths)`).
 *
 * Hence: claim a provider name only when a lane forces it — today the cowork
 * lane's provider and the websocket lane's, so a stock install claims two names
 * instead of 73. `restoreTakeover` then checks the claimed names against the
 * pre-arm snapshot instead of assuming `clearSourceRegistrations` was enough,
 * and names any provider that did not come back.
 *
 * ## What this gives up, and what it refuses
 *
 * The deny fails a model request with a fixed sentinel error, classified
 * non-retriable (a retry loop would spend the host's clock even if not its
 * API). The turn that was interrupted still ends with an error message in the
 * host's session history: arming does not un-start turns, it stops them.
 *
 * Two lanes are not a fetch and are not an api dispatch, so no layer reaches
 * them: the non-fetch transports above (claimed, not refused) and a row that sets
 * `transport` — pi-native and anything that short-circuits before the
 * custom-api check — on a provider nothing claims. Takeover then **refuses to
 * arm** and says which row: it will not promise a zero it cannot deliver. This
 * is the same rule the module has always applied to `pi-native`, narrowed to the
 * rows it cannot shadow.
 *
 * Residuals, listed honestly: non-inference egress (update checks, telemetry) is
 * deliberately *not* blocked — the tripwire keys on inference endpoints only; a
 * provider added to models.yml after arming contributes no tripwire key until
 * the next arm; a provider whose runtime registration belonged to another
 * extension and needed shadowing does not get that registration back (named in
 * the host log on restore — restart the host to recover it); a row the host
 * resolves mid-turn and re-pushes over the deny row falls back to the tripwire.
 *
 * ## Lifecycle
 *
 * Arming is runtime state on the live Main session; it is never written to the
 * config. The config (`host_llm: "deny"`) only decides the *startup* state: a
 * restart returns the host to what the operator last wrote, and each
 * `session_start` re-arms a rebuilt session whenever the switch is on — not only
 * when the config says so, because the host can drop the shadow underneath a
 * runtime-armed takeover (see above) and the switch must not be a promise the
 * host breaks silently.
 */

import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AgentRegistry, type AgentSession, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/** Source id handed to the deny api registration and to any shadowed provider. */
export const TAKEOVER_SOURCE = "a2a-bridge";
/** The fake api name the deny row carries; dispatch enters `denyStreamSimple` through it. */
export const DENY_API = "a2a-deny";
/** Port 9 (discard): if a shadowed baseUrl were ever dialed, nothing answers. */
const DENY_BASE_URL = "http://127.0.0.1:9";

/**
 * The failure a denied request carries. Fixed text with no digits and none of
 * the provider-vocabulary markers the host's retry classifiers key on
 * (transient-transport, strict-tools-400, oauth, codex), so a denial ends the
 * turn instead of feeding a retry loop — verified against the classifiers and
 * on a live host (exactly one attempt, `retryable: false`).
 */
export const SENTINEL = "a2a-bridge takeover: host inference is disabled in this mode";

/**
 * Sources known to wake the host's own loop without a caller asking. Booleans
 * all, all silenced with a runtime (non-persisted) override. `title.generator`
 * is deliberately absent: it has no off value, so a title turn under deny
 * simply fails like any other.
 */
const NOISE_IDS: readonly string[] = [
	"bash.autoBackground.enabled",
	"retry.enabled",
	"advisor.enabled",
	"ttsr.enabled",
	"prewalk.enabled",
	"autolearn.enabled",
	"autolearn.autoContinue",
];

/** The slice of a registry row this module reads — structural, so it unit-tests without a host. */
export interface RegistryRowView {
	provider: string;
	id: string;
	name: string;
	api: string;
	transport?: string;
	baseUrl?: string;
	reasoning: boolean;
	input: string[];
	cost: unknown;
	contextWindow: number;
	maxTokens: number;
}

export interface DenyOverlay {
	baseUrl: string;
	apiKey: string;
	api: string;
	models: {
		id: string;
		name: string;
		api: string;
		reasoning: boolean;
		input: string[];
		cost: unknown;
		contextWindow: number;
		maxTokens: number;
	}[];
}

/** A row whose lane neither the deny api nor the tripwire can reach. */
export interface UncoveredLane {
	row: RegistryRowView;
	reason: string;
}

/**
 * The rows this bridge cannot cover, if any: a model-level `transport` on a
 * provider the deny does **not** claim. pi-ai dispatches on `model.transport`
 * before the custom-api check (`if (model.transport === "pi-native")`), so
 * nothing but the api name can intercept it — and a claimed provider's rows are
 * replaced wholesale by overlays that carry no transport, so the same row on a
 * claimed provider is covered. Arming would be a promise the bridge cannot keep,
 * so it refuses and names the row.
 *
 * Pure: it throws nothing and mutates nothing.
 */
export function uncoveredLane(rows: readonly RegistryRowView[], claimed: ReadonlySet<string>): UncoveredLane | null {
	for (const row of rows) {
		if (!row.transport || claimed.has(row.provider)) continue;
		return {
			row,
			reason: `transport '${row.transport}', which the host dispatches before any api, so no deny row can intercept it`,
		};
	}
	return null;
}

/**
 * Why one row needs the deny behind it in the registry, or `null` when its
 * requests go through `globalThis.fetch` and the tripwire already has them.
 *
 * Both entries are the host's own conditions, read off its source, and both are
 * keyed on the api rather than on a row's flags — a row flag is not a lane:
 *
 *  - **cowork** — `transport-fetch.ts` picks `coworkFetch` (a raw `node:https`
 *    client) when `provider === "anthropic" && api === "anthropic-messages"`.
 *  - **websocket** — the Codex transport opens a socket, chosen by
 *    `api === "openai-codex-responses"` plus either the row's
 *    `preferWebsockets` or the session setting the host forwards on every
 *    provider call (`providers.openaiWebsockets`), so *every* codex row can take
 *    it. A stock omp 18.8.7 catalog ships such a row, which is why this is a
 *    claim and not a refusal: refusing would make arming impossible out of the
 *    box.
 *
 * If the host grows a third non-fetch lane, this table is the place it lands.
 */
export function nonFetchLane(row: RegistryRowView): "cowork" | "websocket" | null {
	if (row.provider === "anthropic" && row.api === "anthropic-messages") return "cowork";
	if (row.api === "openai-codex-responses") return "websocket";
	return null;
}

/**
 * The providers to claim, with **all** of their rows. Registering only the rows
 * that motivated the claim would drop the provider's other rows out of the
 * catalog while armed, and with them the session's current model if it happens to
 * be one of those — which is a denied turn becoming an allowed one. Whole
 * provider or none.
 */
export function shadowedProviders(rows: readonly RegistryRowView[]): Map<string, RegistryRowView[]> {
	const wanted = new Set<string>();
	for (const row of rows) {
		if (nonFetchLane(row)) wanted.add(row.provider);
	}
	const byProvider = new Map<string, RegistryRowView[]>();
	for (const row of rows) {
		if (!wanted.has(row.provider)) continue;
		const list = byProvider.get(row.provider) ?? [];
		list.push(row);
		byProvider.set(row.provider, list);
	}
	return byProvider;
}

/**
 * Group rows by provider and produce the shadowing registration for each.
 * Pure, and it assumes `uncoveredLane` already cleared the snapshot: a row with
 * a transport would be refused rather than shadowed, so nothing that reaches
 * here needs one.
 */
export function buildDenyOverlays(rows: readonly RegistryRowView[]): Map<string, DenyOverlay> {
	const byProvider = new Map<string, RegistryRowView[]>();
	for (const row of rows) {
		const list = byProvider.get(row.provider) ?? [];
		list.push(row);
		byProvider.set(row.provider, list);
	}
	const out = new Map<string, DenyOverlay>();
	for (const [provider, models] of byProvider) {
		out.set(provider, {
			baseUrl: DENY_BASE_URL,
			apiKey: "denied",
			api: DENY_API,
			models: models.map((m) => ({
				id: m.id,
				name: m.name,
				api: DENY_API,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			})),
		});
	}
	return out;
}

/**
 * The row the agent holds while armed: the live one with the deny api and the
 * discard endpoint, and with its credential resolvers dropped. Dropping them is
 * not tidiness — pi-ai resolves `resolveHeaders` *before* the custom-api check,
 * so leaving them in would make a denied turn run the provider's `!command` key
 * program to obtain a key the request will never use.
 */
export function buildDenyModel(row: Record<string, unknown>): Record<string, unknown> {
	const { headers, resolveHeaders, ...rest } = row as Record<string, unknown> & {
		headers?: unknown;
		resolveHeaders?: unknown;
	};
	void headers;
	void resolveHeaders;
	return { ...rest, api: DENY_API, baseUrl: DENY_BASE_URL };
}

function isDenyRow(model: unknown): boolean {
	return (model as { api?: string } | null | undefined)?.api === DENY_API;
}

/**
 * The destinations the tripwire refuses: every `host` and `hostname` appearing
 * as a row `baseUrl` in the pre-arm snapshot. Both forms because a request URL
 * may carry an explicit default port the configured baseUrl does not. Non-URL
 * baseUrls contribute nothing — there is no destination to match.
 */
export function tripwireKeys(rows: readonly RegistryRowView[]): Set<string> {
	const keys = new Set<string>();
	for (const row of rows) {
		if (!row.baseUrl) continue;
		try {
			const u = new URL(row.baseUrl);
			keys.add(u.host);
			keys.add(u.hostname);
		} catch {
			// not a URL: nothing to match on
		}
	}
	return keys;
}

let denies = 0;

function denyStreamSimple(model: unknown): AssistantMessageEventStream {
	denies++;
	const stream = new AssistantMessageEventStream();
	const m = model as { provider?: string; id?: string } | undefined;
	console.error(`[a2a-bridge] takeover denied a model request (${m?.provider}/${m?.id}); denied=${denies}`);
	// Fail on a microtask, not synchronously: callers set up their stream
	// listeners after the call returns, and a same-tick failure would be missed.
	queueMicrotask(() => stream.fail(new Error(SENTINEL)));
	return stream;
}

type Fetch = typeof globalThis.fetch;

function makeTripwire(prev: Fetch, keys: ReadonlySet<string>): Fetch {
	return ((input: string | URL | Request, init?: RequestInit) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		let host = "";
		let hostname = "";
		try {
			const u = new URL(raw);
			host = u.host;
			hostname = u.hostname;
		} catch {
			return prev(input as never, init as never);
		}
		if (keys.has(host) || keys.has(hostname)) {
			denies++;
			console.error(`[a2a-bridge] takeover denied an outbound request to ${host}; denied=${denies}`);
			return Promise.reject(new Error(SENTINEL));
		}
		return prev(input as never, init as never);
	}) as Fetch;
}

interface Armed {
	session: AgentSession;
	/** The fetch in effect before this bridge wrapped it. */
	prevFetch: Fetch;
	/** The row to put back on restore; null when no row was ever pushed. */
	prevModel: Record<string, unknown> | null;
	overriddenIds: string[];
	/** Providers this bridge claimed, with their rows as they were before. */
	claimed: Map<string, RegistryRowView[]>;
}

let armed: Armed | null = null;

/**
 * Make the host unable to reason, idempotently. Arming a new session while an
 * old one is armed restores the old first (its session may already be dead,
 * which is why restore tolerates that); re-arming the *same* session re-registers
 * what the host may have dropped underneath us and keeps the row it was first
 * given, so a `session_start` can call this unconditionally. Throws — before
 * mutating anything — when the snapshot holds a lane nothing here can cover.
 */
export function applyTakeover(session: AgentSession): void {
	const sameSession = armed?.session === session;
	if (armed && !sameSession) restoreTakeover();

	const rows = session.modelRegistry.getAll() as unknown as RegistryRowView[];
	const claimed = shadowedProviders(rows);
	const lane = uncoveredLane(rows, new Set(claimed.keys()));
	if (lane) {
		throw new Error(`cannot arm takeover: model ${lane.row.provider}/${lane.row.id} ${lane.reason}`);
	}
	const keys = tripwireKeys(rows);
	const cur = session.model as Record<string, unknown> | null | undefined;

	// Recorded before the first mutation. Everything below can throw, and a throw
	// with `armed` still null used to leave a fully shadowed registry that
	// `restoreTakeover` — whose first line is `if (!armed) return` — could not
	// undo, while the endpoint answered `enabled: true` to the caller asking for
	// it back. The record goes in first so that path is a rollback, not a trap.
	const rec: Armed = {
		session,
		prevFetch: sameSession ? (armed?.prevFetch ?? globalThis.fetch) : globalThis.fetch,
		prevModel: isDenyRow(cur) ? (armed?.prevModel ?? null) : (cur ?? null),
		overriddenIds: sameSession ? [...(armed?.overriddenIds ?? [])] : [],
		claimed,
	};
	armed = rec;

	let pushed = "none";
	try {
		registerCustomApi(DENY_API, denyStreamSimple as never, TAKEOVER_SOURCE);
		const reg = session.modelRegistry;
		for (const [provider, overlay] of buildDenyOverlays([...claimed.values()].flat())) {
			reg.registerProvider(
				provider,
				{
					...overlay,
					api: overlay.api as never,
					streamSimple: denyStreamSimple as never,
					models: overlay.models.map((m) => ({ ...m, api: m.api as never })),
				} as never,
				TAKEOVER_SOURCE,
			);
		}
		if (cur) {
			if (isDenyRow(cur)) {
				pushed = `${cur.provider}/${cur.id} (already denied)`;
			} else {
				// The agent holds the Model object it captured, not a lookup: pushing the
				// deny row is what routes the main loop's *next* request through deny.
				session.agent.setModel(buildDenyModel(cur) as never);
				pushed = `${cur.provider}/${cur.id}`;
			}
		}

		for (const id of NOISE_IDS.concat("providers.cacheWarming", "compaction.enabled")) {
			const setting = lookup(id);
			if (!setting) continue;
			setting.override(session.settings as never, (id === "providers.cacheWarming" ? "off" : false) as never);
			rec.overriddenIds.push(id);
		}

		globalThis.fetch = makeTripwire(rec.prevFetch, keys);
	} catch (e) {
		restoreTakeover();
		throw e;
	}
	console.error(
		`[a2a-bridge] takeover armed: ${claimed.size} provider(s) shadowed, ${keys.size} tripwire key(s), model pushed: ${pushed}`,
	);
}

/**
 * Replay the snapshot: put the original row back, un-shadow the registry, drop
 * the runtime overrides, remove the tripwire and the deny api. No-op when not
 * armed, so a double `enabled: true` is harmless.
 *
 * The claimed providers are then compared against the rows they had before. The
 * registry's own undo is not a promise — when the incumbent registration was
 * somebody else's, `clearSourceRegistrations` removes it without a way to put it
 * back — so the claim "restore replays the snapshot" is checked here instead of
 * assumed, and a provider that did not come back is named.
 */
export function restoreTakeover(): void {
	if (!armed) return;
	const { session, prevFetch, overriddenIds, prevModel, claimed } = armed;
	armed = null;
	globalThis.fetch = prevFetch;
	try {
		unregisterCustomApis(TAKEOVER_SOURCE);
		session.modelRegistry.clearSourceRegistrations(TAKEOVER_SOURCE);
		const cur = session.model as Record<string, unknown> | null | undefined;
		// Only put the saved row back while the agent still holds ours: a model
		// switch made while armed is the operator's choice, not state to undo.
		if (prevModel && (!cur || isDenyRow(cur))) session.agent.setModel(prevModel as never);
		for (const id of overriddenIds) {
			lookup(id)?.clearOverride(session.settings as never);
		}
	} catch (e) {
		// The session may have been torn down between arming and restoring; the
		// fetch reference is already back, which is the half that is process-global.
		console.error(`[a2a-bridge] takeover restore hit a dead session: ${(e as Error)?.message ?? String(e)}`);
		return;
	}

	const lost = unshadowedProviders(session, claimed);
	if (lost.length > 0) {
		console.error(
			`[a2a-bridge] takeover restore left ${lost.length} provider(s) unregistered (their runtime registration belonged to another source and the registry cannot replay it): ${lost.join(", ")} — restart the host to recover`,
		);
	}
	console.error("[a2a-bridge] takeover restored: the host may issue model requests again");
}

/** Providers that do not serve the rows they had before arming. */
function unshadowedProviders(session: AgentSession, claimed: Map<string, RegistryRowView[]>): string[] {
	if (claimed.size === 0) return [];
	let after: RegistryRowView[];
	try {
		after = session.modelRegistry.getAll() as unknown as RegistryRowView[];
	} catch {
		return [...claimed.keys()];
	}
	const lost: string[] = [];
	for (const [provider, before] of claimed) {
		const ids = new Set(before.map((r) => r.id));
		for (const row of after) {
			if (row.provider === provider && ids.has(row.id)) ids.delete(row.id);
		}
		if (ids.size > 0) lost.push(provider);
	}
	return lost;
}

export interface HostLlmState {
	enabled: boolean;
	denied: number;
}

export function hostLlmState(): HostLlmState {
	return { enabled: armed === null, denied: denies };
}

/**
 * The switch behind `POST /host-llm`. `enabled: false` arms the deny on the
 * live Main session (throwing if there is none or if arming is refused);
 * `enabled: true` restores. Returns the state *after* the call, so a repeated
 * `enabled: true` reads back `enabled: true` rather than erroring.
 */
export function setEnabled(enabled: boolean): HostLlmState {
	if (enabled) {
		restoreTakeover();
	} else {
		const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
		if (!session) throw new Error("main session not available");
		applyTakeover(session);
	}
	return hostLlmState();
}

/**
 * Re-arm the live Main session whenever the switch is on. A rebuilt Main
 * session (revive, ACP, task runner) carries a fresh model registry that nothing
 * has denied, and a shared one can have had the shadow pruned by the host's own
 * extension-source reconciliation — so this runs on every `session_start` while
 * armed, not only when the startup config says deny. No-ops without a live Main;
 * throws on a refusal (a lane nothing here can cover).
 */
export function rearmMainSession(): void {
	const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	if (!session) return;
	applyTakeover(session);
}
