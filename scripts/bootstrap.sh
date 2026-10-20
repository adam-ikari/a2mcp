#!/bin/sh
# Put the omp host on this machine, then install this extension into it.
#
# The extension half is the README's single install path and nothing else: this
# script adds no second way to install the bridge, it adds the host layer the
# README assumes you already have. Every registration check is delegated to the
# host's own `omp plugin doctor`, because a second module-graph validator is
# exactly what got deleted from this repo once already.
#
# One file is written outside the installer, under a deliberately narrow
# condition: when this script installed the host itself AND
# $HOME/.omp/agent/models.yml does not exist, it creates that file with one
# unreachable placeholder provider (create-only — an existing models.yml is
# never read or touched, and a machine that already had omp gets nothing). The
# host refuses to boot headless with no model configuration at all, and no
# extension code runs before that boot, so a disk file is the only thing that
# can be there in time.
#
# Options: run with --help.
set -eu

PLUGIN="a2mcp"
DEFAULT_SPEC="https://github.com/adam-ikari/a2mcp.git"
INSTALLER_URL="https://omp.sh/install"
PIN_PACKAGE="@oh-my-pi/pi-coding-agent"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PKG_JSON="$SCRIPT_DIR/../package.json"

DRY=0
DO_UNINSTALL=0
DO_REINSTALL=0
DO_UPGRADE=0
HOST_VERSION=""
SPEC="$DEFAULT_SPEC"
SKIP_INSTALL=0
INSTALLED_HOST=0

fail() {
	printf 'FAIL\n  wanted: %s\n  got:    %s\n' "$1" "$2" >&2
	exit 1
}

warn() {
	printf 'warn: %s\n' "$*" >&2
}

has() {
	command -v "$1" >/dev/null 2>&1
}

need() {
	has "$1" || fail "$1 on PATH (needed to $2)" "nothing answering for $1 in PATH"
}

# Every write goes through these two, so --dry-run prints the plan and touches
# nothing.
plan() {
	printf 'plan: %s\n' "$*"
}

run() {
	if [ "$DRY" -eq 1 ]; then
		plan "$*"
	else
		printf '$ %s\n' "$*"
		"$@"
	fi
}

# The option list lives in usage() and nowhere else: `curl … | sh` leaves $0
# pointing at the shell, so printing the file header would read a binary.
usage() {
	cat <<'EOF'
Usage: sh bootstrap.sh [--dry-run] [--uninstall] [--reinstall] [--upgrade]
       [--host-version <version>|latest] [--spec <npm-name|git-url>]
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) DRY=1 ;;
	--uninstall) DO_UNINSTALL=1 ;;
	--reinstall) DO_REINSTALL=1 ;;
	--upgrade) DO_UPGRADE=1 ;;
	--host-version)
		[ $# -ge 2 ] || fail "a value after --host-version" "end of arguments"
		HOST_VERSION="$2"
		shift
		;;
	--spec)
		[ $# -ge 2 ] || fail "a value after --spec" "end of arguments"
		SPEC="$2"
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) fail "a known option" "$1" ;;
	esac
	shift
done

# --- where the host pin can be read from when no repo sits beside this script ---
# Run through a pipe there is no ../package.json, and the pin that decides the host
# version has to come from the same place the plugin itself will be fetched from.
# Two shapes are derived, and only these two: an https://github.com spec reads the
# repo's raw package.json, anything else is treated as an npm name and reads the
# registry's latest document (a scoped name carries its slash percent-encoded, as
# the registry asks). Guessing at any other host's layout is a second system nobody
# maintains. HEAD is what raw.githubusercontent.com resolves for the default branch,
# so the github shape keeps working if that branch is ever renamed.
REMOTE_PKG=""
case "$SPEC" in
https://github.com/*)
	REMOTE_PKG=$(printf '%s' "${SPEC%.git}" | sed -nE 's|^https://github\.com/([^/]+)/([^/]+)/?$|https://raw.githubusercontent.com/\1/\2/HEAD/package.json|p')
	;;
