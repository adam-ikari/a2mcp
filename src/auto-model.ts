/**
 * The placeholder model for hosts that have no model configuration at all.
 *
 * A brand-new machine — the one `scripts/bootstrap.*` exists for — has an omp
 * that can open a session but no model in it: the host gates every prompt on
 * `session.model` (`agent-session.ts`, "No model selected. Use /login, set an
 * API key environment variable, or create …agent.db"). The bridge itself is
 * unaffected — the endpoint binds at `session_start` and answers MCP regardless
 * — but the operator at the keyboard cannot type anything without hitting that
 * error, and people read it as "the install failed".
 *
 * So when a `session_start` finds the Main session with no model, this module
 * registers one provider row and selects it: `a2mcp/offline`, an
 * `anthropic-messages` endpoint at `a2mcp.invalid` (the RFC 6761 reserved
 * TLD — it can never resolve, so no byte leaves the machine and no local port
 * joins the deny tripwire's refuse-list, which a `127.0.0.1` baseUrl would).
 * The prompt that follows fails as a DNS/connection error instead of a
 * configuration lecture — which is the honest outcome on a machine with no
 * credentials, and the same shape every probe in this repo has been booting
 * with for weeks.
 *
 * Two rules keep this from becoming a second opinion about the host:
 *
 * - **It only fills an empty slot.** If `session.model` exists — the operator
 *   ran `/login`, or `models.yml` resolved a default — nothing here runs at
 *   all: no registration, no `setModel`. The user's choice is never touched,
 *   not even to "improve" it.
 * - **It is runtime state, never a config write.** The registration lives in
 *   the process model registry and the selection lives on the session object;
 *   `agent.db` and settings are not opened. The host's extension-source
 *   reconciliation may prune the row when a session is rebuilt, so the check
 *   replays on every `session_start` — the same pattern `rearmMainSession`
 *   uses for the deny shadow, for the same reason.
 *
 * The sourceId is deliberately not `TAKEOVER_SOURCE`: restoring a deny takeover
 * clears registrations under `"a2mcp"`, and the placeholder must not be
 * collateral when somebody un-dens a host that has no other model.
 */
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent";

export const PLACEHOLDER_PROVIDER = "a2mcp";
export const PLACEHOLDER_MODEL_ID = "offline";
export const PLACEHOLDER_API = "anthropic-messages";
export const PLACEHOLDER_BASE_URL = "http://a2mcp.invalid/v1";
export const PLACEHOLDER_API_KEY = "not-a-real-key";
export const AUTO_MODEL_SOURCE = "a2mcp-auto-model";

/** The slice of a live session this module touches — everything else stays unobserved. */
export interface PlaceholderSession {
	model?: unknown;
	readonly modelRegistry: {
		registerProvider(name: string, config: unknown, sourceId?: string): void;
		getAll(): readonly unknown[];
	};
	readonly agent: {
		setModel(model: unknown): unknown;
	};
}

function findRow(session: PlaceholderSession): Record<string, unknown> | undefined {
	return (session.modelRegistry.getAll() as readonly Record<string, unknown>[]).find(
		(r) => r.provider === PLACEHOLDER_PROVIDER && r.id === PLACEHOLDER_MODEL_ID,
	);
}

/**
 * Fill the session's empty model slot with the unreachable placeholder.
 * Returns `false` when there was nothing to fill (a model is already selected)
 * and `true` when this call put the placeholder on the session. Throws when the
 * registry accepted the provider but no matching row came back — an outcome
 * nothing here can name, and silently `false` would claim "the host has a
 * model decision already" for a session that has none.
 */
export function ensurePlaceholderModel(session: PlaceholderSession): boolean {
	if (session.model) return false;
	if (!findRow(session)) {
		session.modelRegistry.registerProvider(
			PLACEHOLDER_PROVIDER,
			{
				baseUrl: PLACEHOLDER_BASE_URL,
				apiKey: PLACEHOLDER_API_KEY,
				api: PLACEHOLDER_API,
				models: [{ id: PLACEHOLDER_MODEL_ID, name: "a2mcp placeholder (unreachable)", contextWindow: 100000 }],
			},
			AUTO_MODEL_SOURCE,
		);
	}
	const row = findRow(session);
	if (!row) throw new Error(`model registry accepted no ${PLACEHOLDER_PROVIDER}/${PLACEHOLDER_MODEL_ID} row`);
	session.agent.setModel(row);
	return true;
}

/**
 * The Main-session entry point used by `session_start`. No Main session, nothing
 * to do — the bridge never creates one.
 */
export function ensurePlaceholderOnMainSession(): boolean {
	const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	if (!session) return false;
	return ensurePlaceholderModel(session as unknown as PlaceholderSession);
}
