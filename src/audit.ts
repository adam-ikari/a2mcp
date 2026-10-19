import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

const MAX_LOG_BYTES = 512 * 1024;
const MAX_ARGS_CHARS = 1024;
/** Args values longer than this are payloads (base64 file bytes), not intent. */
const MAX_VALUE_CHARS = 120;

/** Audit log path: `$A2MCP_AUDIT` or `<agentDir>/a2mcp.log`. */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.A2MCP_AUDIT || join(getAgentDir(), "a2mcp.log");
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Beyond this nesting nobody is describing a tool call any more, so the subtree is
 * omitted rather than walked. It exists to bound recursion, not to allow payloads
 * at depth 33: reaching it at all means the caller sent something pathological.
 */
const MAX_REDACT_DEPTH = 32;

/**
 * Redact oversized string leaves (a file's base64 body) down to a length plus
 * a short hash: the log stays a record of *what was called*, not a copy of the
 * payload. This walks to every leaf, and that is the whole point — it used to stop
 * two levels deep on the reasoning that "that is as nested as tool args get", and
 * the host's own `edit` tool breaks it: `{path, edits: [{oldText, newText}]}` puts
 * the file body at depth 3, so up to MAX_ARGS_CHARS of it was written verbatim.
 */
function redact(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		return value.length > MAX_VALUE_CHARS ? `<len:${value.length},sha256:${digest(value)}>` : value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (depth >= MAX_REDACT_DEPTH) return "<max-depth>";
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1);
	return out;
}

function serializeArgs(args: unknown): string {
	try {
		const s = JSON.stringify(redact(args));
		if (s === undefined) return String(args);
		return s.length > MAX_ARGS_CHARS ? `${s.slice(0, MAX_ARGS_CHARS)}…` : s;
	} catch {
		return String(args).slice(0, MAX_ARGS_CHARS);
	}
}

/**
 * Appends run one at a time, per process.
 *
 * `stat` → `rename` → `appendFile` is three steps and two calls in flight together
 * both read a size over the cap. Without this chain the second rotation writes over
 * the `.1` the first one just parked the previous generation in, and what vanishes is
 * the record another call wrote milliseconds earlier, and that record is the whole
 * trace of the call it belongs to.
 *
 * The returned promise is the tail of that chain, and callers await it before they
 * answer the request. It used to be handed the line and return, fire-and-forget, and
 * that bought nothing: the chain never rejects, so there was no failure to insulate
 * a caller from — the only thing fire-and-forget bought was a response that could
 * outrun its own record. Three things were weaker for it:
 *
 *   - a caller could read the log after its 200 and not find its call in it. Two
 *     off-channel checks in test/scenario.ts read the audit file the instant the
 *     call returned, and the suite went flaky on it — twice in ten runs, two steps
 *     each, unreproducible on demand, which is what a race looks like from outside.
 *   - the crash evidence this file is designed around (a `start` line with no `done`
 *     under it, meaning "the call began and the process died mid-flight") needed the
 *     `start` to be on disk *before* the tool ran. Fire-and-forget let the tool's
 *     side effect land first, so a crash in that window left no trace at all rather
 *     than an incomplete one.
 *   - a record that lands after its own response is a weaker control than the
 *     documentation claims: the caller is told the call is on disk before it is.
 *
 * What it costs is one queued append per record: measured at ~99 µs for
 * `stat` + `appendFile` + `chmod` on this filesystem, serialized, so a request waits
 * for its own line and anything queued ahead of it. Against a call that runs a bash
 * command or reads a file, that is noise — and a slower disk delays the answer
 * rather than losing the record, which is the trade this file wants.
 *
 * The chain still never rejects (see the `.catch` below), so a failed write cannot
 * wedge the ones behind it and cannot fail the call.
 */
let queue: Promise<void> = Promise.resolve();

/** Audit appends that did not land, since the process started. See below. */
let failedWrites = 0;

/**
 * Log paths whose failure has already been announced. The line is per path,
 * because a path is the thing the operator can act on, and `$A2MCP_AUDIT`
 * means one process can be pointed at more than one: a global "only the first
 * failure ever" would let the second path fail in silence.
 */
const warnedPaths = new Set<string>();

/**
 * How many audit appends have failed since the process started. A log that cannot
 * be written looks exactly like a bridge that was never called, so the difference
 * has to be checkable — by the operator through the line `appendLine` prints, and
 * by a test through this.
 */
export function auditWriteFailures(): number {
	return failedWrites;
}

function appendLine(line: string, env?: NodeJS.ProcessEnv): Promise<void> {
	const file = auditLogPath(env);
	queue = queue
		.then(async () => {
			const s = await stat(file).catch(() => null);
			if (s && s.size + line.length > MAX_LOG_BYTES) await rename(file, `${file}.1`);
			await appendFile(file, line, { mode: 0o600 });
			// `mode` only applies at creation, so a log that already existed keeps
			// whatever it had — one restored from a backup or created by hand stays
			// world-readable for the life of the process. The config writer already
			// chmods for exactly this reason (src/config.ts); this file holds the same
			// class of evidence, so it gets the same second step. A chmod that fails
			// is swallowed rather than counted: the record landed, and `failedWrites`
			// means records that did not.
			await chmod(file, 0o600).catch(() => {});
		})
		.catch((e) => {
			// Still swallowed: a rejection per line noise-floods the host's error log,
			// and auditing must not become a way for the log to break the call
			// (test/audit.test.ts pins this). Swallowed is not silent — the bridge's own
			// safety argument is that this file is the only trace of a call, and
			// an unwritable path would hollow that out with nothing to show. So the first
			// failure on a path says so, then every hundredth failure overall, and the
			// count stays readable through `auditWriteFailures()`.
			failedWrites++;
			if (!warnedPaths.has(file) || failedWrites % 100 === 0) {
				warnedPaths.add(file);
				const why = (e as Error)?.message ?? String(e);
				console.error(`[a2mcp] audit record not written to ${file} (${why})`);
			}
		});
	// The tail of the chain, which the `.catch` above guarantees never rejects.
	// Awaiting this is how a caller knows the line has been attempted before it
	// answers — see the note on `queue`.
	return queue;
}

