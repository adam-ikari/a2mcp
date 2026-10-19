import { describe, expect, test } from "bun:test";
import {
	AUTO_MODEL_SOURCE,
	ensurePlaceholderModel,
	PLACEHOLDER_API_KEY,
	PLACEHOLDER_BASE_URL,
	type PlaceholderSession,
} from "../src/auto-model.ts";
import { TAKEOVER_SOURCE } from "../src/takeover.ts";

interface FakeSession extends PlaceholderSession {
	model?: unknown;
	registrations: Array<{ name: string; config: Record<string, unknown>; sourceId?: string }>;
	setModels: unknown[];
	rows: Record<string, unknown>[];
}

function fakeSession(opts: { model?: unknown; rows?: Record<string, unknown>[] }): FakeSession {
	const s: FakeSession = {
		model: opts.model,
		registrations: [],
		setModels: [],
		rows: opts.rows ?? [],
		modelRegistry: {
			registerProvider: (name, config, sourceId) => {
				s.registrations.push({ name, config: config as Record<string, unknown>, sourceId });
				// mirror the registry: the row becomes findable after registration
				const models = (config as { models?: Array<Record<string, unknown>> }).models ?? [];
				for (const m of models)
					s.rows.push({ ...m, provider: name, baseUrl: (config as { baseUrl?: string }).baseUrl });
			},
			getAll: () => s.rows,
		},
		agent: {
			setModel: (m) => {
				s.setModels.push(m);
				s.model = m;
				return undefined;
			},
		},
	};
	if (opts.model !== undefined) s.model = opts.model;
	return s;
}

describe("placeholder model for unconfigured hosts", () => {
	test("a session that already has a model is not touched at all", () => {
		const s = fakeSession({ model: { provider: "anthropic", id: "claude-x" } });
		expect(ensurePlaceholderModel(s)).toBe(false);
		expect(s.registrations.length).toBe(0);
		expect(s.setModels.length).toBe(0);
	});

	test("an empty slot gets exactly one registration and one setModel", () => {
		const s = fakeSession({});
		expect(ensurePlaceholderModel(s)).toBe(true);
		expect(s.registrations.length).toBe(1);
		expect(s.setModels.length).toBe(1);
	});

	test("the registered row is unreachable by name, not by guesswork", () => {
		const s = fakeSession({});
		ensurePlaceholderModel(s);
		const reg = s.registrations[0];
		expect(reg.name).toBe("a2mcp");
		expect(reg.config.baseUrl).toBe(PLACEHOLDER_BASE_URL);
		// the reserved .invalid TLD: nothing under it can ever resolve, and a
		// loopback baseUrl would put 127.0.0.1 into the deny tripwire's key set
		expect(String(reg.config.baseUrl)).toContain(".invalid");
		expect(String(reg.config.baseUrl)).not.toContain("127.0.0.1");
		expect(reg.config.api).toBe("anthropic-messages");
		expect(reg.config.apiKey).toBe(PLACEHOLDER_API_KEY);
		const models = reg.config.models as Array<Record<string, unknown>>;
		expect(models[0].id).toBe("offline");
		expect(typeof models[0].contextWindow).toBe("number");
	});

	test("the sourceId is not the takeover source — restore must not sweep this row", () => {
		const s = fakeSession({});
		ensurePlaceholderModel(s);
		expect(s.registrations[0].sourceId).toBe(AUTO_MODEL_SOURCE);
		expect(s.registrations[0].sourceId).not.toBe(TAKEOVER_SOURCE);
	});

	test("the model put on the session is the registry's own row", () => {
		const s = fakeSession({});
		ensurePlaceholderModel(s);
		const set = s.setModels[0] as Record<string, unknown>;
		expect(set.provider).toBe("a2mcp");
		expect(set.id).toBe("offline");
		expect(s.model).toBe(set);
	});

	test("a pruned row is re-registered on the next session_start, an intact one is not", () => {
		const s = fakeSession({});
		expect(ensurePlaceholderModel(s)).toBe(true);
		// rebuilt session, model cleared, row pruned by the host's reconciliation
		s.model = undefined;
		s.rows = [];
		expect(ensurePlaceholderModel(s)).toBe(true);
		expect(s.registrations.length).toBe(2);
		// same session again with the placeholder still selected: zero new calls
		expect(ensurePlaceholderModel(s)).toBe(false);
		expect(s.registrations.length).toBe(2);
	});

	test("a registry that accepts the provider but yields no row throws instead of pretending", () => {
		const s = fakeSession({});
		s.modelRegistry.registerProvider = () => {};
		expect(() => ensurePlaceholderModel(s)).toThrow(/accepted no a2mcp\/offline row/);
		expect(s.setModels.length).toBe(0);
	});

	test("an existing placeholder row without a session model is selected, not re-registered", () => {
		const s = fakeSession({ rows: [{ provider: "a2mcp", id: "offline", baseUrl: PLACEHOLDER_BASE_URL }] });
		expect(ensurePlaceholderModel(s)).toBe(true);
		expect(s.registrations.length).toBe(0);
		expect(s.setModels.length).toBe(1);
	});
});
