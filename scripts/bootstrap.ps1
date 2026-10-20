
<#
  Put the omp host on this machine, then install this extension into it.

  The extension half is the README's single install path and nothing else: this
  script adds no second way to install the bridge, it adds the host layer the
  README assumes you already have. Every registration check is delegated to the
  host's own `omp plugin doctor`, because a second module-graph validator is
  exactly what got deleted from this repo once already.

  One file is written outside the installer, under a deliberately narrow
  condition: when this script installed the host itself AND
  $env:USERPROFILE\.omp\agent\models.yml does not exist, it creates that file
  with one unreachable placeholder provider (create-only -- an existing
  models.yml is never read or touched, and a machine that already had omp gets
  nothing). The host refuses to boot headless with no model configuration at
  all, and no extension code runs before that boot, so a disk file is the only
  thing that can be there in time.

  This is the Windows twin of scripts/bootstrap.sh. Same decisions, same
  defaults, same output shape. It is pure ASCII on purpose: PowerShell 5.1 reads
  a BOM-less UTF-8 file in the ANSI codepage, so a single non-ASCII character in
  this script turns its own comments into mojibake on the machines that run it.

  Usage:
    # one line, in memory, nothing written to disk:
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/adam-ikari/a2mcp/HEAD/scripts/bootstrap.ps1 | iex"
    # to pass switches in memory, the scriptblock form binds parameters:
    powershell -NoProfile -Command "& ([scriptblock]::Create((iwr -UseBasicParsing https://raw.githubusercontent.com/adam-ikari/a2mcp/HEAD/scripts/bootstrap.ps1).Content)) -DryRun"
    # or saved first:
    powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 [-DryRun]
      [-Uninstall] [-Reinstall] [-Upgrade] [-HostVersion <version>|latest]
      [-Spec <npm-name|git-url>]

  First run on a real Windows machine: 2026-10-19, omp 18.12.2 already on PATH
  and a2mcp already registered. DryRun printed the plan and wrote nothing; the
  real run left the host alone and ended on the host's own plugin doctor tick.
  Same day, in-memory execution was proven on that machine too -- in the
  scriptblock form above: the -DryRun plan came out of the raw URL with nothing
  saved to disk, in clean ASCII -- the closing notes are this script's own
  bytes, not the host's. The one-line irm|iex shape has not been run there.
  That exercised the already-installed-host branch. The installer call and the
  models.yml seeding have still never run anywhere. Thirteen items in bun test
  read this file as text against bootstrap.sh; the boundary they set is
  recorded in docs/testing.md, in the subsection of the test:bootstrap section
  named for this script's literal checks -- "the two files agree, and that is
  all it is worth." A syntax error here would still pass every one of them.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall,
    [switch]$Reinstall,
    [switch]$Upgrade,
    [string]$HostVersion = "",
    [string]$Spec = ""
)

# Parity with bootstrap.sh. Keep these four in step with that file: the items in
# test/bootstrap-ps1.test.ts read both scripts and fail when they drift.
$Plugin = "a2mcp"
$DefaultSpec = "https://github.com/adam-ikari/a2mcp.git"
$InstallerUrl = "https://omp.sh/install.ps1"
$PinPackage = "@oh-my-pi/pi-coding-agent"
# bootstrap.sh: the installer's own default, so the path reported is the path
# written to whether or not the caller overrode it. Here that is `$InstallDir`
# below, and it is the same variable the upstream installer reads.
if ($Spec -eq "") { $Spec = $DefaultSpec }

function Fail([string]$Wanted, [string]$Got) {
    Write-Host "FAIL"
    Write-Host "  wanted: $Wanted"
    Write-Host "  got:    $Got"
    exit 1
}

function Warn([string]$Message) {
    Write-Warning $Message
}

# Every write goes through these two, so -DryRun prints the plan and touches
# nothing.
function Plan([string]$Message) {
    Write-Host "plan: $Message"
}

function Run([scriptblock]$Command, [string]$Shown) {
    if ($DryRun) {
        Plan $Shown
    }
    else {
        Write-Host "`$ $Shown"
        & $Command
    }
}