*)
	# Only a syntactic npm name (optionally scoped, optionally with a trailing
	# version; names start like the host's own validator says they do) reads as
	# one: anything else — a path, ssh://, git+, the scp-style host:path form —
	# stays without a guess.
	if printf '%s' "$SPEC" | grep -Eq '^(@[A-Za-z0-9~-][A-Za-z0-9._-]*/)?[A-Za-z0-9~-][A-Za-z0-9._-]*(@[^@/:]+)?$'; then
		# Cut a trailing @version/@tag, but never the leading @ of a scope —
		# that is the only @ a bare scoped name carries. POSIX expansions and
		# one sed only: the farm PATH this script is probed under has no awk.
		NPM_NAME="$SPEC"
		if [ "${NPM_NAME#\@}" != "$NPM_NAME" ]; then
			# scoped: cut only when a second @ exists after the scope slash
			if [ "${NPM_NAME#*/*@}" != "$NPM_NAME" ]; then
				NPM_NAME=$(printf '%s' "$NPM_NAME" | sed -E 's|^(@[^/]+/[^@]+)@.*|\1|')
			fi
		else
			NPM_NAME="${NPM_NAME%%@*}"
		fi
		NPM_NAME=$(printf '%s' "$NPM_NAME" | sed 's|/|%2F|')
		REMOTE_PKG="https://registry.npmjs.org/$NPM_NAME/latest"
	fi
	;;
esac

