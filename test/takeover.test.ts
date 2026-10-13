/**
 * Takeover at the layer that does not need a live host: the deny-overlay shape,
 * the tripwire key set, the sentinel's classification, and the switch guards in
 * `setEnabled`. The behavior these pin — a shadowed registry actually stopping
 * a host turn — is the 7th host probe's job (`test/takeover-probe.ts`); what
 * lives here is the part that is wrong before a host is even involved: a
 * mis-grouped overlay, a key set that misses a configured endpoint, a sentinel
 * text that a retry classifier would eat.
 */
import { describe, expect, test } from "bun:test";
import { retriable } from "@oh-my-pi/pi-ai/error";
import { classify, isOAuthExpiry, TRANSIENT_TRANSPORT_PATTERN } from "@oh-my-pi/pi-ai/error/flags";
import {
	buildDenyModel,
	buildDenyOverlays,
	DENY_API,
	hostLlmState,
	nonFetchLane,
	type RegistryRowView,
	SENTINEL,
	setEnabled,
	shadowedProviders,
	tripwireKeys,
	uncoveredLane,
} from "../src/takeover.ts";

function row(over: Partial<RegistryRowView> & { provider: string; id: string }): RegistryRowView {
	return {
		name: over.id,
		api: "anthropic-messages",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15 },
		contextWindow: 200000,
		maxTokens: 8192,
		...over,
	};
}

describe("uncoveredLane", () => {
	const plain = [
		row({ provider: "anthropic", id: "claude-x", baseUrl: "https://api.anthropic.com" }),
		row({ provider: "openai", id: "gpt-z", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }),
	];
	const nothingClaimed = new Set<string>();

	test("an ordinary catalog has no uncovered lane", () => {
		expect(uncoveredLane(plain, nothingClaimed)).toBeNull();
	});

	test("a pi-native row on an unclaimed provider is refused, and the refusal names the model and why", () => {
		// pi-ai dispatches on model.transport BEFORE the custom-api check, so a deny
		// row carrying one would be sent to the gateway instead of refused.
		const lane = uncoveredLane(
			[...plain, row({ provider: "custom", id: "native-thing", transport: "pi-native" })],
			nothingClaimed,
		);
		expect(lane?.row.provider).toBe("custom");
		expect(lane?.reason).toMatch(/pi-native/);
		expect(lane?.reason).toMatch(/before any api/);
	});

	test("any transport is refused, not just the one the host has today", () => {
		// The rule is the shape, not the string: a transport this version never sets
		// would short-circuit just the same.
		const lane = uncoveredLane([row({ provider: "p", id: "m", transport: "carrier-pigeon" })], nothingClaimed);
		expect(lane?.reason).toMatch(/carrier-pigeon/);
	});

	test("the same transport on a claimed provider is covered, not refused", () => {
		// A claimed provider's rows are replaced wholesale by overlays that carry no
		// transport at all, so there is nothing left to short-circuit.
		expect(uncoveredLane([row({ provider: "p", id: "m", transport: "pi-native" })], new Set(["p"]))).toBeNull();
	});
});

describe("nonFetchLane", () => {
	test("names the two lanes the tripwire cannot see", () => {
		expect(nonFetchLane(row({ provider: "anthropic", id: "c", api: "anthropic-messages" }))).toBe("cowork");
		expect(nonFetchLane(row({ provider: "openai-codex", id: "gpt", api: "openai-codex-responses" }))).toBe("websocket");
		expect(nonFetchLane(row({ provider: "openai", id: "gpt", api: "openai-responses" }))).toBeNull();
	});

	test("the websocket lane is keyed on the api, not on a row's flag", () => {
		// The host forwards `providers.openaiWebsockets` on every provider call, so a
		// setting can put ANY codex row on the socket. A row-level check would have
		// covered only the one row that ships with the flag.
		expect(nonFetchLane(row({ provider: "openai-codex", id: "plain", api: "openai-codex-responses" }))).toBe(
			"websocket",
		);
	});
});

