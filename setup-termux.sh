#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

# WaNexus Studio — Termux Interactive Env Setup & Auto-Launcher
# Run inside project folder: bash setup-termux.sh

ENV_FILE=".env"

echo "=================================================="
echo "  WaNexus Studio — Termux Setup & Env Manager"
echo "=================================================="

# 1. Install Termux system packages if running inside Termux
if command -v pkg >/dev/null 2>&1; then
  if ! command -v node >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
    echo "[1/4] Updating Termux & installing Node.js + Git..."
    pkg update -y && pkg upgrade -y
    pkg install -y nodejs-lts git unzip
  fi
fi

# 2. Ensure .env exists
if [ ! -f "$ENV_FILE" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

# Helper to read current configured status (returns SET or EMPTY without printing secrets)
check_var_status() {
  node -e '
    const fs = require("fs");
    const dotenv = require("dotenv");
    const key = process.argv[1];
    const parsed = fs.existsSync(".env") ? dotenv.parse(fs.readFileSync(".env", "utf8")) : {};
    const val = (parsed[key] || "").trim();
    const isPlaceholder = !val || val === "MY_GEMINI_API_KEY" || val === "MY_APP_URL" || val.startsWith("YOUR_");
    process.stdout.write(isPlaceholder ? "EMPTY" : "SET");
  ' "$1" 2>/dev/null || echo "EMPTY"
}

# Helper to safely upsert key=value into .env (handles JSON, spaces, quotes cleanly)
upsert_env_var() {
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    const val = process.argv[2];
    const envPath = ".env";
    const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const lines = raw.split(/\r?\n/);
    const serialized = `${key}=${JSON.stringify(val)}`;
    let replaced = false;
    const out = lines.map((line) => {
      if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
        replaced = true;
        return serialized;
      }
      return line;
    });
    if (!replaced) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(serialized);
    }
    fs.writeFileSync(envPath, out.join("\n"), { mode: 0o600 });
  ' "$1" "$2"
}

prompt_one_var() {
  local key="$1"
  local desc="$2"
  local status
  status=$(check_var_status "$key")
  echo ""
  echo "[$key] — Current: $status"
  echo "  $desc"
  printf "  Enter value (or press Enter to keep current): "
  local input=""
  IFS= read -r input
  if [ -n "$input" ]; then
    upsert_env_var "$key" "$input"
    echo "  -> Saved $key cleanly to .env"
  else
    echo "  -> Kept existing value."
  fi
}

KEYS=(
  "GEMINI_API_KEY_1|Primary Gemini API Key (slot 1)"
  "GEMINI_API_KEY_2|Gemini Pool Key slot 2 (optional)"
  "GEMINI_API_KEY_3|Gemini Pool Key slot 3 (optional)"
  "GEMINI_API_KEY_4|Gemini Pool Key slot 4 (optional)"
  "GEMINI_API_KEY_5|Gemini Pool Key slot 5 (optional)"
  "OPENROUTER_API_KEY|OpenRouter Free Pool API Key (memory + agent fallback)"
  "TAVILY_API_KEY|Tavily Search API Key (optional web research)"
  "SERPER_API_KEY|Serper Google Search Key (optional web research)"
  "FIREBASE_SERVICE_ACCOUNT_JSON|Single-line Service Account JSON for project gen-lang-client-0860563178"
  "OWNER_EMAIL|Owner Gmail for Dashboard Login Lock (default: ifxnoteedge81@gmail.com)"
  "DASHBOARD_PIN|4-8 digit 2FA PIN for Dashboard Security (optional)"
  "RESEND_API_KEY|Resend HTTP Email API Key (optional)"
  "BREVO_API_KEY|Brevo HTTP Email API Key (optional)"
  "ENABLE_SELF_PING|Keep-Alive Self-Ping every 4m (true/false, default: true)"
  "PORT|HTTP Dashboard Port (default: 3000)"
)

run_step_by_step_env() {
  echo ""
  echo "Entering values one-by-one. Press Enter to skip any key."
  for entry in "${KEYS[@]}"; do
    local key="${entry%%|*}"
    local desc="${entry#*|}"
    prompt_one_var "$key" "$desc"
  done
  upsert_env_var "NODE_ENV" "production"
  echo ""
  echo "All selected environment variables saved safely into .env!"
}

run_single_var_menu() {
  while true; do
    echo ""
    echo "--- Select a variable to set/update ---"
    local i=1
    for entry in "${KEYS[@]}"; do
      local key="${entry%%|*}"
      local st
      st=$(check_var_status "$key")
      printf "  %2d) %-32s [%s]\n" "$i" "$key" "$st"
      i=$((i + 1))
    done
    echo "   0) Done / Back to main menu"
    printf "Choose number: "
    local choice=""
    IFS= read -r choice
    if [ "$choice" = "0" ] || [ -z "$choice" ]; then
      break
    fi
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#KEYS[@]}" ]; then
      local selected="${KEYS[$((choice - 1))]}"
      prompt_one_var "${selected%%|*}" "${selected#*|}"
    else
      echo "Invalid choice."
    fi
  done
}

build_project_if_needed() {
  if [ ! -d "node_modules" ]; then
    echo ""
    echo "[2/4] Installing npm packages..."
    npm install --include=dev
  fi
  if [ ! -f "dist/index.html" ]; then
    echo ""
    echo "[3/4] Building production PWA dashboard..."
    npm run build
  fi
}

start_server_now() {
  build_project_if_needed
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock || true
  fi
  echo ""
  echo "[4/4] Starting WaNexus Studio..."
  echo "Open browser -> http://localhost:${PORT:-3000}"
  echo "Press CTRL+C anytime to stop the server."
  echo ""
  NODE_ENV=production npx tsx server.ts
}

if [ "${1:-}" = "--env-only" ]; then
  run_single_var_menu
  exit 0
fi

while true; do
  echo ""
  echo "What would you like to do?"
  echo "  1) Set / update environment variables ONE BY ONE (Guided)"
  echo "  2) Update a SINGLE environment variable from list"
  echo "  3) Install packages & build production bundle"
  echo "  4) Start WaNexus Server now (http://localhost:3000)"
  echo "  0) Exit"
  printf "Select option [1-4/0]: "
  IFS= read -r opt
  case "$opt" in
    1) run_step_by_step_env ;;
    2) run_single_var_menu ;;
    3)
      echo "Installing dependencies & rebuilding..."
      npm install --include=dev && npm run build
      echo "Build complete!"
      ;;
    4) start_server_now ;;
    0) exit 0 ;;
    *) echo "Invalid option, please choose 1, 2, 3, 4, or 0." ;;
  esac
done