# --- prerequisites ---
[ -n "${HOME:-}" ] || fail "HOME pointing at a directory" "HOME empty"
if [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then
	fail "a writable HOME" "$HOME is not a writable directory"
fi
# The official installer's own default, so the path the script reports is the path
# the installer writes to whether or not the caller overrode it.
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
# tar belongs to the bridge's own dufs/cloudflared fetch (src/obtain.ts), not to
# this script, so its absence is a warning about a later step rather than a stop.
has tar || warn "no tar on PATH; the bridge unpacks the dufs and cloudflared release assets with it, so xfer_share will fail until one is installed"

OMP_CMD=""
if has omp; then
	OMP_CMD="omp"
fi

# --- uninstall: the one path that needs neither curl nor git ---
if [ "$DO_UNINSTALL" -eq 1 ]; then
	[ -n "$OMP_CMD" ] || fail "omp on PATH to uninstall the plugin from" "nothing answering for omp in PATH"
	if [ "$DRY" -eq 1 ]; then
		plan "$OMP_CMD plugin uninstall $PLUGIN"
		exit 0
	fi
	"$OMP_CMD" plugin uninstall "$PLUGIN"
	echo
	echo "Registration removed. The bridge writes its own config, port and token to"
	echo "  $HOME/.omp/agent/a2mcp.json"
	echo "and its audit log beside it; both are left alone, which is what the README says"
	echo "uninstall does."
	exit 0
fi

# --- pin ---
# The repo's devDependency pin is the host version every probe in this repo was
# last run green against, so installing to it is the closest thing to a known-good
# configuration a fresh machine can be put into.
PIN=""
PIN_SOURCE="no package.json next to this script and no --host-version"
if [ "$HOST_VERSION" = "latest" ]; then
	PIN_SOURCE="--host-version latest"
elif [ -n "$HOST_VERSION" ]; then
	PIN="$HOST_VERSION"
	PIN_SOURCE="--host-version"
elif [ -f "$PKG_JSON" ]; then
	PIN_SOURCE="$PKG_JSON"
	PIN=$(sed -n "s|.*\"$PIN_PACKAGE\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*|\1|p" "$PKG_JSON" | head -1)
elif [ -z "$OMP_CMD" ] && [ -n "$REMOTE_PKG" ]; then
	# Only when the host is actually going to be installed: with a host already on
	# PATH nothing here needs a version to fetch.
	PIN_SOURCE="$REMOTE_PKG"
	if has curl; then
		# The body lands in a variable before the extraction runs, because in a
		# pipeline curl's exit status is sed's and `set -e` would not see a failed
		# fetch. No temp file: --dry-run has to keep leaving HOME untouched.
		PIN_BODY=$(curl -fsSL --max-time 20 "$REMOTE_PKG" 2>/dev/null) || PIN_BODY=""
		PIN=$(printf '%s\n' "$PIN_BODY" | sed -n "s|.*\"$PIN_PACKAGE\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*|\1|p" | head -1)
		[ -n "$PIN" ] || warn "no pin readable from $REMOTE_PKG; pass --host-version <version> to choose the host version yourself"
	else
		warn "no curl to read the pin from $REMOTE_PKG with; pass --host-version <version> to choose the host version yourself"
	fi
elif [ -z "$OMP_CMD" ]; then
	PIN_SOURCE="spec '$SPEC', which is neither an https://github.com URL nor an npm name to read a package.json from"
fi
if [ -n "$PIN" ] && ! printf '%s' "$PIN" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
	warn "$PIN_PACKAGE is pinned to '$PIN' in $PIN_SOURCE, which is not an exact version; the host will be installed at latest instead"
	PIN=""
fi

# --- host ---
install_host() {
	need curl "fetch the official installer from $INSTALLER_URL"
	if [ -n "$1" ]; then
		plan "curl -fsSL $INSTALLER_URL | sh -s -- --binary --ref v$1"
		if [ "$DRY" -eq 1 ]; then
			return 0
		fi
		printf '$ curl -fsSL %s | sh -s -- --binary --ref v%s\n' "$INSTALLER_URL" "$1"
		curl -fsSL "$INSTALLER_URL" | sh -s -- --binary --ref "v$1"
	else
		plan "curl -fsSL $INSTALLER_URL | sh"
		if [ "$DRY" -eq 1 ]; then
			return 0
		fi
		printf '$ curl -fsSL %s | sh\n' "$INSTALLER_URL"
		curl -fsSL "$INSTALLER_URL" | sh
	fi
}

put_install_dir_on_path() {
	PATH="$INSTALL_DIR:$PATH"
	export PATH
	warn "$INSTALL_DIR is not on PATH; using it for the rest of this run. Add it to your shell profile if you want it there to stay."
}

if [ -n "$OMP_CMD" ]; then
	HOST_NOW=$("$OMP_CMD" --version 2>&1 | head -1)
	echo "omp is already on PATH: $(command -v omp) ($HOST_NOW) — left as it is."
	if [ "$DO_UPGRADE" -eq 1 ]; then
		echo "--upgrade: re-running the official installer, which writes $INSTALL_DIR/omp."
		echo "  If the omp above lives somewhere else, that copy stays on PATH in front of"
		echo "  the new one and the upgrade is not what 'omp' resolves to."
		install_host "$PIN"
		echo "  This install type is a prebuilt single-file binary, not a bun global package."
		has omp || put_install_dir_on_path
	fi
else
	echo "No omp on PATH. Installing the host first, from the official installer."
	INSTALLED_HOST=1
	if [ -n "$PIN" ]; then
		echo "  pinned to v$PIN (read from $PIN_SOURCE)"
	else
		echo "  no pin available from $PIN_SOURCE — installing latest"
	fi
	install_host "$PIN"
	if [ "$DRY" -eq 1 ]; then
		plan "resolve omp for the extension step (PATH, then $INSTALL_DIR/omp)"
		plan "the host arrives as a prebuilt single-file binary at $INSTALL_DIR/omp, not a bun global package"
	elif has omp; then
		OMP_CMD="omp"
		echo "  the host is a prebuilt single-file binary at $INSTALL_DIR/omp, not a bun global package"
	elif [ -x "$INSTALL_DIR/omp" ]; then
		put_install_dir_on_path
		OMP_CMD="omp"
		echo "  the host is a prebuilt single-file binary at $INSTALL_DIR/omp, not a bun global package"
	else
		fail "an omp answering on PATH after the installer ran" "nothing at omp or $INSTALL_DIR/omp"
	fi
fi
[ "$DRY" -eq 1 ] || [ -n "$OMP_CMD" ] || fail "omp on PATH" "nothing answering for omp in PATH"
# In --dry-run with no host on PATH nothing was installed to point at, so planned
# host commands are printed under the plain name.
OMP_LABEL=${OMP_CMD:-omp}

# Set when the seeding below actually writes the file; the closing notes speak
# from this flag, so a machine the script did not seed is not told it was.
SEEDED_YML=""

# --- placeholder model for the host this script just installed ---
# A machine with no model configuration at all cannot boot the host headless:
# `omp --mode rpc` stops inside createAgentSession, before any extension code
# ever runs. The interactive TUI does come up there, and the bridge fills the
# empty model slot with the same unreachable row (src/auto-model.ts) at
# session_start — but a file is the only thing that can exist before boot. So
# this writes one, and only on this branch: the host this script installed, on
# a machine that had none. A machine that already had omp keeps its model
# configuration alone — create-only, and an existing file is not read, not
# touched, not mentioned. The bytes are the extension's own placeholder shape:
# `a2mcp.invalid` is the RFC 6761 reserved domain, nothing under it can resolve
# and no request ever leaves the machine.
seed_placeholder_models() {
	[ "$INSTALLED_HOST" -eq 1 ] || return 0
	MODELS_YML="$HOME/.omp/agent/models.yml"
	if [ -e "$MODELS_YML" ]; then
		return 0
	fi
	if [ "$DRY" -eq 1 ]; then
		plan "write $MODELS_YML (unreachable placeholder provider a2mcp/offline; create-only)"
		return 0
	fi
	mkdir -p "$HOME/.omp/agent"
	cat >"$MODELS_YML" <<'EOF'
# Written by a2mcp's bootstrap script. The host refuses to start headless with
# no model configuration at all, so this file carries one unreachable provider
# by design: a2mcp.invalid is reserved (RFC 6761), no request ever leaves this
# machine, and prompts on the host fail as connection errors instead of
# blocking the bridge from serving its MCP surface at all. When this machine
# gets real credentials, pick a model with /model or delete this file.
providers:
  a2mcp:
    baseUrl: http://a2mcp.invalid/v1
    api: anthropic-messages
    apiKey: not-a-real-key
    models:
      - id: offline
        name: a2mcp placeholder (unreachable)
        contextWindow: 100000
EOF
	echo "Wrote $MODELS_YML — an unreachable placeholder provider so the host"
	echo "  boots headless too; it is create-only, and the bridge selects the same"
	echo "  row at session_start even without this file (interactive starts)."
	SEEDED_YML="$MODELS_YML"
}

seed_placeholder_models

# --- extension ---
installed_here() {
	[ -n "$OMP_CMD" ] || return 1
	"$OMP_CMD" plugin list 2>/dev/null | grep -Fq -- "$PLUGIN@"
}

if [ "$DO_REINSTALL" -eq 1 ] && installed_here; then
	echo "Removing the existing registration first (--reinstall)."
	run "$OMP_LABEL" plugin uninstall "$PLUGIN"
elif installed_here; then
	echo "$PLUGIN is already registered — nothing to install (--reinstall to force it)."
	SKIP_INSTALL=1
fi

if [ "$SKIP_INSTALL" -ne 1 ]; then
	case "$SPEC" in
	https://github.com/* | *://* | git+*) need git "let omp clone $SPEC" ;;
	esac
	echo "This is the README's one install path, run verbatim:"
	run "$OMP_LABEL" install "$SPEC"
fi

# --- verification: the host's own health check, not a second one ---
if [ "$DRY" -eq 1 ]; then
	plan "$OMP_LABEL plugin doctor (look for: ✔ plugin:$PLUGIN)"
	plan "compare omp --version against the pin"
else
	DOCTOR=$("$OMP_CMD" plugin doctor 2>&1) || true
	ROW=$(printf '%s\n' "$DOCTOR" | grep -F -- "plugin:$PLUGIN" | head -1)
	case "$ROW" in
	✔*) echo "plugin doctor: $ROW" ;;
	*)
		printf '%s\n' "$DOCTOR" | sed 's/^/    /'
		fail "a clean registration (a ✔ plugin:$PLUGIN line from omp plugin doctor)" "${ROW:-no plugin:$PLUGIN line at all}"
		;;
	esac

	HOST_NOW=$("$OMP_CMD" --version 2>&1 | head -1)
	if [ -n "$PIN" ] && ! printf '%s' "$HOST_NOW" | grep -Fq -- "$PIN"; then
		warn "the host reports $HOST_NOW while this repo pins $PIN — test/versions.test.ts is the guard that fails on the maintainer's machine for the same reason"
	fi
fi

echo
if [ "$DRY" -eq 1 ]; then
	echo "That was the plan — nothing above was written. From here:"
else
	echo "Done. From here:"
fi
echo "  * With no model configured the bridge still comes up: at session_start it"
echo "    selects an unreachable placeholder (a2mcp/offline), so the host's own"
echo "    prompts fail as connection errors instead of stopping everything. Real"
echo "    inference needs /login or /model. Headless (--mode rpc) starts cannot get"
if [ -n "$SEEDED_YML" ]; then
	echo "    that far without a models.yml: this script wrote one at $SEEDED_YML."
	echo "    The README's troubleshooting section has the shape."
else
	echo "    that far without a models.yml. This script wrote no such file here - it"
	echo "    writes one only when it installs the host itself on a machine with none."
	echo "    The README's troubleshooting section has the shape."
fi
echo "  * On the first session_start the bridge writes its own config to"
echo "    $HOME/.omp/agent/a2mcp.json — random port, 43-character token."
echo "    Don't create that file by hand."
echo "  * The host announces the endpoint in its notification bar; point an MCP client"
echo "    at it from there."
echo "  * The host checks for its own updates at startup by default, so 'installed at"
echo "    the pinned version' is not 'stays at the pinned version'."
