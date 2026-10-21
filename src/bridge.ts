import { randomUUID } from "node:crypto";
import {
	AgentRegistry,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	MAIN_AGENT_ID,
} from "@oh-my-pi/pi-coding-agent";
// `toolWireSchema` is pi-ai's, taken through pi-coding-agent's own explicitly
// exported shim subpath rather than from `@oh-my-pi/pi-ai` directly: a packaged
// install is a copy with no `node_modules`, so every host specifier is resolved by
// the host's shim, and the fewer packages that shim has to resolve the better.
// `TSchema` is type-only, so it erases at runtime and cannot break an install — it
// is imported from the same place anyway so there is one line to check.
// See the long note in src/takeover.ts for the install failure this avoids.
import type { TSchema } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
import { toolWireSchema } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-ai-shim";
// Loads pi-coding-agent's AgentToolContext augmentation (CustomToolContext
// fields + ui/hasUI) so the execute() context literal is fully type-checked
// instead of relying on the all-optional base declaration.
import type {} from "@oh-my-pi/pi-coding-agent/tools/context";
import { auditDone, auditStart } from "./audit.ts";
import type { McpContent, McpTool } from "./server.ts";

/** Convert a ToolInfo schema to JSON Schema; fall back to raw parameters. */
function toInputSchema(parameters: TSchema): Record<string, unknown> {
	try {
		// toolWireSchema reads only `.parameters`; name/description are unused
		// filler because the pi-ai Tool type requires them.
		return toolWireSchema({ name: "", description: "", parameters });
	} catch {
		return (parameters ?? { type: "object" }) as Record<string, unknown>;
	}
}

/**
 * The tool set the bridge serves.
 *
 * `tools/list`, the exposure gate and `tools/call` have to answer out of one
 * registry, or the bridge advertises names it refuses and refuses names it
 * advertised. That registry is the Main session's own — `runHost` resolves names
 * against it per call, and the host wires `pi.getAllTools()` to the runner's own
 * session (`runtime-init.ts:126`), which is only the same thing while the pinned
 * runner *is* Main's.
 *
 * The fallback is for the window where `AgentRef.session` is `null` (parked or
 * aborted): the port goes at the `session_shutdown` that follows, but not
 * instantaneously, and an empty catalog there would report a registry the host
 * still has.
 */
function servedTools(pi: ExtensionAPI) {
	const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	return session?.getAllToolInfos() ?? pi.getAllTools();
}

/**
 * Build the tools/list catalog: the host session's registry, verbatim.
 *
 * No filtering. `servedTools` is the whole registered set, including `hidden`
 * tools and tools the host currently has disabled for its own model — the bridge
 * does not second-guess that. Execution goes through the host's own
 * tools (see buildCallTool), so the host's permission model decides what
 * actually happens to a call.
 *
 * Re-fetched on every call so dynamic tools show up; schema conversion is cached
 * per `parameters` object identity (WeakMap), so a tool that re-registers with a
 * new schema object is re-converted instead of serving a stale cached schema.
 */
export function buildToolCatalog(pi: ExtensionAPI): () => Promise<McpTool[]> {
	const schemaCache = new WeakMap<object, Record<string, unknown>>();
	return async () => {
		const out: McpTool[] = [];
		for (const t of servedTools(pi)) {
			const params = t.parameters;
			const key = typeof params === "object" && params !== null ? params : null;
			let inputSchema = key ? schemaCache.get(key) : undefined;
			if (inputSchema === undefined) {
				inputSchema = toInputSchema(params);
				if (key) schemaCache.set(key, inputSchema);
			}
			out.push({ name: t.name, description: t.description ?? "", inputSchema });
		}
		return out;
	};
}

type RenderEvent = Parameters<AgentSession["agent"]["emitExternalEvent"]>[0];

/**
 * Whether the host still has a Main session for the bridge to serve. The host's
 * registry is the only authority on that, and it is also what tells one session's
 * shutdown from another's: the `ExtensionContext` handed to a handler is rebuilt on
 * every emit, so it carries no usable identity.
 *
 * `null` is the host's own sentinel for a parked or aborted Main (`AgentRef.session`
 * is `AgentSession | null`), so the reading has to reject it, not just a missing slot —
 * otherwise this says "serve it" while `buildCallTool` answers "main session not
 * available" for the same registry state.
 */
