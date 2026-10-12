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
 * Two layers, because there are two kinds of callers:
 *
 * 1. **Registry shadowing.** Every provider visible in the session's
 *    `modelRegistry` is re-registered with a `a2a-deny` api whose `streamSimple`
 *    only counts and fails, and the agent's current model row is swapped to the
 *    shadowed one (`agent.setModel`, because the agent holds the `Model` object
 *    it captured). This covers anything that resolves a model through the
 *    registry — the main loop, task subagents, websearch, commit message
 *    generation.
 * 2. **A destination-keyed `globalThis.fetch` tripwire.** Some paths build
 *    their own `ModelRegistry` (task/executor, web/search, …) instead of using
 *    the session's. Every request whose URL host matches a `baseUrl` seen in
 *    the pre-shadow registry snapshot is refused there. The keys come from the
 *    registry itself, so they cover configured and built-in endpoints alike.
 *
 * Plus a noise layer: runtime setting overrides that silence the sources known
 * to wake a host on their own (auto-background, retry, ttsr, …). These do not
 * add safety — the deny streams do — they keep refused turns out of the host's
 * history.
 *
 * ## What this gives up, and what it refuses
 *
 * The deny fails a model request with a fixed sentinel error, classified
 * non-retriable (a retry loop would spend the host's clock even if not its
 * API). The turn that was interrupted still ends with an error message in the
 * host's session history: arming does not un-start turns, it stops them.
 *
 * A model row configured with `transport: "pi-native"` dispatches before any
 * extension-registered api (pi-ai `stream.ts` checks the transport first), so
 * the shadow would silently not cover it. Takeover then **refuses to arm** and
 * says why — it will not promise a zero it cannot deliver.
 *
 * Residuals, listed honestly: the cowork-fetch, websocket, and explicit
 * `fetchImpl` lanes bypass `globalThis.fetch` and are covered by layer 1 only
 * (their provider rows must be in the snapshot); a provider added to
 * models.yml after arming is not shadowed until the next re-arm; non-inference
 * egress (update checks, telemetry) is deliberately *not* blocked — the
 * tripwire keys on inference endpoints only.
 *
 * ## Lifecycle
 *
 * Arming is runtime state on the live Main session; it is never written to the
 * config. The config (`host_llm: "deny"`) only decides the *startup* state: a
 * restart returns the host to what the operator last wrote, and each
 * `session_start` re-arms a rebuilt session when the startup state is deny.
 */

import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AgentRegistry, type AgentSession, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

/** Source id handed to `registerProvider`/`clearSourceRegistrations` for all of this. */
export const TAKEOVER_SOURCE = "a2a-bridge";
/** The fake api name every shadowed row carries; dispatch enters `denyStreamSimple` through it. */
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

/**
 * Group rows by provider and produce the shadowing registration for each.
 * Pure, and it throws before touching anything: a `pi-native` row anywhere in
 * the snapshot means the deny could not honestly cover the host, so arming is
 * refused rather than half-promised.
 */
export function buildDenyOverlays(rows: readonly RegistryRowView[]): Map<string, DenyOverlay> {
	const native = rows.find((r) => r.transport === "pi-native");
	if (native) {
		throw new Error(
			`cannot arm takeover: model ${native.provider}/${native.id} uses pi-native transport, which this bridge cannot intercept`,
		);
	}
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
 * The destinations the tripwire refuses: every `host` and `hostname` appearing
 * as a row `baseUrl` in the (pre-shadow) snapshot. Both forms because a
 * request URL may carry an explicit default port the configured baseUrl does
 * not. Non-URL baseUrls contribute nothing — there is no destination to match.
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
	prevFetch: Fetch;
	overriddenIds: string[];
	prevModel: { provider: string; id: string } | null;
}

let armed: Armed | null = null;

/**
 * Shadow the session's model registry, arm the tripwire, silence the noise
 * sources. Idempotent per session; arming a new session while an old one is
 * still snapshot-armed restores the old first (its session may already be dead,
 * which is why restore tolerates that). Throws if the snapshot contains a
 * `pi-native` row — before mutating anything.
 */
export function applyTakeover(session: AgentSession): void {
	if (armed?.session === session) return;
	if (armed) restoreTakeover();

	const reg = session.modelRegistry;
	const rows = reg.getAll() as unknown as RegistryRowView[];
	const overlays = buildDenyOverlays(rows);
	const keys = tripwireKeys(rows);
	const cur = session.model;

	for (const [provider, overlay] of overlays) {
		reg.registerProvider(
			provider,
			{
				...overlay,
				api: overlay.api as never,
				streamSimple: denyStreamSimple as never,
				models: overlay.models.map((m) => ({
					...m,
					api: m.api as never,
				})),
			} as never,
			TAKEOVER_SOURCE,
		);
	}
	let pushed = "none";
	if (cur) {
		// The agent holds the Model object it captured, not a lookup: pushing the
		// shadowed row is what routes the main loop's *next* request through deny.
		const swapped = reg.find(cur.provider, cur.id);
		if (swapped) {
			session.agent.setModel(swapped as never);
			pushed = `${cur.provider}/${cur.id}`;
		} else pushed = "find-miss";
	}

	const overriddenIds: string[] = [];
	for (const id of NOISE_IDS.concat("providers.cacheWarming", "compaction.enabled")) {
		const setting = lookup(id);
		if (!setting) continue;
		setting.override(session.settings as never, (id === "providers.cacheWarming" ? "off" : false) as never);
		overriddenIds.push(id);
	}

	const prevFetch = globalThis.fetch;
	globalThis.fetch = makeTripwire(prevFetch, keys);

	armed = { session, prevFetch, overriddenIds, prevModel: cur ? { provider: cur.provider, id: cur.id } : null };
	console.error(
		`[a2a-bridge] takeover armed: ${overlays.size} provider(s) shadowed, ${keys.size} tripwire key(s), model pushed: ${pushed}`,
	);
}

/**
 * Replay the snapshot: un-shadow the registry, push the original model row back,
 * drop the runtime overrides, remove the tripwire. No-op when not armed, so a
 * double `enabled: true` is harmless.
 */
export function restoreTakeover(): void {
	if (!armed) return;
	const { session, prevFetch, overriddenIds, prevModel } = armed;
	armed = null;
	globalThis.fetch = prevFetch;
	try {
		session.modelRegistry.clearSourceRegistrations(TAKEOVER_SOURCE);
		if (prevModel) {
			const back = session.modelRegistry.find(prevModel.provider, prevModel.id);
			if (back) session.agent.setModel(back as never);
		}
		for (const id of overriddenIds) {
			lookup(id)?.clearOverride(session.settings as never);
		}
	} catch (e) {
		// The session may have been torn down between arming and restoring; the
		// fetch reference is already back, which is the half that is process-global.
		console.error(`[a2a-bridge] takeover restore hit a dead session: ${(e as Error)?.message ?? String(e)}`);
	}
	console.error("[a2a-bridge] takeover restored: the host may issue model requests again");
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
 * Re-arm for a `session_start` while the startup config says deny: a rebuilt
 * Main session (revive, ACP, task runner) carries a fresh model registry that
 * nothing has shadowed, so the operator's startup state has to be applied to it
 * even though the endpoint never went down. No-ops without a live Main; throws
 * on a refusal (a `pi-native` row).
 */
export function rearmMainSession(): void {
	const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	if (!session) return;
	applyTakeover(session);
}
