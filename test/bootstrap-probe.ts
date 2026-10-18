/**
 * Bootstrap-script probe.
 *
 *   bun run test:bootstrap
 *
 * ## What it checks
 *
 * That `scripts/bootstrap.sh` makes the right *decisions*, not that `omp`
 * installs anything: an existing host is left alone, the pin comes out of
 * `package.json` rather than out of the script, `--dry-run` touches nothing, a
 * missing prerequisite stops for the reason it names, and the plugin step is the
 * README's one install path run verbatim. Groups 1-4 drive the script against a
 * recording stub `omp` in a throwaway HOME, so nothing real is installed and
 * nothing is downloaded.
 *
 * Group 5 is the one pass with the real host: temp HOME, the script run for
 * real, the registration checked in `omp-plugins.lock.json`, then `--uninstall`
 * to clean up. Its default spec is this checkout as `.` (run with the repo as
 * cwd), because what that group tests is the script's plumbing; omp's own git
 * fetch is what test:install groups 1-3 cover, and `A2MCP_BOOTSTRAP_SPEC` with a
 * git URL is how you point this group at it instead.
 *
 * ## The boundary of this coverage
 *
 * The host-install half is never executed here: every group either has a stub
 * `omp` on PATH, so the script refuses to install one, or is a `--dry-run` that
 * only prints the planned installer command. **The first real execution of that
 * branch happens on somebody else's machine.** What this repo can hold it to is
 * the plan it prints, the pin it prints, and the exit codes it takes when a
 * prerequisite is missing.
 *
 * Env:
 *   A2MCP_BOOTSTRAP_SPEC     the spec for the real-host group (default: `.` = this checkout)
 *   A2MCP_BOOTSTRAP_OMP_BIN  the host used for the real-host group's cleanup (default: omp on PATH)
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(process.env.REPO ?? join(import.meta.dir, ".."));
const SCRIPT = join(REPO, "scripts", "bootstrap.sh");

// Neither identity is typed here. PLUGIN is what the host keys its lock on
// (package.json:name), README_URL is what a reader is told to run (the install
// line in README.md) — the script has to agree with both, and a rename that
// lands on one side only now shows up as a red assertion instead of a probe
// seeding a name nobody publishes.
const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
	name?: string;
	devDependencies?: Record<string, string>;
};
const PLUGIN = manifest.name ?? "";
const README_URL = readFileSync(join(REPO, "README.md"), "utf8").match(/^omp install (\S+)$/m)?.[1] ?? "";
// Preconditions, not assertions: an empty derivation means this probe has no
// name to test with, so it must not run and report a clean sheet.
if (PLUGIN === "") throw new Error("no name in package.json — cannot derive the plugin name");
if (README_URL === "") throw new Error("no `omp install <url>` line in README.md — cannot derive the install URL");

const PIN = manifest.devDependencies?.["@oh-my-pi/pi-coding-agent"] ?? "";
const SPEC = process.env.A2MCP_BOOTSTRAP_SPEC ?? ".";

let failures = 0;
/**
 * `detail` prints on **both** paths, so it has to read true on both — the same
 * rule as test/install-probe.ts.
 */