export function hasMainSession(): boolean {
	return AgentRegistry.global().get(MAIN_AGENT_ID)?.session != null;
}

/**
 * Mirror a tool event into the host's bus so the controlled TUI renders each remote
 * call exactly like a local one (same card, same lifecycle). Unlike `message_end`
 * these never touch the message stream, so a remote call cannot perturb the LLM
 * context.
 *
 * The event is built lazily and its failure is dropped, because these calls sit on
 * the path that decides a call's outcome. A host that refuses one used to: stop the
 * call before the tool ran, report a call that *had* run (side effects and all) as a
 * failure, or on the error path replace the tool's own message with the refusal.
 * Rendering is not entitled to any of that.
 */
function emitRenderEvent(agent: AgentSession["agent"], make: () => RenderEvent): void {
	try {
		agent.emitExternalEvent(make());
	} catch {
		// cosmetic only — see above
	}
}

/**
 * The failure's own text for the audit record, with the token taken out of it.
 *
 * The outcome of a remote call exists nowhere else — the host's transcript keeps
 * the arguments and never the result — so this is the only place a failure's
 * reason can live. The reason is whatever the tool said, and a tool's message can
 * be anything: a shell that chokes on a command line echoes that command line,
 * and a command line can carry the token the caller used to reach the bridge. The
 * token never enters a record (the bridge holds it in the `Authorization` header
 * and does not log it), so it is cut out here rather than trusted not to appear.
 *
 * The cut is on the current token, so a rotated one is no longer covered — the
 * old value stops being valid at the rotation, and the operator who rotates it is
 * the one who knows it.
 */
function failureText(r: { content: McpContent[]; isError: boolean }, token: string): string | null {
	if (!r.isError) return null;
	const text = r.content.find((b) => b?.type === "text")?.text;
	if (!text) return null;
	const secret = token.trim();
	return secret.length > 0 ? text.split(secret).join("<token>") : text;
}

/** One call's identity and its policy, carried down to the host hand-off. */
interface Call {
	/** The bridge's id for this call: the audit pair's key and the host's toolCallId. */
	id: string;
	/** Incognito: leave no record of this call anywhere. */
	quiet: boolean;
}

/**
 * Build the tools/call executor: resolve the name against the same registry
 * tools/list advertises, then hand it to the host's tool implementation.
 *
 * Nothing outside the registry is reachable, so aliases (e.g. `xd://bash`) and
 * names that are not registered are rejected. Host execution resolves through
 * the live Main session so the host's built-in approval gate
 * (ExtensionToolWrapper) governs write/exec calls; rejections surface as
 * isError results.
 *
 * `token` is a getter rather than a value: the operator can rotate the token at
 * runtime, and a captured copy would keep scrubbing a credential that stopped
 * being one. `incognito` is a getter for the same reason — it is a switch the
 * operator flips while the bridge is running.
 */
