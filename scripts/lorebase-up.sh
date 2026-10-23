#!/usr/bin/env bash
# Starts Postgres + migrations + Keeper (and, on request, Herald: compose profile `mcp`) from the
# Lorebase repository's compose file. Two env files: deploy/lorebase.settings.env (committed demo
# settings) and deploy/lorebase.env (local secrets and ports, generated when missing; missing
# secrets are appended to an existing one).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOREBASE_REPO="${LOREBASE_REPO:-$ROOT/../lorebase}"
ENV_FILE="${LOREBASE_ENV_FILE:-$ROOT/deploy/lorebase.env}"
SETTINGS_FILE="${LOREBASE_SETTINGS_FILE:-$ROOT/deploy/lorebase.settings.env}"
PROJECT="${LOREBASE_COMPOSE_PROJECT:-civ-lorebase}"
COMPOSE_FILE="$LOREBASE_REPO/deploy/compose/docker-compose.yaml"

[ -f "$COMPOSE_FILE" ] || { echo "Lorebase compose file not found: $COMPOSE_FILE (set LOREBASE_REPO)" >&2; exit 1; }

umask 077
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
LOREBASE_TAG=${LOREBASE_TAG:-civ-demo}
KEEPER_HOST_PORT=${KEEPER_HOST_PORT:-8180}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT:-5443}
LOREBASE_CONFIG_FILE=$LOREBASE_REPO/config/lorebase.example.yaml
ENV
  echo "generated $ENV_FILE"
fi
# Secrets required by the compose file (NAME:random bytes, hex encoded), added when absent.
for entry in POSTGRES_PASSWORD:24 LOREBASE_APP_PASSWORD:24 LOREBASE_WEBHOOK_KEY:32; do
  name="${entry%%:*}"
  if ! grep -qE "^${name}=.+" "$ENV_FILE"; then
    echo "${name}=$(openssl rand -hex "${entry##*:}")" >> "$ENV_FILE"
    echo "added $name to $ENV_FILE"
  fi
done

value() { cat "$SETTINGS_FILE" "$ENV_FILE" 2>/dev/null | grep -E "^$1=" | tail -n1 | cut -d= -f2-; }
# The local env file comes last, so it can override the committed settings.
compose() { docker compose -p "$PROJECT" --env-file "$SETTINGS_FILE" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

wait_for() { # url, tries, accepted status regex
  for _ in $(seq 1 "$2"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X "${4:-GET}" "$1" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ${4:+-d '{}'} || true)"
    if echo "$code" | grep -qE "$3"; then return 0; fi
    sleep 2
  done
  return 1
}

case "${1:-up}" in
  up)
    # Images are rebuilt from the Lorebase checkout on every up (pull_policy build, cached layers).
    compose up -d postgres migrate keeper
    PORT="$(value KEEPER_HOST_PORT)"; PORT="${PORT:-8180}"
    if wait_for "http://127.0.0.1:$PORT/readyz" 60 '^200$'; then echo "Keeper ready on http://127.0.0.1:$PORT"; exit 0; fi
    echo "Keeper did not become ready; see: $0 logs" >&2; exit 1 ;;
  herald)
    compose --profile mcp up -d herald
    PORT="$(value HERALD_HOST_PORT)"; PORT="${PORT:-8091}"
    if wait_for "http://127.0.0.1:$PORT/mcp" 30 '^(200|400|401|406)$' POST; then echo "Herald ready on http://127.0.0.1:$PORT/mcp"; exit 0; fi
    echo "Herald did not start; see: $0 herald-logs" >&2; exit 1 ;;
  herald-down) compose --profile mcp rm -sf herald ;;
  herald-logs) compose --profile mcp logs --tail 100 herald ;;
  down) compose --profile mcp down ;;
  destroy) compose --profile mcp down -v ;;
  ps) compose --profile mcp ps ;;
  logs) compose logs --tail 100 migrate keeper ;;
  *) echo "usage: $0 [up|herald|herald-down|herald-logs|down|destroy|ps|logs]" >&2; exit 2 ;;
esac
