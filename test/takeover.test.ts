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
	buildDenyOverlays,
	DENY_API,
	hostLlmState,
	type RegistryRowView,
	SENTINEL,
	setEnabled,
	tripwireKeys,
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

	test("a pi-native row refuses the whole arming before anything is produced", () => {
		const rowsWithNative = [...rows, row({ provider: "custom", id: "native-thing", transport: "pi-native" })];
		expect(() => buildDenyOverlays(rowsWithNative)).toThrow(/pi-native/);
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
