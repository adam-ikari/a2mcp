#!/bin/sh
# Put the omp host on this machine, then install this extension into it.
#
# The extension half is the README's single install path and nothing else: this
# script adds no second way to install the bridge, it adds the host layer the
# README assumes you already have. Every registration check is delegated to the
# host's own `omp plugin doctor`, because a second module-graph validator is
# exactly what got deleted from this repo once already.
#
# Usage: sh bootstrap.sh [--dry-run] [--uninstall] [--reinstall] [--upgrade]
# [--host-version <version>|latest] [--spec <git-url>]
set -eu

PLUGIN="pi-a2a-ext"
DEFAULT_SPEC="https://github.com/adam-ikari/pi-a2a-ext.git"
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

usage() {
	sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
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
	need git "let omp clone $SPEC"
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
echo "  * The host needs model credentials before any session exists at all; without"
echo "    them there is nothing for the bridge to serve."
echo "  * On the first session_start the bridge writes its own config to"
echo "    $HOME/.omp/agent/a2mcp.json — random port, 43-character token."
echo "    Don't create that file by hand."
echo "  * The host announces the endpoint in its notification bar; point an MCP client"
echo "    at it from there."
echo "  * The host checks for its own updates at startup by default, so 'installed at"
echo "    the pinned version' is not 'stays at the pinned version'."
