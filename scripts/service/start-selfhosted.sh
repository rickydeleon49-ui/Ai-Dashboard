#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_DIR"

# Load optional .env.selfhosted next to the repo root
if [ -f "$REPO_DIR/.env.selfhosted" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_DIR/.env.selfhosted"
  set +a
elif [ -f "$REPO_DIR/../.env.selfhosted" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_DIR/../.env.selfhosted"
  set +a
fi

# Refuse to start if AGENT_HOST_MODE is not self-hosted
if [ "${AGENT_HOST_MODE:-}" != "self-hosted" ]; then
  echo "Error: AGENT_HOST_MODE must be set to 'self-hosted' (current: '${AGENT_HOST_MODE:-}')" >&2
  exit 1
fi

# Refuse to start if HOSTNAME is unset
if [ -z "${HOSTNAME:-}" ]; then
  echo "Error: HOSTNAME must be set (e.g. HOSTNAME=127.0.0.1)" >&2
  exit 1
fi

# Refuse binding to wildcard/all-interface addresses
if [ "$HOSTNAME" = "0.0.0.0" ] || [ "$HOSTNAME" = "::" ]; then
  echo "Error: Refusing to bind to wildcard host ($HOSTNAME). Bind to 127.0.0.1 or a private/Tailscale IP." >&2
  exit 1
fi

# Private or LAN addresses require AGENT_HOST_ALLOW_LAN=1
if [ "$HOSTNAME" != "127.0.0.1" ] && [ "$HOSTNAME" != "localhost" ] && [ "$HOSTNAME" != "::1" ] && [ "${AGENT_HOST_ALLOW_LAN:-0}" != "1" ]; then
  echo "Error: HOSTNAME '$HOSTNAME' is non-loopback. Set AGENT_HOST_ALLOW_LAN=1 to permit LAN/Tailscale binding." >&2
  exit 1
fi

PORT="${PORT:-3000}"

RUNNER_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [ -n "$RUNNER_PID" ] && kill -0 "$RUNNER_PID" 2>/dev/null; then
    echo "Stopping agent runner (PID $RUNNER_PID)..."
    kill -TERM "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

# Start agent runner in background
npm run runner &
RUNNER_PID=$!

# Start Next.js server in foreground
npm run start -- -H "$HOSTNAME" -p "${PORT:-3000}"