export function buildCallTool(
	pi: ExtensionAPI,
	extCtx: ExtensionContext,
	token: () => string,
	incognito: () => boolean,
): (name: string, args: unknown, sid?: string | null) => Promise<{ content: McpContent[]; isError: boolean }> {
	const runHost = async (
		name: string,
		args: unknown,
		call: Call,
	): Promise<{ content: McpContent[]; isError: boolean }> => {
		const ref = AgentRegistry.global().get(MAIN_AGENT_ID);
		if (!ref?.session) {
			return { content: [{ type: "text", text: "main session not available" }], isError: true };
		}
		const session = ref.session;
		const tool = session.getToolByName(name);
		if (!tool) {
			return { content: [{ type: "text", text: `unknown tool '${name}'` }], isError: true };
		}
		const ctx = {
			sessionManager: session.sessionManager,
			modelRegistry: session.modelRegistry,
			model: session.model,
			settings: session.settings,
			isIdle: extCtx.isIdle,
			abort: extCtx.abort,
			hasQueuedMessages: extCtx.hasPendingMessages,
			ui: extCtx.ui,
			hasUI: extCtx.hasUI,
			localProtocolOptions: extCtx.localProtocolOptions,
		};
		// Mirror the host's own tool events (see emitRenderEvent for why a failure
		// here is dropped). The id is the one the dispatcher minted for this call, so
		// the host's transcript records it under the same name the audit log does.
		//
		// Not in incognito mode — and that is the half that matters. These events
		// are what the host's session transcript is written from, so emitting them
		// would leave the caller's command on the host's disk in a file the bridge
		// does not control, and the call would still be there after the audit log
		// was wiped.
		if (!call.quiet) {
			emitRenderEvent(session.agent, () => ({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: name,
				args,
			}));
		}
		let r: Awaited<ReturnType<typeof tool.execute>>;
		try {
			r = await tool.execute(call.id, args, undefined, undefined, ctx);
		} catch (e) {
			// A throw out of execute() has no structured result to carry, so the
			// host's error text becomes the content, as the host's own loop does it.
			r = { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], isError: true };
		}
		if (!call.quiet) {
			emitRenderEvent(session.agent, () => ({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: name,
				result: r,
				isError: !!r.isError,
			}));
		}
		const content = (r.content ?? []).map((b) =>
			b?.type === "text"
				? { type: "text" as const, text: b.text }
				: b?.type === "image"
					? { type: "image" as const, data: b.data, mimeType: b.mimeType }
					: { type: "text" as const, text: JSON.stringify(b) },
		);
		return { content, isError: !!r.isError };
	};

	const run = async (name: string, args: unknown, call: Call): Promise<{ content: McpContent[]; isError: boolean }> => {
		// One message for "not registered" and "not in catalog": a caller holding
		// the token learns nothing about which names exist behind the curtain.
		// Same registry as the catalog, so a name the caller read in `tools/list` is a
		// name this can act on.
		if (!servedTools(pi).some((t) => t.name === name)) {
			return { content: [{ type: "text", text: `tool '${name}' is not exposed by this bridge` }], isError: true };
		}
		return runHost(name, args, call);
	};

	return async (name, args, sid) => {
		// One id for the whole call, used twice: it pairs the two audit records, and
		// it is the id the host's own session transcript records the call under.
		//
		// The two records are halves of one thing. The transcript keeps the full
		// arguments and never the outcome — it has no `tool_execution_end` and no
		// `isError` for a remote call. The audit log keeps the outcome and the remote
		// attribution but folds long arguments to `<len,sha256>`. So an operator
		// asking "what did the remote client run, and did it work" needs both, and
		// they used to be unjoinable: two UUIDs were minted for the same call — this
		// one for the audit pair, another for the host — so the only way to pair
		// them was a timestamp guess, and a guess across a busy host is a guess.
		// One id makes the join a lookup: the id in the audit line is the
		// `toolCallId` the host wrote the call under, under `<agentDir>/sessions/`.
		const id = randomUUID();
		// Incognito: the call leaves no trace. Not the audit pair, and not the
		// host's render event either — that event is what the host's session
		// transcript is written from, so the command would sit on the host's disk in
		// a file the bridge does not control, and the call would still be readable
		// there after the audit log was wiped.
		//
		// The switch is the operator's, not the caller's: a caller who could
		// silence its own record would leave the log worthless as evidence, which is
		// the one thing the log is for. The operator's own transitions are recorded
		// (src/audit.ts, `auditIncognito`), so a silent stretch in the log says why.
		const call: Call = { id, quiet: incognito() };
		// Dispatch-time record: if the call never settles (host approval
		// waiting for a UI that does not exist), the start line is the trace.
		// Awaited, so "the start is on disk" is true before the call runs rather
		// than racing it — that ordering is what makes the line evidence of
		// anything rather than a record of a request that once happened.
		if (!call.quiet) await auditStart(id, sid ?? null, name, args);
		let r: { content: McpContent[]; isError: boolean };
		try {
			r = await run(name, args, call);
		} catch (e) {
			r = { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], isError: true };
		}
		// Awaited before the reply: a caller that reads the audit log right after
		// its 200 has to find its own call in it.
		if (!call.quiet) await auditDone(id, sid ?? null, name, args, r.isError, failureText(r, token()));
		return r;
	};
}
