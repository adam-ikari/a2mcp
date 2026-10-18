import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../src/config.ts";
import { configPath, generateToken, loadConfig, saveConfig } from "../src/config.ts";

let dir: string;
let file: string;
let env: NodeJS.ProcessEnv;

const VALID: BridgeConfig = {
	port: 1234,
	token: "unit-test-token-0123456789abcdef",
	host: "127.0.0.1",
	host_llm: "allow",
	xfer: { dufs: "dufs", cloudflared: "cloudflared" },
};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "a2mcp-cfg-"));
	file = join(dir, "a2mcp.json");
	env = { A2MCP_CONFIG: file };
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(file, { force: true });
});

describe("loadConfig", () => {
	test("missing file -> defaults with a fresh token", async () => {
		const cfg = await loadConfig(env);
		expect(cfg.port).toBe(0);
		expect(cfg.host).toBe("127.0.0.1");
		expect(cfg.host_llm).toBe("allow");
		expect(cfg.token).toHaveLength(43); // 32 random bytes, base64url
	});

	test("valid config round-trips through save/load", async () => {
		await saveConfig(VALID, env);
		expect(await loadConfig(env)).toEqual(VALID);
		expect(configPath(env)).toBe(file);
	});

	test("saved config is 0600", async () => {
		await saveConfig(VALID, env);
		const s = await stat(file);
		expect(s.mode & 0o777).toBe(0o600);
	});

	test("unknown extra fields are ignored", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, futureField: 42 }));
		expect(await loadConfig(env)).toEqual(VALID);
	});

	test("unparseable JSON -> throws with the file path", async () => {
		await writeFile(file, "{oops");
		await expect(loadConfig(env)).rejects.toThrow(`Invalid config JSON at ${file}`);
	});

	test("non-object JSON -> throws", async () => {
		await writeFile(file, "[1,2,3]");
		await expect(loadConfig(env)).rejects.toThrow("expected a JSON object");
	});

	test("port of the wrong type -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, port: "8080" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'port' must be an integer`);
	});

	test("port out of range -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, port: 70000 }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'port' must be an integer`);
	});

	test("host of the wrong type -> fail-closed", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, host: "" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'host' must be a non-empty string`);
	});

	test("host_llm absent -> the startup state is allow", async () => {
		// The shared-host default: a bridge that was never told otherwise leaves
		// the host's own reasoning alone.
		await writeFile(file, JSON.stringify({ port: 1234, token: VALID.token, host: VALID.host }));
		expect((await loadConfig(env)).host_llm).toBe("allow");
	});

	test("host_llm deny loads, and round-trips through save", async () => {
		await saveConfig({ ...VALID, host_llm: "deny" }, env);
		expect((await loadConfig(env)).host_llm).toBe("deny");
	});

	test("host_llm of any other shape -> fail-closed, not defaulted", async () => {
		// A typo here ("denied", "ALLOW") must stop startup rather than silently
		// come up allowing inference: the field is the operator's own no-LLM vow.
		for (const bad of ["denied", "ALLOW", true, 1, ""]) {
			await writeFile(file, JSON.stringify({ ...VALID, host_llm: bad }));
			await expect(loadConfig(env)).rejects.toThrow(`field 'host_llm' must be 'deny' or 'allow'`);
		}
	});

	test("a token too short to be a secret -> fail-closed, not healed", async () => {
		// The token is the only gate on an endpoint that writes anywhere the host can.
		// Healing it would be worse than refusing: it silently replaces a token
		// somebody chose and leaves the remote's mcp.json failing with no reason given.
		await writeFile(file, JSON.stringify({ ...VALID, token: "letmein" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'token' must be at least 32 characters`);
		expect((JSON.parse(await readFile(file, "utf8")) as { token: string }).token).toBe("letmein");
	});

	test("a token with whitespace -> fail-closed", async () => {
		// `extractBearer` hands back everything after `Bearer ` verbatim, so a stored
		// token with a space in it can only ever be matched by a header that carries
		// that space too. Nobody types that on purpose; a paste does it.
		await writeFile(file, JSON.stringify({ ...VALID, token: "unit test token 0123456789abcdef" }));
		await expect(loadConfig(env)).rejects.toThrow(`field 'token' must be at least 32 characters`);
	});

	test("missing token -> regenerated and persisted (stable across restarts)", async () => {
		await writeFile(file, JSON.stringify({ port: 0, host: "127.0.0.1" }));
		const first = await loadConfig(env);
		const onDisk = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
		expect(onDisk.token).toBe(first.token);
		const second = await loadConfig(env);
		expect(second.token).toBe(first.token);
	});

	test("non-string token -> regenerated", async () => {
		await writeFile(file, JSON.stringify({ ...VALID, token: 12345 }));
		const cfg = await loadConfig(env);
		expect(typeof cfg.token).toBe("string");
		expect(cfg.token).not.toBe("12345");
	});
});

describe("generateToken", () => {
	test("32 bytes, base64url, unique", () => {
		const a = generateToken();
		const b = generateToken();
		expect(a).toHaveLength(43);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
	});
});

describe("configPath", () => {
	test("the default is the filename the docs and the probes use", () => {
		// Everything above runs with $A2MCP_CONFIG set, so nothing here opens the
		// default path. That is the shape a half-done rename survives in: production
		// reads `<agentDir>/a2mcp.json` while the probes keep seeding the file under
		// the previous name, and the file they seed is a file nobody opens. Same
		// cross-check test/obtain.test.ts runs on the install ledger.
		expect(configPath({})).toMatch(/(^|\/)a2mcp\.json$/);
		expect(configPath({ A2MCP_CONFIG: "/elsewhere/x.json" })).toBe("/elsewhere/x.json");
	});
});
