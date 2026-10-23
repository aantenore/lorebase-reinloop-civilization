#!/usr/bin/env bash
# Starts Postgres + migrations + Keeper from the Lorebase repository's compose file, with
# this project's env file (generated with random passwords when missing) and override.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOREBASE_REPO="${LOREBASE_REPO:-$ROOT/../lorebase}"
ENV_FILE="${LOREBASE_ENV_FILE:-$ROOT/deploy/lorebase.env}"
PROJECT="${LOREBASE_COMPOSE_PROJECT:-civ-lorebase}"
COMPOSE_FILE="$LOREBASE_REPO/deploy/compose/docker-compose.yaml"

[ -f "$COMPOSE_FILE" ] || { echo "Lorebase compose file not found: $COMPOSE_FILE (set LOREBASE_REPO)" >&2; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
LOREBASE_APP_PASSWORD=$(openssl rand -hex 24)
LOREBASE_TAG=${LOREBASE_TAG:-civ-demo}
KEEPER_HOST_PORT=${KEEPER_HOST_PORT:-8180}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT:-5443}
LOREBASE_CONFIG_FILE=$LOREBASE_REPO/config/lorebase.example.yaml
ENV
  echo "generated $ENV_FILE"
fi

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$ROOT/deploy/compose.override.yaml" "$@"; }

case "${1:-up}" in
  up)
    TAG="$(grep -E '^LOREBASE_TAG=' "$ENV_FILE" | cut -d= -f2)"; TAG="${TAG:-civ-demo}"
    # Build the backend image from the Lorebase checkout once (or with REBUILD=1).
    if [ "${REBUILD:-0}" = 1 ] || ! docker image inspect "lorebase:$TAG" >/dev/null 2>&1; then compose build migrate; fi
    compose up -d postgres migrate keeper
    PORT="$(grep -E '^KEEPER_HOST_PORT=' "$ENV_FILE" | cut -d= -f2)"; PORT="${PORT:-8180}"
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:$PORT/readyz" >/dev/null 2>&1; then echo "Keeper ready on http://127.0.0.1:$PORT"; exit 0; fi
      sleep 2
    done
    echo "Keeper did not become ready; see: docker compose -p $PROJECT logs keeper" >&2; exit 1 ;;
  down) compose down ;;
  destroy) compose down -v ;;
  ps) compose ps ;;
  logs) compose logs --tail 100 keeper ;;
  *) echo "usage: $0 [up|down|destroy|ps|logs]" >&2; exit 2 ;;
esac
