#!/usr/bin/env bash
# One-command setup for a clean clone. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

say() { printf "▸ %s\n" "$*"; }
fail() { printf "✗ %s\n" "$*" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install 22 or newer from https://nodejs.org"
fi
NODE_MAJOR="$(node -p "parseInt(process.versions.node, 10)")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js $(node -v) is too old. Install 22+ from https://nodejs.org"
fi
say "Node $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not on PATH. Reinstall Node from https://nodejs.org (it includes npm)."
fi

say "npm install"
npm install

if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    fail ".env.example is missing from the repo — cannot create .env"
  fi
  cp .env.example .env
  chmod 600 .env
  say "Created .env from .env.example"
else
  say ".env already present"
fi

set_env_key() {
  local name="$1" value="$2"
  if grep -q "^${name}=" .env; then
    local tmp
    tmp="$(mktemp)"
    awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n {$0=n"="v} {print}' .env > "$tmp"
    mv "$tmp" .env
  else
    printf "%s=%s\n" "$name" "$value" >> .env
  fi
  chmod 600 .env
}

current_key="$(grep -E '^OPENROUTER_API_KEY=' .env | head -1 | cut -d= -f2- || true)"
needs_key=1
case "$current_key" in
  ""|"sk-or-..."|"sk-ant-..."|*placeholder*|*your-key*) needs_key=1 ;;
  *) needs_key=0 ;;
esac

if [ "$needs_key" -eq 1 ] && [ -t 0 ]; then
  printf "OpenRouter API key (https://openrouter.ai/keys)\n"
  printf "Paste sk-or-... or press Enter to skip: "
  # -s so the key never echoes. A leaked paste in the scrollback is how keys die.
  IFS= read -r -s KEY || true
  printf "\n"
  if [ -n "${KEY:-}" ]; then
    set_env_key OPENROUTER_API_KEY "$KEY"
    say "Wrote OPENROUTER_API_KEY to .env"
  else
    say "Skipped. Add OPENROUTER_API_KEY=sk-or-... to .env before the first run."
  fi
elif [ "$needs_key" -eq 1 ]; then
  say "No TTY — add OPENROUTER_API_KEY=sk-or-... to .env (https://openrouter.ai/keys)"
fi

if [ -x ./setup-voice.sh ] && [ -t 0 ]; then
  printf "Install the offline Piper voice now (~60MB)? [y/N] "
  IFS= read -r VOICE_ANS || true
  case "$VOICE_ANS" in
    y|Y|yes|YES)
      ./setup-voice.sh || say "Voice setup failed — you can run ./setup-voice.sh later."
      ;;
    *) say "Skipped voice. Run ./setup-voice.sh when you want CUNNING CLAW to speak." ;;
  esac
fi

say "npm run doctor"
set +e
npm run doctor
DOCTOR_EXIT=$?
set -e
if [ "$DOCTOR_EXIT" -ne 0 ]; then
  
# Personal workspace files are per-install, so seed them from the templates.
for f in USER MEMORY; do
  if [ ! -f "workspace/$f.md" ] && [ -f "workspace/$f.md.example" ]; then
    cp "workspace/$f.md.example" "workspace/$f.md"
    say "Created workspace/$f.md — edit it so it knows who you are."
  fi
done

say "Doctor reported essential problems (see ✗ lines). Fix those before starting."
fi

install_user_unit() {
  local dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$dest"
  local npm_bin node_dir
  npm_bin="$(command -v npm)"
  node_dir="$(dirname "$(command -v node)")"
  # Escape \ and & for sed replacement, keep spaces — the unit quotes WorkingDirectory.
  local root_esc path_esc npm_esc
  root_esc="$(printf '%s' "$ROOT" | sed -e 's/[&\\]/\\&/g')"
  npm_esc="$(printf '%s' "$npm_bin" | sed -e 's/[&\\]/\\&/g')"
  path_esc="$(printf '%s' "$node_dir:/usr/local/bin:/usr/bin:/bin" | sed -e 's/[&\\]/\\&/g')"
  sed -e "s|@@ROOT@@|$root_esc|g" \
      -e "s|@@NPM@@|$npm_esc|g" \
      -e "s|@@PATH@@|$path_esc|g" \
      packaging/cunningclaw.service > "$dest/cunningclaw.service"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  say "Installed $dest/cunningclaw.service"
}

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if [ -t 0 ]; then
    printf "Install a systemd --user unit so CUNNING CLAW starts at login? [y/N] "
    IFS= read -r UNIT_ANS || true
    case "$UNIT_ANS" in
      y|Y|yes|YES) install_user_unit ;;
      *) say "Skipped autostart." ;;
    esac
  else
    say "systemd is available. To autostart: ./install.sh on a TTY, or copy packaging/cunningclaw.service yourself."
  fi
fi

cat <<EOF

────────────────────────────────────────
CUNNING CLAW is installed.

Start now:
  npm run dev
  then open http://127.0.0.1:3900

Survive a closed terminal and a reboot (Linux, systemd --user):
  systemctl --user enable --now cunningclaw
  loginctl enable-linger \$USER     # so it comes back after logout

The unit is a *user* service on purpose: it needs your session for
X11/Wayland, audio, and Chrome. Do not install it with sudo.

Diagnose later:
  npm run doctor
────────────────────────────────────────
EOF
