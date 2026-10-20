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
 * recording stub `omp` and, where the pin read is what's under test, a recording
 * fake `curl`, both in a throwaway HOME, so nothing real is installed and nothing
 * is downloaded.
 *
 * Group 1b runs the script from a copy with no `package.json` above it, which is
 * the layout `curl … | sh` actually lands in: the pin then comes from the
 * manifest of whatever the spec points at — raw `package.json` for a github URL
 * shape, the registry's latest document for an npm name — through a fake curl
 * that records every call, including the runs where the correct answer is that
 * it recorded nothing. One item in that group asks the derived URL itself what
 * it serves; unreachable is a skip, and on the registry shape the pin-equality
 * half only runs while the published latest is this same version.
 *
 * Group 4b hands the script a fake installer that leaves a stub `omp` in
 * `PI_INSTALL_DIR`, so the fresh-host branch runs end to end for the first time:
 * that is the branch that seeds `~/.omp/agent/models.yml` with the unreachable
 * placeholder, and the group checks the bytes, the create-only guard, the
 * `--dry-run` plan, and that a machine with a host already on PATH gets no file.
 *
 * Group 5 is the one pass with the real host: temp HOME, the script run for
 * real, the registration checked in `omp-plugins.lock.json`, then `--uninstall`
 * to clean up. Its default spec is this checkout as `.` (run with the repo as
 * cwd), because what that group tests is the script's plumbing. The remote
 * fetches belong to test:install: it installs the published npm package for
 * real, and `A2MCP_BOOTSTRAP_SPEC` is how you point this group at a spec of
 * your choosing instead.
 *
 * ## The boundary of this coverage
 *
 * The official installer itself is never executed here: every group either has a
 * stub `omp` on PATH, so the script refuses to install one, or is a `--dry-run`
 * that only prints the planned installer command, or (group 4b) replaces the
 * download with a fake `curl` while the stub host is already sitting in
 * `PI_INSTALL_DIR`. **The first real execution of that download happens on
 * somebody else's machine.** What this repo can hold it to is the plan it prints,
 * the pin it prints, the file it seeds, and the exit codes it takes when a
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
	version?: string;
	devDependencies?: Record<string, string>;
};
const PLUGIN = manifest.name ?? "";
const VERSION = manifest.version ?? "";
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
function runBootstrap(
	dirs: string[],
	home: string,
	args: string[],
	cwd = home,
	script = SCRIPT,
	extraEnv: Record<string, string> = {},
) {
	const res = spawnSync("/bin/sh", [script, ...args], {
		env: { PATH: dirs.join(":"), HOME: home, ...extraEnv },
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

/** A copy of the script with no package.json anywhere above it — the piped form's layout. */
function bareScript(): { script: string; dir: string } {
	const dir = mkdtempSync(join(SCRATCH, "bare-"));
	mkdirSync(join(dir, "scripts"), { recursive: true });
	const script = join(dir, "scripts", "bootstrap.sh");
	writeFileSync(script, readFileSync(SCRIPT, "utf8"));
	return { script, dir };
}

/**
 * A `curl` that answers whatever we decide and records every call it took, so
 * "no request was sent" is a fact about the log rather than an absence. Only the
 * pin read reaches it: these runs are --dry-run, so the installer's own curl never fires.
 */
function fakeCurl(body: string | null): { dir: string; log: string; calls: () => string[] } {
	const dir = mkdtempSync(join(SCRATCH, "fakebin-"));
	const log = join(dir, "urls.log");
	const fixture = join(dir, "fixture.json");
	if (body !== null) writeFileSync(fixture, body);
	const script =
		body === null
			? `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 22\n`
			: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncat "${fixture}"\n`;
	writeFileSync(join(dir, "curl"), script, { mode: 0o755 });
	return {
		dir,
		log,
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter((l) => l.length > 0)
				: [],
	};
}

const fixturePackage = (pin: string): string =>
	`{\n  "name": "${PLUGIN}",\n  "devDependencies": {\n    "@oh-my-pi/pi-coding-agent": "${pin}"\n  }\n}\n`;

/**
 * The manifest URL the script should derive from this repo's own install spec:
 * the raw package.json for a github URL shape, the registry's latest document
 * for an npm name. Same two branches as the script, one derivation here — the
 * probe never carries a second copy of either URL.
 */
const REMOTE_PKG = README_URL.startsWith("https://github.com/")
	? `${README_URL.replace(/\.git$/, "").replace("github.com", "raw.githubusercontent.com")}/HEAD/package.json`
	: `https://registry.npmjs.org/${README_URL.replace(/(^@[^/]+)@[^@/:]*$/, "$1").replace(/\//g, "%2F")}/latest`;

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

// --- 1b. the same script with no repo beside it (curl | sh) -------------------

console.log("\n--- the pin when the script arrives through a pipe ---");
{
	stubHost();
	const home = tempHome();
	// No omp on PATH: this is the branch that installs a host, and no package.json
	// above the script: this is the file layout `curl … | sh` actually runs in.
	const bare = bareScript();

	const remote = fakeCurl(fixturePackage("9.9.9"));
	const rRemote = runBootstrap([remote.dir, farm(core(["omp"]))], home, ["--dry-run"], home, bare.script);
	check(
		rRemote.out.includes("--binary --ref v9.9.9"),
		"with no package.json beside it the script reads the pin from the spec's own manifest",
		rRemote.lines.find((l) => l.includes("--ref")) ?? "no --ref line",
	);
	check(
		rRemote.out.includes(`pinned to v9.9.9 (read from ${REMOTE_PKG})`),
		"the provenance line names the manifest URL it fetched from",
		rRemote.lines.find((l) => l.includes("read from")) ?? "no provenance line",
	);
	check(
		remote.calls().some((c) => c.includes(REMOTE_PKG)),
		"that pin came over the wire, not from this checkout",
		remote.calls().join(" | ") || "the fake curl recorded nothing",
	);

	const down = fakeCurl(null);
	const rDown = runBootstrap([down.dir, farm(core(["omp"]))], home, ["--dry-run"], home, bare.script);
	check(
		rDown.code === 0 && !rDown.out.includes("--ref") && rDown.out.includes("curl -fsSL https://omp.sh/install | sh\n"),
		"a failed pin fetch installs latest instead of stopping",
		`exit ${rDown.code}: ${rDown.lines.find((l) => l.startsWith("warn:")) ?? "no warn line"}`,
	);
	check(
		down.calls().some((c) => c.includes(REMOTE_PKG)),
		"and it says which URL it tried to read",
		rDown.lines.find((l) => l.includes(REMOTE_PKG)) ?? (down.calls().join(" | ") || "no request recorded"),
	);

	const other = fakeCurl(fixturePackage("9.9.9"));
	const rOther = runBootstrap(
		[other.dir, farm(core(["omp"]))],
		home,
		["--dry-run", "--spec", "git@gitlab.example:foo/bar.git"],
		home,
		bare.script,
	);
	check(
		other.calls().length === 0 &&
			/neither an https:\/\/github\.com URL nor an npm name/.test(rOther.out) &&
			!rOther.out.includes("--ref"),
		"a spec that is neither a github URL nor an npm name gets no guess and no request",
		other.calls().join(" | ") || (rOther.lines.find((l) => l.includes("no pin available")) ?? "no fallback line"),
	);

	const forced = fakeCurl(fixturePackage("9.9.9"));
	const rForced = runBootstrap(
		[forced.dir, farm(core(["omp"]))],
		home,
		["--dry-run", "--host-version", "7.7.7"],
		home,
		bare.script,
	);
	check(
		forced.calls().length === 0 && rForced.out.includes("--binary --ref v7.7.7"),
		"--host-version is honoured without a request for the pin",
		forced.calls().join(" | ") || "the fake curl recorded nothing",
	);

	const hosted = fakeCurl(fixturePackage("9.9.9"));
	const rHosted = runBootstrap([hosted.dir, farm(core())], home, ["--dry-run"], home, bare.script);
	check(
		hosted.calls().length === 0 && rHosted.out.includes("already on PATH"),
		"an existing host means no pin request at all: nothing here is going to install one",
		hosted.calls().join(" | ") || (rHosted.lines.find((l) => l.includes("already on PATH")) ?? "no host line"),
	);

	// The one item that leaves the machine: does the derivation match what the
	// manifest URL actually serves? Unreachable host is a skip, never a pass. On
	// the registry shape the pin-equality half only holds while the published
	// latest is this same version — a bump lands in the tree before it lands on
	// the registry, and the days between are not a red CI.
	const live = spawnSync("curl", ["-fsSL", "--max-time", "10", REMOTE_PKG], { encoding: "utf8" });
	if (live.status !== 0) {
		console.log(`info: skipped the live derivation check — ${REMOTE_PKG} not reachable (exit ${live.status})`);
	} else {
		const served = live.stdout.match(/"@oh-my-pi\/pi-coding-agent"\s*:\s*"([^"]+)"/)?.[1] ?? "nothing";
		const servedVersion = live.stdout.match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? "";
		if (!README_URL.startsWith("https://github.com/") && servedVersion !== VERSION) {
			console.log(
				`info: registry serves ${servedVersion}, this tree is ${VERSION} — checking readability only, not pin equality`,
			);
			check(
				/^\d+\.\d+\.\d+$/.test(served),
				"the manifest URL the script derives carries a readable host pin",
				`served: ${served}`,
			);
		} else {
			check(
				served === PIN,
				"the URL the script derives serves the same pin this repo carries",
				`the URL serves ${served}, package.json pins ${PIN}`,
			);
		}
	}
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
	// The default spec is the git URL again (the npm name stays only as the
	// reserved shape), so the bare default run is the one that needs git. curl is
	// in the farm so the installer check passes for the missing host, and the run
	// stops at the clone the host would do for the URL spec.
	const noGit = runBootstrap([farm(core(["omp", "git"]))], home, ["--dry-run"]);
	check(
		noGit.code !== 0 && /wanted: git on PATH/.test(noGit.out),
		"the git-shaped default spec without git on PATH stops and says git",
		noGit.lines.find((l) => l.includes("git")) ?? `exit ${noGit.code}`,
	);

	stubHost();
	const npmNoGit = runBootstrap([farm(core(["omp", "git"]))], home, ["--dry-run", "--spec", "a2mcp"]);
	check(
		npmNoGit.code === 0,
		"an npm-shaped spec asks for no git",
		npmNoGit.lines.find((l) => l.includes("wanted")) ?? `exit ${npmNoGit.code}`,
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

	// No curl and no repo beside the script: the pin read has to say it could not
	// happen and still let the installer's own prerequisite be the stop.
	stubHost();
	const bareNoCurl = bareScript();
	const noCurlBare = runBootstrap([farm(core(["curl", "omp"]))], tempHome(), ["--dry-run"], home, bareNoCurl.script);
	check(
		noCurlBare.out.includes(`no curl to read the pin from ${REMOTE_PKG}`) &&
			/wanted: curl on PATH/.test(noCurlBare.out),
		"with no curl the pin read is a warning and the stop stays at the installer that needs curl",
		noCurlBare.lines.filter((l) => l.includes("curl")).join(" / ") || `exit ${noCurlBare.code}`,
	);

	// `curl … | sh` leaves $0 pointing at the shell, so --help cannot read its own file.
	const pipedHelp = spawnSync("/bin/sh", ["-s", "--", "--help"], {
		input: readFileSync(SCRIPT, "utf8"),
		cwd: home,
		encoding: "utf8",
	});
	const pipedHelpText = `${pipedHelp.stdout ?? ""}${pipedHelp.stderr ?? ""}`;
	check(
		pipedHelp.status === 0 && pipedHelpText.includes("--host-version") && pipedHelpText.includes("--dry-run"),
		"--help prints the option list when the script came through a pipe",
		pipedHelpText.split("\n").find((l) => l.includes("Usage")) ?? `exit ${pipedHelp.status}`,
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

// --- 4b. the placeholder models.yml, and the one branch allowed to write it ---

console.log("\n--- the placeholder models.yml the fresh-host branch seeds ---");

/**
 * The fresh-host branch with its download replaced, not skipped: a fake `curl`
 * that answers the installer URL by printing nothing (the real installer would
 * have written the binary; here it already sits in PI_INSTALL_DIR, a copy of the
 * recording stub) and refuses every other URL. The script's own resolution then
 * finds $PI_INSTALL_DIR/omp and the branch runs to its end — seeding included.
 */
function freshHostRun(home: string, args: string[]): { r: ReturnType<typeof runBootstrap>; calls: () => string[] } {
	const piDir = mkdtempSync(join(SCRATCH, "install-dir-"));
	writeFileSync(join(piDir, "omp"), readFileSync(join(STUB_HOME, "omp"), "utf8"), { mode: 0o755 });
	const dir = mkdtempSync(join(SCRATCH, "installer-curl-"));
	const log = join(dir, "urls.log");
	writeFileSync(
		join(dir, "curl"),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nfor a in "$@"; do\n  case "$a" in\n  *omp.sh/install*) exit 0 ;;\n  esac\ndone\nexit 22\n`,
		{ mode: 0o755 },
	);
	// mkdir belongs to the seeding step, sh to the installer pipe (`curl … | sh`);
	// omp and curl come from this scene, not PATH.
	const bins = [...core(["omp", "curl"]), "mkdir", "sh"];
	const r = runBootstrap([dir, farm(bins)], home, args, home, SCRIPT, { PI_INSTALL_DIR: piDir });
	return {
		r,
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.split("\n")
						.filter((l) => l.length > 0)
				: [],
	};
}

const modelsPath = (home: string): string => join(home, ".omp", "agent", "models.yml");

{
	stubHost({ registered: false });
	const home = tempHome();
	const { r, calls } = freshHostRun(home, ["--host-version", "9.9.9"]);
	check(
		r.code === 0 && existsSync(modelsPath(home)),
		"the fresh-host run lands and writes ~/.omp/agent/models.yml",
		`exit ${r.code}${existsSync(modelsPath(home)) ? ", file present" : ", no file"}`,
	);
	const body = existsSync(modelsPath(home)) ? readFileSync(modelsPath(home), "utf8") : "";
	check(
		[
			"providers:",
			"  a2mcp:",
			"baseUrl: http://a2mcp.invalid/v1",
			"api: anthropic-messages",
			"apiKey: not-a-real-key",
			"- id: offline",
		].every((line) => body.includes(line)),
		"the file carries the extension's own placeholder shape",
		body ? `${body.split("\n").length} line(s)` : "nothing read back",
	);
	check(
		r.out.includes(`Wrote ${modelsPath(home)}`),
		"the script says which file it wrote",
		r.lines.find((l) => l.startsWith("Wrote")) ?? "no Wrote line",
	);
	check(
		!calls().some((c) => c.includes("raw.githubusercontent.com")),
		"with --host-version the only recorded request is the installer",
		calls().join(" | ") || "the fake curl recorded nothing",
	);
}
{
	stubHost({ registered: false });
	const home = tempHome();
	const sentinel = "providers:\n  - name: mine\n    baseUrl: http://127.0.0.1:9/v1\n";
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(modelsPath(home), sentinel);
	const { r } = freshHostRun(home, ["--host-version", "9.9.9"]);
	check(
		r.code === 0 && readFileSync(modelsPath(home), "utf8") === sentinel && !r.out.includes("Wrote"),
		"an existing models.yml is left byte for byte, and the script does not mention it",
		`exit ${r.code}: ${r.out.includes("Wrote") ? "claimed a write" : "silent"}`,
	);
}
{
	stubHost();
	const home = tempHome();
	const r = runBootstrap([farm(core(["omp"]))], home, ["--dry-run", "--host-version", "9.9.9"]);
	check(
		r.out.includes(`plan: write ${modelsPath(home)} (unreachable placeholder provider a2mcp/offline; create-only)`) &&
			!existsSync(modelsPath(home)) &&
			readdirSync(home).length === 0,
		"--dry-run plans the seeding on the fresh-host branch and leaves HOME empty",
		r.lines.find((l) => l.includes("plan: write")) ?? "no seeding plan line",
	);
}
{
	stubHost({ registered: false });
	const home = tempHome();
	const r = runBootstrap([farm(core())], home, []);
	check(
		r.code === 0 && !existsSync(join(home, ".omp")) && !r.out.includes("Wrote"),
		"a machine that already had omp gets no models.yml at all",
		`exit ${r.code}${existsSync(join(home, ".omp")) ? ", but .omp exists" : ""}`,
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