function Test-Command([string]$Name) {
    return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Get-OmpCommand {
    $c = Get-Command -Name "omp" -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $c = Get-Command -Name "omp.exe" -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

# --- prerequisites ---
if (-not $env:USERPROFILE) {
    Fail "USERPROFILE pointing at a directory" "USERPROFILE empty"
}
if (-not (Test-Path -LiteralPath $env:USERPROFILE -PathType Container)) {
    Fail "an existing profile directory" "$($env:USERPROFILE) is not a directory"
}
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
# No tar check here, unlike bootstrap.sh. That script warns because the bridge
# unpacks a `.tar.gz` by running the system tar; the Windows rows in `src/obtain.ts`
# are a zip this repository reads itself and a bare `.exe`, so neither reaches tar
# and a warning about it would be a lie.
#
# PowerShell 5.1 can negotiate an older TLS than GitHub accepts. Pinning the
# protocol is the difference between reading the pin and falling back to latest.
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
}
catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$Omp = Get-OmpCommand

# bootstrap.sh: INSTALLED_HOST. Only the branch that actually runs the official
# installer seeds the placeholder models.yml; a host that was already on PATH
# belongs to a machine with its own model configuration.
$InstalledHost = $false

# --- uninstall: the one path that needs neither git nor a download ---
if ($Uninstall) {
    if (-not $Omp) { Fail "omp on PATH to uninstall the plugin from" "nothing answering for omp in PATH" }
    if ($DryRun) {
        Plan "omp plugin uninstall $Plugin"
        exit 0
    }
    Run { & $Omp plugin uninstall $Plugin } "omp plugin uninstall $Plugin"
    Write-Host ""
    Write-Host "Registration removed. The bridge writes its own config, port and token to"
    Write-Host "  $env:USERPROFILE\.omp\agent\a2mcp.json"
    Write-Host "and its audit log beside it; both are left alone, which is what the README says"
    Write-Host "uninstall does."
    exit 0
}

# --- pin ---
# The repo's devDependency pin is the host version every probe in this repo was
# last run green against, so installing to it is the closest thing to a known-good
# configuration a fresh machine can be put into.
$Pin = ""
$PinSource = "no package.json next to this script and no -HostVersion"

function Read-PinFromJson([string]$Text) {
    # The same one-line read bootstrap.sh does with sed, and the same reason: a
    # range like `^18.0.0` is not an exact pin and must not be used as one.
    $m = [regex]::Match($Text, "`"$PinPackage`"\s*:\s*`"([^`"]+)`"")
    if ($m.Success) { return $m.Groups[1].Value }
    return ""
}

# Parity with bootstrap.sh, including the two shapes it derives a remote manifest
# from: a github URL reads its raw package.json, anything that is not a path or a
# URL reads as an npm name against the registry.
$RemotePkg = ""
if ($Spec -match "^https://github\.com/([^/]+)/([^/]+?)(\.git)?/?$") {
    # GitHub resolves HEAD to the repository's default branch, so this does not
    # hardcode `master` or `main`.
    $RemotePkg = "https://raw.githubusercontent.com/$($Matches[1])/$($Matches[2])/HEAD/package.json"
}
elseif ($Spec -match "^(@[A-Za-z0-9~-][A-Za-z0-9._-]*/)?[A-Za-z0-9~-][A-Za-z0-9._-]*(@[^@/:]+)?$") {
    # Only a syntactic npm name reads as one (names start like the host's own
    # validator says they do): anything else - a path, ssh://, git+, the scp-style
    # host:path form - stays without a guess. A trailing
    # version range is not part of the name the registry keys on, and a scoped
    # name carries its slash percent-encoded.
    # Cut a trailing @version/@tag, but never the leading @ of a scope.
    $npm = ($Spec -replace "(?<!^(@[^/]+))@[^@]*$", "") -replace "/", "%2F"
    $RemotePkg = "https://registry.npmjs.org/$npm/latest"
}

if ($HostVersion -eq "latest") {
    $PinSource = "-HostVersion latest"
}
elseif ($HostVersion) {
    $Pin = $HostVersion
    $PinSource = "-HostVersion"
}
else {
    # `$PSCommandPath` is empty when a script arrives through `iex`, which is the
    # form with no repository next to it. Reading `..\package.json` then would ask
    # for the caller's working directory, not the script's own home.
    $localPkg = ""
    if ($PSCommandPath) {
        $localPkg = Join-Path (Split-Path -Parent $PSCommandPath) "..\package.json"
    }
    if ($localPkg -and (Test-Path -LiteralPath $localPkg -PathType Leaf)) {
        $PinSource = $localPkg
        $Pin = Read-PinFromJson (Get-Content -LiteralPath $localPkg -Raw)
    }
    elseif (-not $Omp) {
        # Without a repo next to the script the pin has to come from the same place
        # the plugin itself will be fetched from. Only when a host has to be
        # installed: with an omp already on PATH nothing here needs a version to
        # compare to, and a check that fetches a file it will not use is not a cheap
        # check.
        if ($RemotePkg) {
            $PinSource = $RemotePkg
            try {
                $body = (Invoke-WebRequest -Uri $RemotePkg -UseBasicParsing -TimeoutSec 20).Content
                $Pin = Read-PinFromJson $body
            }
            catch {
                $Pin = ""
            }
            if (-not $Pin) {
                Warn "no pin readable from $RemotePkg; the host will be installed at latest - pass -HostVersion <version> to choose the host version yourself"
            }
        }
        else {
            $PinSource = "spec '$Spec', which is neither an https://github.com URL nor an npm name to read a package.json from"
        }
    }
}
if ($Pin -and $Pin -notmatch "^\d+\.\d+\.\d+$") {
    Warn "$PinPackage is pinned to '$Pin' in $PinSource, which is not an exact version; the host will be installed at latest instead"
    $Pin = ""
}

# --- host ---
function Install-Host([string]$Version) {
    # The upstream installer's defaults are not deterministic: `-Ref` on its own
    # flips it into a bun source build, and with no switch at all it takes bun
    # whenever bun is installed. Passing `-Binary` every time is what makes this
    # script install the same thing on every machine. Read from
    # https://omp.sh/install.ps1 on 2026-10-19, at the bottom of its main block.
    if ($Version) {
        $shown = "iwr $InstallerUrl | powershell -Command - -Binary -Ref v$Version"
        if ($DryRun) {
            Plan "download $InstallerUrl and run it with -Binary -Ref v$Version"
            return
        }
        Write-Host "`$ iwr $InstallerUrl (-Binary -Ref v$Version)"
        $installer = Invoke-WebRequest -Uri $InstallerUrl -UseBasicParsing
        try {
            & ([scriptblock]::Create($installer.Content)) -Binary -Ref "v$Version"
        }
        catch {
            Fail "the official installer to finish" $_.Exception.Message
        }
    }
    else {
        if ($DryRun) {
            Plan "download $InstallerUrl and run it with -Binary (latest)"
            return
        }
        Write-Host "`$ iwr $InstallerUrl (-Binary)"
        $installer = Invoke-WebRequest -Uri $InstallerUrl -UseBasicParsing
        try {
            & ([scriptblock]::Create($installer.Content)) -Binary
        }
        catch {
            Fail "the official installer to finish" $_.Exception.Message
        }
    }
}

