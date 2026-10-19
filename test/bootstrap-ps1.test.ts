/**
 * `scripts/bootstrap.ps1` — read, not run.
 *
 * The machine these tests execute on has no PowerShell (`pwsh` and `powershell` are
 * both absent), so not one line of that script has ever been interpreted. These
 * items are what can be checked without an interpreter: that the two bootstrap
 * scripts still name the same plugin, the same repository and the same installer,
 * that the one upstream trap this round found by reading the installer's source is
 * actually avoided on every path through the file, and that the file keeps the
 * encoding constraint its own header states.
 *
 * This is not coverage. `test/bootstrap-probe.ts` runs 46 checks against
 * `bootstrap.sh` by executing it; nothing here executes anything, and a syntax error
 * in the PowerShell would pass every item below. The claim each item makes is
 * "these two files agree", and that is all it is worth.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SH = readFileSync(join(root, "scripts", "bootstrap.sh"), "utf8");
const PS1 = readFileSync(join(root, "scripts", "bootstrap.ps1"), "utf8");
const PKG = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };
/** The README's one install path, the same line `test/bootstrap-probe.ts` derives from. */
const README = readFileSync(join(root, "README.md"), "utf8");
const README_URL = README.match(/^omp install (\S+)$/m)?.[1] ?? "";

/** `NAME="value"` from the shell script, `NAME = "value"` from the PowerShell one. */
function shellVar(name: string): string {
	return SH.match(new RegExp(`^${name}="([^"]*)"$`, "m"))?.[1] ?? "";
}
function psVar(name: string): string {
	return PS1.match(new RegExp(`^\\$${name} = "([^"]*)"$`, "m"))?.[1] ?? "";
}

describe("the two bootstrap scripts say the same thing", () => {
	test("the plugin name is one name, in both scripts and in package.json", () => {
		expect(README_URL).not.toBe(""); // the derivation below is worth nothing if it read nothing
		expect(shellVar("PLUGIN")).toBe(PKG.name);
		expect(psVar("Plugin")).toBe(PKG.name);
	});

	test("the extension repository is the README's git URL in both", () => {
		expect(shellVar("DEFAULT_SPEC")).toBe(README_URL);
		expect(psVar("DefaultSpec")).toBe(README_URL);
	});

	test("the installer URL is the same upstream script, with the platform's own extension", () => {
		const shInstaller = shellVar("INSTALLER_URL");
		const psInstaller = psVar("InstallerUrl");
		expect(shInstaller).toBe("https://omp.sh/install");
		expect(psInstaller).toBe(`${shInstaller}.ps1`);
	});

	test("the host package the pin is read for is named identically", () => {
		expect(shellVar("PIN_PACKAGE")).toBe("@oh-my-pi/pi-coding-agent");
		expect(psVar("PinPackage")).toBe(shellVar("PIN_PACKAGE"));
	});

	test("both refuse a range where an exact pin should be, and install latest instead", () => {
		expect(SH).toContain("'^[0-9]+\\.[0-9]+\\.[0-9]+$'");
		expect(PS1).toContain('"^\\d+\\.\\d+\\.\\d+$"');
	});
});

describe("the trap at the bottom of the upstream installer", () => {
	test("every call the script makes of the installer passes -Binary", () => {
		// `https://omp.sh/install.ps1` decides for itself: `-Ref` without a mode
		// switch flips it into a bun source build, and with no switch at all it
		// prefers bun whenever bun is installed. A script that pins a host version
		// and lands up building one from source is not pinning anything.
		const calls = [...PS1.matchAll(/Create\(\$installer\.Content\)\)(.*)$/gm)].map((m) => m[1]);
		expect(calls.length).toBe(2); // pinned, and latest
		for (const c of calls) expect(c).toMatch(/-Binary/);
	});

	test("the pinned form is the one the installer accepts as a release tag", () => {
		expect(PS1).toMatch(/-Ref "v\$Version"/);
		expect(PS1).toMatch(/\$Pin = \$HostVersion/);
	});
});

