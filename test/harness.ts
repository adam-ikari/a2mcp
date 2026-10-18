/**
 * Shared host bootstrap for the real-host probes.
 *
 * Every probe needs a throwaway HOME with the extension linked in, a config
 * pinning its token and port, and a models.yml. That last one exists only
 * because the host refuses to boot without model configuration — and it is the
 * reason these probes used to be unrunnable anywhere but a developer machine:
 * they copied the developer's real `~/.omp/agent/models.yml`, which means a real
 * provider and a real API key.
 *
 * It does not need a *working* provider. The host only checks that model
 * configuration exists before it starts a session; the probes never ask a model
 * anything, they only drive the bridge over MCP. So this writes a deliberately
 * unreachable provider: the boot succeeds, and nothing in the probe path can
 * reach the network.
 *
 * If you have a real models.yml and prefer it (e.g. to exercise against a real
 * host config), set A2MCP_PROBE_REAL_MODELS=1.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Unreachable on purpose — see the note above. */
const FAKE_MODELS_YML = `providers:
  a2mcp-probe-placeholder:
    baseUrl: http://127.0.0.1:1/v1
    api: anthropic-messages
    apiKey: not-a-real-key
    models:
      - id: a2mcp-probe/small
        contextWindow: 100000
`;

/**
 * Seed <agentDir>/models.yml so the host will boot. Returns a one-line note
 * about which source was used, for the probe's preamble.
 */
export function seedModels(agentDir: string): string {
	mkdirSync(agentDir, { recursive: true });
	const target = join(agentDir, "models.yml");
	const real = join(homedir(), ".omp", "agent", "models.yml");

	if (process.env.A2MCP_PROBE_REAL_MODELS === "1" && existsSync(real)) {
		copyFileSync(real, target);
		return "models.yml: copied from the real HOME (A2MCP_PROBE_REAL_MODELS=1)";
	}
	writeFileSync(target, FAKE_MODELS_YML);
	return "models.yml: placeholder provider (unreachable on purpose; the probes never call a model)";
}

/**
 * Link the extension into `<agentDir>/extensions/` so a throwaway HOME's host
 * actually loads it.
 *
 * This was open-coded in every probe, and one probe shipped without it: it
 * passed locally because `omp install .` had left a copy in the real plugin
 * directory, and failed in CI, where nothing installs the extension. The symptom
 * was "the host came up but the bridge never announced itself" — which reads like
 * a bridge bug and is not one.
 *
 * Note the direction this proves: the host follows HOME for `~/.omp/agent/
 * extensions/`, and since host 18.11.0 for `~/.omp/plugins/` too — re-checked on
 * 18.12.1 (on 18.10.4 it did not; see the header of test/install-probe.ts). A
 * probe that leans on the real plugin directory now loads nothing at all under a
 * temp HOME.
 */
export function linkExtension(agentDir: string): void {
	const REPO = resolve(import.meta.dir, "..");
	// The entry filename comes from `pi.extensions` — the host's own load switch —
	// rather than from a second copy of the name here. A hardcoded filename is a
	// rename waiting to go half-done: package.json would point at the new file while
	// every real-host probe kept linking the old one, and both would load.
	const entry = (
		JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
			pi?: { extensions?: string[] };
		}
	).pi?.extensions?.[0];
	if (!entry) throw new Error("package.json: pi.extensions[0] is missing");
	const src = resolve(REPO, entry);
	if (!existsSync(src)) throw new Error(`package.json: pi.extensions[0] does not exist (${entry})`);
	const extDir = join(agentDir, "extensions");
	mkdirSync(extDir, { recursive: true });
	symlinkSync(src, join(extDir, basename(src)));
}