function check(cond: unknown, label: string, detail = ""): void {
	console.log(`${cond ? "ok" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
}
function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

if (!existsSync(SCRIPT)) fail(`no script under test at ${SCRIPT}`);
if (!PIN) fail("package.json carries no @oh-my-pi/pi-coding-agent pin for the script to read");

// --- the harness: a PATH we build, a HOME we own, an omp that only records ----

const REAL_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];
const SCRATCH = mkdtempSync(join(tmpdir(), "boot-stub-"));
const STUB_LOG = join(SCRATCH, "argv.log");
const STUB_PLUGINS = join(SCRATCH, "plugins.txt");
const STUB_DOCTOR = join(SCRATCH, "doctor.txt");
const STUB_VERSION = join(SCRATCH, "version.txt");
const STUB_HOME = join(SCRATCH, "hosted");
mkdirSync(STUB_HOME, { recursive: true });

/** Symlinks to exactly the real binaries named; every other name answers to nothing. */
function farm(allowed: string[]): string {
	const dir = mkdtempSync(join(SCRATCH, "bin-"));
	for (const name of allowed) {
		// `omp` is never the real one: it would register plugins in the operator's HOME.
		const src = name === "omp" ? join(STUB_HOME, "omp") : REAL_DIRS.map((d) => join(d, name)).find(existsSync);
		if (src && existsSync(src)) symlinkSync(src, join(dir, name));
	}
	return dir;
}

const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "${STUB_LOG}"
case "$1" in
--version) cat "${STUB_VERSION}" ;;
install) printf '\\342\\227\\217 ${PLUGIN}@stub\\n' >> "${STUB_PLUGINS}" ;;
plugin)
	shift
	case "$1" in
	list) [ -f "${STUB_PLUGINS}" ] && cat "${STUB_PLUGINS}" ;;
	doctor) cat "${STUB_DOCTOR}" ;;
	uninstall)
		if [ -f "${STUB_PLUGINS}" ]; then
			grep -v -- "$2@" "${STUB_PLUGINS}" > "${STUB_PLUGINS}.tmp" || true
			mv "${STUB_PLUGINS}.tmp" "${STUB_PLUGINS}"
		fi
		echo "removed $2"
		;;
	esac
	;;
esac
exit 0
`;
writeFileSync(join(STUB_HOME, "omp"), STUB, { mode: 0o755 });

/** Set what the stub host reports: its version, what is registered, whether doctor is clean. */
function stubHost(opts: { version?: string; registered?: boolean; doctorOk?: boolean } = {}) {
	writeFileSync(STUB_VERSION, `${opts.version ?? "omp/18.12.1"}\n`);
	writeFileSync(STUB_PLUGINS, opts.registered ? `\u25CF ${PLUGIN}@${PIN}\n` : "\u25CF other-plugin@1.0.0\n");
	const mark = opts.doctorOk === false ? "\u2717" : "\u2714";
	writeFileSync(STUB_DOCTOR, `Plugin Health Check\n${mark} plugin:${PLUGIN}: v${PIN} - the bridge\n`);
	rmSync(STUB_LOG, { force: true });
}

/** The names the script and its stub host call; `take` removes them to test the stops. */
function core(take: string[] = []): string[] {
	return ["dirname", "sed", "grep", "head", "cat", "mv", "git", "tar", "curl", "omp"].filter((b) => !take.includes(b));
}

/** Run the script with nothing inherited: the PATH and HOME are exactly ours. */
function runBootstrap(dirs: string[], home: string, args: string[], cwd = home) {
	const res = spawnSync("/bin/sh", [SCRIPT, ...args], {
		env: { PATH: dirs.join(":"), HOME: home },
		cwd,
		encoding: "utf8",
	});
	const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
	return {
		code: res.status ?? -1,
		out: text,
		lines: text.split("\n").filter((l) => l.length > 0),
		args: existsSync(STUB_LOG)
			? readFileSync(STUB_LOG, "utf8")
					.split("\n")
					.filter((l) => l.length > 0)
			: [],
	};
}

function tempHome(): string {
	// The script's only write target under a stub host is the registration the
	// stub keeps outside this directory, so "dry-run wrote nothing" is a real claim.
	return mkdtempSync(join(SCRATCH, "home-"));
}

/** A copy of the script beside a package.json we control, for the pin mutations. */
function scriptWithPin(pin: string): { script: string; dir: string } {
	const dir = mkdtempSync(join(SCRATCH, "fabricated-"));
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`{\n  "devDependencies": {\n    "@oh-my-pi/pi-coding-agent": "${pin}"\n  }\n}\n`,
	);
	const script = join(dir, "scripts", "bootstrap.sh");
	writeFileSync(script, readFileSync(SCRIPT, "utf8"));
	return { script, dir };
}

console.log(`script under test: ${SCRIPT}`);
console.log(`pin in package.json: ${PIN}`);
console.log(`spec handed to the real-host group: ${SPEC}\n`);

// --- 1. where the pin comes from ---------------------------------------------

console.log("--- the pin the host is installed against ---");
{
	stubHost();
	const home = tempHome();
	// No omp on PATH here: the installer branch is the one that needs a pin.
	const dirs = [farm(core(["omp"]))];
	const r = runBootstrap(dirs, home, ["--dry-run"]);
	check(
		r.out.includes(`--binary --ref v${PIN}`),
		"the planned installer call carries the pin read from package.json",
		r.lines.find((l) => l.includes("curl -fsSL")) ?? "no installer line at all",
	);
	check(
		r.out.includes(`pinned to v${PIN} (read from`),
		"the plan names where the pin came from",
		r.lines.find((l) => l.includes("read from")) ?? "no provenance line",
	);

	const down = scriptWithPin("9.9.9");
	const rd3 = spawnSync("/bin/sh", [down.script, "--dry-run"], {
		env: { PATH: farm(core(["omp"])), HOME: home },
		cwd: home,
		encoding: "utf8",
	});
	const rd3text = `${rd3.stdout ?? ""}${rd3.stderr ?? ""}`;
	check(
		rd3text.includes("--binary --ref v9.9.9"),
		"a different pin in package.json changes the planned --ref (so it is read, not typed)",
		rd3text.split("\n").find((l) => l.includes("--ref")) ?? "no --ref line",
	);

	const loose = spawnSync("/bin/sh", [scriptWithPin("^18.0.0").script, "--dry-run"], {
		env: { PATH: farm(core(["omp"])), HOME: home },
		cwd: home,
		encoding: "utf8",
	});
	const loosetext = `${loose.stdout ?? ""}${loose.stderr ?? ""}`;
	check(
		loose.status !== 0 || (!loosetext.includes("--ref") && /not an exact version/.test(loosetext)),
		"a range instead of an exact pin is refused as a pin, not guessed at",
		loosetext.split("\n").find((l) => l.includes("exact version")) ?? `exit ${loose.status}`,
	);

	const forced = runBootstrap(dirs, home, ["--dry-run", "--host-version", "7.7.7"]);
	check(
		forced.out.includes("--binary --ref v7.7.7") && !forced.out.includes(`v${PIN}`),
		"--host-version overrides the pin in package.json",
		forced.lines.find((l) => l.includes("curl -fsSL")) ?? "no installer line",
	);

	const latest = runBootstrap(dirs, home, ["--dry-run", "--host-version", "latest"]);
	check(
		latest.out.includes("curl -fsSL https://omp.sh/install | sh\n") && !latest.out.includes("--ref"),
		"--host-version latest plans an unpinned install",
		latest.lines.find((l) => l.includes("curl -fsSL")) ?? "no installer line",
	);
}

// --- 2. what the plan says it will do ----------------------------------------

console.log("\n--- --dry-run: the plan, and nothing else ---");
{
	stubHost();
	const home = tempHome();
	const dirs = [farm(core())];
	const r = runBootstrap(dirs, home, ["--dry-run"]);
	check(r.code === 0, "the plan completes with exit 0", `exit ${r.code}`);
	check(
		!r.out.includes("curl -fsSL"),
		"a host already on PATH is not replaced",
		r.lines.find((l) => l.includes("already on PATH")) ?? "no host line at all",
	);
	check(
		r.out.includes(`plan: omp install ${README_URL}`),
		"the extension step is the README's one install path, run verbatim",
		r.lines.find((l) => l.startsWith("plan: omp install")) ?? "no install line",
	);
	check(
		r.out.includes("plan: omp plugin doctor"),
		"verification is the host's own doctor, not a second check",
		r.lines.find((l) => l.includes("plugin doctor")) ?? "no doctor line",
	);
	check(
		readdirSync(home).length === 0,
		"--dry-run leaves HOME exactly as it found it",
		`${readdirSync(home).length} entry(ies) under ${home}`,
	);
}

// --- 3. the prerequisites stop for the reason they name ----------------------

console.log("\n--- prerequisites ---");
{
	// Each scenario gets a fresh stub state: the run that goes all the way through
	// leaves the plugin registered, and the next one would read that as its own
	// answer.
	stubHost();
	const home = tempHome();
	// No omp either: without a host on PATH the installer branch is the one that
	// needs curl.
	const noCurl = runBootstrap([farm(core(["curl", "omp"]))], home, []);
	check(
		noCurl.code !== 0 && /wanted: curl on PATH/.test(noCurl.out),
		"a host install without curl stops and says curl",
		noCurl.lines.find((l) => l.includes("curl")) ?? `exit ${noCurl.code}`,
	);

	stubHost();
	const noGit = runBootstrap([farm(core(["git"]))], home, ["--dry-run"]);
	check(
		noGit.code !== 0 && /wanted: git on PATH/.test(noGit.out),
		"the extension step without git stops and says git",
		noGit.lines.find((l) => l.includes("git")) ?? `exit ${noGit.code}`,
	);

	stubHost();
	const noTar = runBootstrap([farm(core(["tar"]))], home, ["--dry-run"]);
	check(
		noTar.code === 0 && /warn: no tar/.test(noTar.out),
		"a missing tar is a warning about the bridge's own fetch, not a stop",
		noTar.lines.find((l) => l.startsWith("warn:")) ?? `exit ${noTar.code}`,
	);

	stubHost();
	const badHome = runBootstrap([farm(core())], join(SCRATCH, "no-such-home"), ["--dry-run"], SCRATCH);
	check(
		badHome.code !== 0 && /wanted: a writable HOME|wanted: HOME/.test(badHome.out),
		"an unusable HOME stops and says HOME",
		badHome.lines.find((l) => l.includes("HOME")) ?? `exit ${badHome.code}`,
	);

	stubHost();
	const badArg = runBootstrap([farm(core())], home, ["--frobnicate"]);
	check(
		badArg.code !== 0 && /wanted: a known option/.test(badArg.out),
		"an unknown option stops instead of being ignored",
		badArg.lines.find((l) => l.includes("wanted")) ?? `exit ${badArg.code}`,
	);
}

// --- 4. a run against the recording host -------------------------------------

console.log("\n--- the decisions it takes about the registration ---");
{
	const home = tempHome();
	const dirs = [farm(core())];

	stubHost({ registered: true });
	let r = runBootstrap(dirs, home, []);
	check(
		r.code === 0 && !r.args.some((a) => a.startsWith("install ")),
		"an already-registered bridge is not installed again",
		r.args.join(" | ") || "the stub saw no calls",
	);

	stubHost({ registered: false });
	r = runBootstrap(dirs, home, []);
	check(
		r.code === 0 && r.args.some((a) => a === `install ${README_URL}`),
		"the install it runs is the spec, not a local path",
		r.args.filter((a) => a.startsWith("install ")).join(" | ") || "no install call",
	);

	stubHost({ registered: true });
	r = runBootstrap(dirs, home, ["--reinstall"]);
	const order = r.args.indexOf(`plugin uninstall ${PLUGIN}`);
	const after = r.args.findIndex((a) => a.startsWith("install "));
	check(
		r.code === 0 && order >= 0 && after > order,
		"--reinstall unregisters before it installs",
		`uninstall at ${order}, install at ${after}`,
	);

	stubHost({ registered: true });
	r = runBootstrap(dirs, home, ["--uninstall"]);
	check(
		r.code === 0 &&
			r.args.some((a) => a === `plugin uninstall ${PLUGIN}`) &&
			!r.args.some((a) => a.startsWith("install ")),
		"--uninstall removes the registration and installs nothing",
		r.args.join(" | ") || "the stub saw no calls",
	);

	stubHost({ registered: false, doctorOk: true });
	r = runBootstrap(dirs, home, []);
	check(
		r.code === 0 && r.out.includes(`plugin doctor: \u2714 plugin:${PLUGIN}`),
		"a clean doctor is what the script accepts, and it echoes it",
		r.lines.find((l) => l.includes("plugin doctor")) ?? `exit ${r.code}`,
	);

	stubHost({ registered: false, doctorOk: false });
	r = runBootstrap(dirs, home, []);
	check(
		r.code !== 0 && r.out.includes(`plugin:${PLUGIN}`),
		"a broken registration is not walked past (the doctor gate is real)",
		r.lines.find((l) => l.includes("wanted:")) ?? `exit ${r.code}`,
	);

	stubHost({ registered: false, version: "omp/99.9.9" });
	r = runBootstrap(dirs, home, []);
	check(
		r.code === 0 && /while this repo pins/.test(r.out),
		"a host at another version is reported, not stopped at",
		r.lines.find((l) => l.startsWith("warn:")) ?? `exit ${r.code}`,
	);
}

// --- 5. the same script driven by a real host --------------------------------

console.log("\n--- the real host, in a throwaway HOME ---");
{
	const omp = process.env.A2MCP_BOOTSTRAP_OMP_BIN ?? Bun.which("omp");
	if (!omp) {
		console.log("info: skipped — no omp on PATH for the real-host group");
	} else {
		const home = mkdtempSync(join(tmpdir(), "boot-real-"));
		const agent = join(home, ".omp", "agent");
		mkdirSync(agent, { recursive: true });
		// A real host refuses to create a session without model configuration, and
		// `omp install` is not a session — but doctor reads the same registry, so the
		// seed keeps this group honest about what it would take to run the bridge.
		writeFileSync(
			join(agent, "models.yml"),
			"version: 1\ndefaultProvider: placeholder\nproviders:\n  - name: placeholder\n    baseUrl: http://127.0.0.1:1/v1\n",
		);
		const real = spawnSync("/bin/sh", [SCRIPT, "--spec", SPEC], {
			env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" },
			cwd: REPO,
			encoding: "utf8",
		});
		const text = `${real.stdout ?? ""}${real.stderr ?? ""}`;
		check(
			real.status === 0,
			"the script completes against a real host",
			text.split("\n").find((l) => l.startsWith("plugin doctor:")) ?? `exit ${real.status}`,
		);
		const lockPath = join(home, ".omp", "plugins", "omp-plugins.lock.json");
		const lock = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
		check(
			lock.includes(PLUGIN),
			"the registration lands in the lock file under the HOME the script ran in",
			lock ? `${lockPath} mentions ${PLUGIN}` : `${lockPath} absent`,
		);
		const node = join(home, ".omp", "plugins", "node_modules", PLUGIN);
		check(existsSync(node), "the plugin directory the host reads is there", node);

		const again = spawnSync("/bin/sh", [SCRIPT, "--spec", SPEC], {
			env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" },
			cwd: REPO,
			encoding: "utf8",
		});
		const againText = `${again.stdout ?? ""}${again.stderr ?? ""}`;
		check(
			again.status === 0 && /already registered/.test(againText),
			"running it a second time says already registered rather than installing twice",
			againText.split("\n").find((l) => l.includes("already registered")) ?? `exit ${again.status}`,
		);

		const off = spawnSync("/bin/sh", [SCRIPT, "--uninstall"], {
			env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" },
			cwd: REPO,
			encoding: "utf8",
		});
		const offLock = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
		check(
			off.status === 0 && !offLock.includes(PLUGIN),
			"--uninstall takes the registration back out of the lock",
			offLock.includes(PLUGIN) ? `${PLUGIN} still in ${lockPath}` : `exit ${off.status}, lock clean`,
		);
		rmSync(home, { recursive: true, force: true });
	}
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "BOOTSTRAP OK" : `BOOTSTRAP FAILED: ${failures} check(s)`}`);
if (failures > 0) process.exit(1);