if ($Omp) {
    $hostNow = & $Omp --version 2>&1 | Select-Object -First 1
    Write-Host "omp is already on PATH: $Omp ($hostNow) - left as it is."
    if ($Upgrade) {
        Write-Host "-Upgrade: re-running the official installer, which writes $InstallDir\omp.exe."
        Write-Host "  If the omp above lives somewhere else, that copy stays on PATH in front of"
        Write-Host "  the new one and the upgrade is not what 'omp' resolves to."
        Install-Host $Pin
        Write-Host "  This install type is a prebuilt single-file binary, not a bun global package."
        $Omp = Get-OmpCommand
    }
}
else {
    Write-Host "No omp on PATH. Installing the host first, from the official installer."
    $InstalledHost = $true
    if ($Pin) {
        Write-Host "  pinned to v$Pin (read from $PinSource)"
    }
    else {
        Write-Host "  no pin available from $PinSource - installing latest"
    }
    Install-Host $Pin
    if ($DryRun) {
        Plan "resolve omp for the extension step (PATH, then $InstallDir\omp.exe)"
        Plan "the host arrives as a prebuilt single-file binary at $InstallDir\omp.exe, not a bun global package"
    }
    else {
        $Omp = Get-OmpCommand
        if (-not $Omp -and (Test-Path -LiteralPath "$InstallDir\omp.exe" -PathType Leaf)) {
            # The upstream installer writes Path to the USER environment variable,
            # which a process already running cannot see. Adding it for the rest of
            # this run is the same step bootstrap.sh takes with `PI_INSTALL_DIR`.
            $env:Path = "$InstallDir;$env:Path"
            $Omp = "$InstallDir\omp.exe"
            Warn "$InstallDir is not on this session's PATH; using it for the rest of this run. The installer does write it to your user environment, so a new terminal will find it."
        }
        if (-not $Omp) {
            Fail "an omp answering on PATH after the installer ran" "nothing at omp or $InstallDir\omp.exe"
        }
        Write-Host "  the host is a prebuilt single-file binary at $Omp, not a bun global package"
    }
}
$OmpLabel = if ($Omp) { $Omp } else { "omp" }
if (-not $DryRun -and -not $Omp) { Fail "omp on PATH" "nothing answering for omp in PATH" }