describe("shadowedProviders", () => {
	test("claims the cowork lane's provider and nothing else", () => {
		// pi-ai picks cowworkFetch (node:https) by provider + api; every other lane
		// reads globalThis.fetch at call time, which the tripwire already wraps.
		const claimed = shadowedProviders([
			row({ provider: "anthropic", id: "claude-x", api: "anthropic-messages" }),
			row({ provider: "anthropic", id: "claude-local", api: "openai-completions" }),
			row({ provider: "openai", id: "gpt-z", api: "openai-responses" }),
		]);
		expect([...claimed.keys()]).toEqual(["anthropic"]);
		// The provider's WHOLE row set, not just the row that motivated the claim:
		// registering a subset would drop the others out of the catalog while armed.
		expect(
			claimed
				.get("anthropic")
				?.map((r) => r.id)
				.sort(),
		).toEqual(["claude-local", "claude-x"]);
	});

	test("a provider with no non-fetch row is left entirely to the tripwire", () => {
		// Claiming it would take a name the bridge has no reason to own, which is the
		// whole point of the narrow table.
		const claimed = shadowedProviders([
			row({ provider: "anthropic", id: "claude-local", api: "openai-completions" }),
			row({ provider: "openai", id: "gpt-z", api: "openai-responses" }),
		]);
		expect(claimed.size).toBe(0);
	});

	test("the websocket lane's provider is claimed too", () => {
		const claimed = shadowedProviders([
			row({ provider: "openai-codex", id: "gpt-codex", api: "openai-codex-responses" }),
			row({ provider: "openai", id: "gpt-z", api: "openai-responses" }),
		]);
		expect([...claimed.keys()]).toEqual(["openai-codex"]);
	});

	test("every claimed row survives into the overlay, counts conserved", () => {
		const rows = [
			row({ provider: "anthropic", id: "claude-x", api: "anthropic-messages" }),
			row({ provider: "anthropic", id: "claude-y", api: "anthropic-messages", reasoning: true }),
		];
		const claimed = shadowedProviders(rows);
		const overlays = buildDenyOverlays([...claimed.values()].flat());
		expect([...(overlays.get("anthropic")?.models.map((m) => m.id) ?? [])].sort()).toEqual(["claude-x", "claude-y"]);
	});
});

describe("buildDenyModel", () => {
	test("keeps the row's identity and swaps the two fields that route a request", () => {
		const row = {
			provider: "anthropic",
			id: "claude-x",
			name: "Claude X",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			contextWindow: 200000,
			maxTokens: 8192,
			input: ["text", "image"],
		};
		const deny = buildDenyModel(row);
		expect(deny).toMatchObject({
			provider: "anthropic",
			id: "claude-x",
			name: "Claude X",
			contextWindow: 200000,
			maxTokens: 8192,
			input: ["text", "image"],
			api: DENY_API,
			baseUrl: "http://127.0.0.1:9",
		});
	});

	test("drops the credential resolvers", () => {
		// pi-ai resolves model.resolveHeaders BEFORE the custom-api check, so leaving
		// them on would make a denied turn run the provider's `!command` key program to
		// mint a key the request never uses.
		const deny = buildDenyModel({
			provider: "p",
			id: "m",
			api: "anthropic-messages",
			headers: { "x-api-key": "literal" },
			resolveHeaders: () => Promise.resolve({ authorization: "Bearer secret" }),
		});
		expect(deny).not.toHaveProperty("headers");
		expect(deny).not.toHaveProperty("resolveHeaders");
	});
});

