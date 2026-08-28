# One-command setup for a clean clone on Windows. Safe to re-run.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Mirrors install.sh: check Node, npm install, create .env, ask for the
# OpenRouter key without echoing it, seed the workspace, run the doctor.
# No systemd here and no Piper voice yet — he types on Windows for now.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Say([string]$m)  { Write-Host ("  - " + $m) }
function Fail([string]$m) { Write-Host ("  x " + $m) -ForegroundColor Red; exit 1 }

# --- Node 22+ ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js is not installed. Install 22 or newer from https://nodejs.org"
}
$major = [int](node -p "parseInt(process.versions.node, 10)")
if ($major -lt 22) { Fail "Node.js $(node -v) is too old. Install 22+ from https://nodejs.org" }
Say "Node $(node -v)"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm is not on PATH. Reinstall Node from https://nodejs.org (it includes npm)."
}

# --- Dependencies -----------------------------------------------------------
Say "npm install"
npm install
if ($LASTEXITCODE -ne 0) { Fail "npm install failed - read the output above." }

# --- .env -------------------------------------------------------------------
if (-not (Test-Path .env)) {
  if (-not (Test-Path .env.example)) { Fail ".env.example is missing from the repo - cannot create .env" }
  Copy-Item .env.example .env
  Say "Created .env from .env.example"
} else {
  Say ".env already present"
}

function Set-EnvKey([string]$name, [string]$value) {
  $lines = @(Get-Content .env)
  if ($lines -match "^$name=") {
    $lines = $lines | ForEach-Object { if ($_ -match "^$name=") { "$name=$value" } else { $_ } }
  } else {
    $lines += "$name=$value"
  }
  Set-Content -Path .env -Value $lines
}

$current = @(Get-Content .env) | Where-Object { $_ -match "^OPENROUTER_API_KEY=" } | Select-Object -First 1
$current = if ($current) { $current.Substring("OPENROUTER_API_KEY=".Length) } else { "" }
$needsKey = ($current -eq "" -or $current -eq "sk-or-..." -or
             $current -like "*placeholder*" -or $current -like "*your-key*")

if ($needsKey) {
  Write-Host "OpenRouter API key (https://openrouter.ai/keys)"
  # -AsSecureString so the key never echoes. A paste in the scrollback is how keys die.
  $secure = Read-Host "Paste sk-or-... or press Enter to skip" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $key  = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  if ($key) {
    Set-EnvKey "OPENROUTER_API_KEY" $key
    Say "Wrote OPENROUTER_API_KEY to .env"
  } else {
    Say "Skipped. Add OPENROUTER_API_KEY=sk-or-... to .env before the first run."
  }
}

# --- Workspace --------------------------------------------------------------
# Personal workspace files are per-install, so seed them from the templates.
foreach ($f in @("USER", "MEMORY")) {
  if (-not (Test-Path "workspace/$f.md") -and (Test-Path "workspace/$f.md.example")) {
    Copy-Item "workspace/$f.md.example" "workspace/$f.md"
    Say "Created workspace/$f.md - edit it so it knows who you are."
  }
}

Say "Voice: the offline Piper voice is Linux/macOS for now (setup-voice.sh). On Windows he types."

# --- Doctor -----------------------------------------------------------------
Say "npm run doctor"
npm run doctor
if ($LASTEXITCODE -ne 0) {
  Say "Doctor reported essential problems (see x lines). Fix those before starting."
}

Write-Host ""
Write-Host "----------------------------------------------"
Write-Host " CUNNING CLAW is installed."
Write-Host ""
Write-Host " Start now:"
Write-Host "   npm run dev"
Write-Host "   then open http://127.0.0.1:3900"
Write-Host ""
Write-Host " Windows support is young. npm run doctor names"
Write-Host " anything missing - please report what you find."
Write-Host "----------------------------------------------"