# --- placeholder model for the host this script just installed ---
# Set when the seeding below actually writes the file; the closing notes speak
# from this flag, so a machine the script did not seed is not told it was.
$script:SeededModels = $null
# A machine with no model configuration at all cannot boot the host headless:
# `omp --mode rpc` stops inside createAgentSession, before any extension code
# ever runs. The interactive TUI does come up there, and the bridge fills the
# empty model slot with the same unreachable row (src/auto-model.ts) at
# session_start -- but a file is the only thing that can exist before boot. So
# this writes one, and only on this branch: the host this script installed, on
# a machine that had none. A machine that already had omp keeps its model
# configuration alone -- create-only, and an existing file is not read, not
# touched, not mentioned. The bytes are the extension's own placeholder shape:
# `a2mcp.invalid` is the RFC 6761 reserved domain, nothing under it can resolve
# and no request ever leaves the machine.
function Seed-PlaceholderModels {
    if (-not $InstalledHost) { return }
    $ModelsYml = Join-Path $env:USERPROFILE ".omp\agent\models.yml"
    if (Test-Path -LiteralPath $ModelsYml -PathType Leaf) {
        return
    }
    if ($DryRun) {
        Plan "write $ModelsYml (unreachable placeholder provider $Plugin/offline; create-only)"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ModelsYml) | Out-Null
    # Here-string, not per-line Write-Host: the body is one literal and the
    # parity with bootstrap.sh's heredoc is checked line for line.
    $body = @'
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
'@
    Set-Content -LiteralPath $ModelsYml -Value $body -Encoding ascii
    Write-Host "Wrote $ModelsYml -- an unreachable placeholder provider so the host"
    Write-Host "  boots headless too; it is create-only, and the bridge selects the same"
    Write-Host "  row at session_start even without this file (interactive starts)."
    $script:SeededModels = $ModelsYml
}

Seed-PlaceholderModels

# --- extension ---
function Test-Registered {
    # Reading the host's list is not a write, so -DryRun still asks: the plan is
    # wrong when it says "install" about a machine that already has it.
    if (-not $Omp) { return $false }
    $list = & $Omp plugin list 2>$null | Out-String
    return $list.Contains("$Plugin@")
}

$SkipInstall = $false
if ($Reinstall -and (Test-Registered)) {
    Write-Host "Removing the existing registration first (-Reinstall)."
    Run { & $OmpLabel plugin uninstall $Plugin } "omp plugin uninstall $Plugin"
}
elseif (Test-Registered) {
    Write-Host "$Plugin is already registered - nothing to install (-Reinstall to force it)."
    $SkipInstall = $true
}