describe("the placeholder models.yml seeding", () => {
	/** The file body each script writes: the heredoc in sh, the here-string in PowerShell. */
	function shSeedBody(): string[] {
		const m = SH.match(/cat >"\$MODELS_YML" <<'EOF'\n([\s\S]*?)\nEOF/);
		return m ? m[1].split("\n") : [];
	}
	function psSeedBody(): string[] {
		const m = PS1.match(/\$body = @'\r?\n([\s\S]*?)\r?\n'@/);
		return m ? m[1].split(/\r?\n/) : [];
	}

	test("the seeded file carries the same lines in both scripts", () => {
		const sh = shSeedBody();
		expect(sh.length).toBeGreaterThan(10); // the extraction is worth nothing if it matched nothing
		expect(psSeedBody()).toEqual(sh);
	});

	test("both write it only on the branch where the script itself installed the host", () => {
		// One assignment each, and it sits in the fresh-host branch, not at the top.
		const shLines = SH.split("\n");
		const psLines = PS1.split("\n");
		const shTakes = shLines.filter((l) => /^\t*INSTALLED_HOST=1$/.test(l));
		const psTakes = psLines.filter((l) => /^\s*\$InstalledHost = \$true$/.test(l));
		expect(shTakes.length).toBe(1);
		expect(psTakes.length).toBe(1);
		expect(shLines.some((l, i) => /INSTALLED_HOST=1/.test(l) && /No omp on PATH/.test(shLines[i - 1] ?? ""))).toBe(
			true,
		);
		expect(
			psLines.some((l, i) => /\$InstalledHost = \$true/.test(l) && /No omp on PATH/.test(psLines[i - 1] ?? "")),
		).toBe(true);
	});

	test("both are create-only, on the profile's own models.yml", () => {
		expect(SH).toContain('MODELS_YML="$HOME/.omp/agent/models.yml"');
		expect(SH).toMatch(/if \[ -e "\$MODELS_YML" \]; then/);
		expect(PS1).toContain('".omp\\agent\\models.yml"');
		expect(PS1).toMatch(/if \(Test-Path -LiteralPath \$ModelsYml -PathType Leaf\) \{\s*\n\s*return\s*\n\s*\}/);
	});

	test("both plan the write under a dry run instead of doing it", () => {
		expect(SH).toMatch(/plan "write \$MODELS_YML \(unreachable placeholder provider a2mcp\/offline; create-only\)"/);
		expect(PS1).toMatch(/Plan "write \$ModelsYml \(unreachable placeholder provider \$Plugin\/offline; create-only\)"/);
	});
});

describe("the file keeps the constraint it states", () => {
	test("bootstrap.ps1 is pure ASCII", () => {
		// PowerShell 5.1 reads a BOM-less UTF-8 file in the ANSI codepage, so one
		// non-ASCII character in this script is a comment that turns into mojibake on
		// the machines that run it — and a string literal would turn into a wrong
		// value, not a wrong comment.
		const bad = [...PS1].filter((c) => {
			if (c === "\n" || c === "\r" || c === "\t") return false;
			const n = c.codePointAt(0) ?? 0;
			return n < 0x20 || n > 0x7e;
		});
		expect(bad.map((c) => c.codePointAt(0)?.toString(16))).toEqual([]);
	});

	test("the dry-run branch never runs a command", () => {
		// The same claim `bootstrap.sh` is probed for by counting the entries left in
		// a temporary HOME. Here the shape is checkable: every side effect goes
		// through `Run`, and `Run` prints its plan before it would execute anything.
		expect(PS1).toMatch(/function Run\([\s\S]{0,80}if \(\$DryRun\) \{\s*\n\s*Plan \$Shown\s*\n\s*\}\s*\n\s*else \{/);
	});
});