describe("buildDenyOverlays", () => {
	const rows = [
		row({ provider: "anthropic", id: "claude-x", baseUrl: "https://api.anthropic.com" }),
		row({ provider: "anthropic", id: "claude-y", reasoning: true }),
		row({ provider: "openai", id: "gpt-z", baseUrl: "http://127.0.0.1:8080/v1" }),
	];

	test("every provider gets an overlay and every row survives it", () => {
		const overlays = buildDenyOverlays(rows);
		expect([...overlays.keys()].sort()).toEqual(["anthropic", "openai"]);
		expect(
			overlays
				.get("anthropic")
				?.models.map((m) => m.id)
				.sort(),
		).toEqual(["claude-x", "claude-y"]);
		// Count conservation across the whole snapshot: nothing silently dropped.
		expect([...overlays.values()].reduce((n, o) => n + o.models.length, 0)).toBe(rows.length);
	});

	test("shadowed rows carry the deny api and the per-row facts that survive a swap", () => {
		const overlays = buildDenyOverlays(rows);
		for (const overlay of overlays.values()) {
			expect(overlay.api).toBe(DENY_API);
			expect(overlay.baseUrl).toBe("http://127.0.0.1:9");
			expect(overlay.apiKey).toBe("denied");
			for (const m of overlay.models) expect(m.api).toBe(DENY_API);
		}
		// The per-row facts the host's own loop reads must come through unchanged.
		const anthropic = overlays.get("anthropic")?.models ?? [];
		expect(anthropic.find((m) => m.id === "claude-y")?.reasoning).toBe(true);
		expect(anthropic.find((m) => m.id === "claude-x")?.name).toBe("claude-x");
		expect(anthropic.find((m) => m.id === "claude-x")?.contextWindow).toBe(200000);
		expect(anthropic.find((m) => m.id === "claude-x")?.maxTokens).toBe(8192);
		expect(anthropic.find((m) => m.id === "claude-x")?.input).toEqual(["text"]);
	});

	test("the deny api name does not collide with a built-in dispatch name", () => {
		// Names pi-ai dispatches on before any extension-registered api is consulted.
		// A collision would let real requests flow through the shadow.
		const builtins = [
			"anthropic-messages",
			"openai-completions",
			"openai-responses",
			"google-generative-ai",
			"bedrock-converse",
			"pi-native",
		];
		expect(builtins).not.toContain(DENY_API);
	});
});

describe("tripwireKeys", () => {
	test("collects host and hostname of every URL-shaped baseUrl", () => {
		const keys = tripwireKeys([
			row({ provider: "a", id: "m1", baseUrl: "https://api.anthropic.com/v1" }),
			row({ provider: "b", id: "m2", baseUrl: "http://127.0.0.1:8080/p" }),
		]);
		expect(keys.has("api.anthropic.com")).toBe(true);
		expect(keys.has("127.0.0.1:8080")).toBe(true);
		expect(keys.has("127.0.0.1")).toBe(true);
	});

	test("non-URL and missing baseUrls contribute nothing", () => {
		const keys = tripwireKeys([
			row({ provider: "a", id: "m1", baseUrl: "not a url" }),
			row({ provider: "b", id: "m2" }),
		]);
		expect(keys.size).toBe(0);
	});
});

describe("the sentinel error", () => {
	test("classifies as nothing and does not read as retriable", () => {
		const err = new Error(SENTINEL);
		expect(classify(err)).toBe(0);
		expect(retriable(classify(err))).toBe(false);
	});

	test("dodges the retry-trigger text patterns it would otherwise feed", () => {
		expect(TRANSIENT_TRANSPORT_PATTERN.test(SENTINEL)).toBe(false);
		expect(isOAuthExpiry(SENTINEL)).toBe(false);
		expect(SENTINEL).not.toMatch(/429|5\d\d|timeout|refused/i);
	});
});

describe("setEnabled without a host", () => {
	test("the un-armed default reports enabled", () => {
		expect(hostLlmState().enabled).toBe(true);
	});

	test("enabled:true on a never-armed bridge is an idempotent no-op, not an error", () => {
		const before = hostLlmState().denied;
		expect(setEnabled(true).enabled).toBe(true);
		expect(setEnabled(true).enabled).toBe(true);
		expect(hostLlmState().denied).toBe(before);
	});

	test("enabled:false with no live Main session throws instead of half-arming", () => {
		// The tripwire is process-global; arming without a session to snapshot
		// would deny the destination with no registry shadow and no restore path.
		expect(() => setEnabled(false)).toThrow(/main session not available/);
	});
});