if (-not $SkipInstall) {
    # git belongs to the clone the host runs for a URL spec; an npm name resolves
    # through the registry and needs nothing of the sort.
    if (($Spec -match "://|^git\+") -and -not (Test-Command "git")) { Fail "git on PATH (needed to let omp clone $Spec)" "nothing answering for git in PATH" }
    Write-Host "This is the README's one install path, run verbatim:"
    Run { & $OmpLabel install $Spec } "omp install $Spec"
}

# --- verification: the host's own health check, not a second one ---
if ($DryRun) {
    Plan "omp plugin list (look for: $Plugin@)"
    Plan "omp plugin doctor (look for the plugin:$Plugin row)"
    Plan "compare omp --version against the pin"
}
else {
    # Two signals, and the glyph is not one of them. The check-mark the unix doctor
    # prints is what bootstrap.sh keys on, and a Windows console can render it as
    # `?`; `plugin list` carrying `a2mcp@` is the registration fact, stated without a
    # character that depends on a codepage. The doctor row is then read for what it
    # says, not for its icon.
    $list = & $Omp plugin list 2>&1 | Out-String
    $listRow = ($list -split "`n" | Where-Object { $_ -like "*$Plugin@*" } | Select-Object -First 1)
    if (-not $listRow) {
        Write-Host $list
        Fail "a registration listed by the host (a '$Plugin@' row in omp plugin list)" "no such row"
    }
    Write-Host "plugin list: $($listRow.Trim())"

    $doctor = & $Omp plugin doctor 2>&1 | Out-String
    $row = ($doctor -split "`n" | Where-Object { $_ -like "*plugin:$Plugin*" } | Select-Object -First 1)
    if (-not $row) {
        Write-Host $doctor
        Fail "a plugin:$Plugin row from omp plugin doctor" "no such row at all"
    }
    if ($row -match "(?i)\b(fail|failed|error|broken|missing|invalid)\b") {
        Write-Host $doctor
        Fail "a clean plugin:$Plugin row from omp plugin doctor" $row.Trim()
    }
    Write-Host "plugin doctor: $($row.Trim())"

    $hostNow = & $Omp --version 2>&1 | Select-Object -First 1
    if ($Pin -and "$hostNow" -notlike "*$Pin*") {
        Warn "the host reports $hostNow while this repo pins $Pin - test/versions.test.ts is the guard that fails on the maintainer's machine for the same reason"
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "That was the plan - nothing above was written. From here:"
}
else {
    Write-Host "Done. From here:"
}
Write-Host "  * With no model configured the bridge still comes up: at session_start it"
Write-Host "    selects an unreachable placeholder ($Plugin/offline), so the host's own"
Write-Host "    prompts fail as connection errors instead of stopping everything. Real"
Write-Host "    inference needs /login or /model. Headless (--mode rpc) starts cannot get"
if ($script:SeededModels) {
    Write-Host "    that far without a models.yml: this script wrote one at"
    Write-Host "    $($script:SeededModels). The README's troubleshooting section has the shape."
} else {
    Write-Host "    that far without a models.yml. This script wrote no such file here - it"
    Write-Host "    writes one only when it installs the host itself on a machine with none."
    Write-Host "    The README's troubleshooting section has the shape."
}
Write-Host "  * On the first session_start the bridge writes its own config to"
Write-Host "    $env:USERPROFILE\.omp\agent\a2mcp.json - random port, 43-character token."
Write-Host "    Don't create that file by hand."
Write-Host "  * The host announces the endpoint in its notification bar; point an MCP client"
Write-Host "    at it from there."
Write-Host "  * The host checks for its own updates at startup by default, so 'installed at"
Write-Host "    the pinned version' is not 'stays at the pinned version'."
Write-Host "  * xfer installs dufs and cloudflared under %LOCALAPPDATA%\a2mcp\bin on"
Write-Host "    Windows. The config file's 0600 mode is a POSIX bit and is ignored here;"
Write-Host "    what protects the token on Windows is the profile directory's own ACL."