/**
 * Two JSONL records per remote tools/call, paired by `id`:
 *
 * - `auditStart` fires at dispatch, BEFORE the call runs, so an invocation
 *   that never settles (e.g. an approval prompt waiting for a UI that does
 *   not exist) still leaves evidence: a `start` line with no matching `done`.
 * - `auditDone` fires once the call settles and carries the outcome
 *   (`isError`).
 *
 * Both lines carry the args summary (self-contained for grep) and the
 * Mcp-Session-Id (`sid`, so a shared token's calls are attributable to a
 * client session); `id` is there for pairing, not for lookups.
 *
 * Both return the queue tail, and both callers await it: `auditStart` before the
 * call runs, `auditDone` before the response goes out. Auditing still cannot
 * *fail* the call — the chain never rejects, so a dead log path costs a
 * `console.error` and a bumped `auditWriteFailures()`, not an error reply.
 *
 * A log past MAX_LOG_BYTES rotates to `<path>.1` instead of growing forever
 * (a rotation between the two lines of one call may split the pair across
 * `.1` and the current file — when it matters, pair by `id` across both).
 */
export function auditStart(
	id: string,
	sid: string | null,
	tool: string,
	args: unknown,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	return appendLine(
		`${JSON.stringify({ ts: new Date().toISOString(), id, sid, phase: "start", tool, args: serializeArgs(args) })}\n`,
		env,
	);
}

export function auditDone(
	id: string,
	sid: string | null,
	tool: string,
	args: unknown,
	isError: boolean,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	return appendLine(
		`${JSON.stringify({ ts: new Date().toISOString(), id, sid, phase: "done", tool, isError, args: serializeArgs(args) })}\n`,
		env,
	);
}

/**
 * One record per `POST /host-llm` toggle.
 *
 * Same single-record shape as the tools/call pair above, condensed: the action is
 * one state write with an immediate answer, and there is no approval gate that
 * could leave it half-done, so a `start`/`done` pair would only add a way to lose
 * the second line. The
 * `deny` half of the switch is worth a record precisely because it is the one
 * thing the bridge does *to the host* rather than *for the caller*: whoever
 * flipped it should be findable by `sid`, and whoever tripped the takeover's
 * refusal (a pi-native config, a dead session) shows up with `error` set.
 */
export function auditHostLlm(
	sid: string | null,
	enabled: boolean,
	error: string | null,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	const args = { enabled };
	return appendLine(
		`${JSON.stringify({
			ts: new Date().toISOString(),
			id: randomUUID(),
			sid,
			phase: "done",
			tool: "host_llm",
			isError: error !== null,
			args: serializeArgs(args),
			...(error ? { error: error.slice(0, 200) } : {}),
		})}\n`,
		env,
	);
}

/**
 * One record per `xfer_*` tool call.
 *
 * The bridge owns these tools rather than forwarding them to the host, so nothing
 * in the host's own log accounts for them — and what they do is hand a host path
 * to an HTTP server behind a public hostname. Every action that opens, closes or
 * fails to open a share lands here, with `args` carrying the path, the local port
 * and the TTL rather than any content: the payload is whatever the caller moves
 * through that URL afterwards, which this log never sees.
 */
export function auditXfer(
	sid: string | null,
	action: string,
	detail: Record<string, unknown>,
	error: string | null,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	const args = { action, ...detail };
	return appendLine(
		`${JSON.stringify({
			ts: new Date().toISOString(),
			id: randomUUID(),
			sid,
			phase: "done",
			tool: "xfer",
			isError: error !== null,
			args: serializeArgs(args),
			...(error ? { error: error.slice(0, 200) } : {}),
		})}\n`,
		env,
	);
}

/**
 * One record per `/a2mcp tunnel` start or stop.
 *
 * The MCP tunnel hands the bridge's own endpoint a public hostname, so this is
 * the record of the bridge managing a public listener — there is no `sid` to
 * attribute it to, because only the operator's session can open or close it
 * (`sid: null`, the same standing as the startup host-llm record). `args`
 * carries the announced hostname and the local port; the token never enters.
 */
export function auditTunnel(
	action: string,
	detail: Record<string, unknown>,
	error: string | null,
	env?: NodeJS.ProcessEnv,
): Promise<void> {
	const args = { action, ...detail };
	return appendLine(
		`${JSON.stringify({
			ts: new Date().toISOString(),
			id: randomUUID(),
			sid: null,
			phase: "done",
			tool: "tunnel",
			isError: error !== null,
			args: serializeArgs(args),
			...(error ? { error: error.slice(0, 200) } : {}),
		})}\n`,
		env,
	);
}
