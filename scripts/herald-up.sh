#!/usr/bin/env bash
# Starts Herald (the Lorebase MCP server, Streamable HTTP) next to the Keeper started by
# lorebase-up.sh, from the same backend image, on 127.0.0.1:${HERALD_HOST_PORT:-8190}/mcp.
# Agents read the world through it (read tools only, enforced by the game server).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${LOREBASE_ENV_FILE:-$ROOT/deploy/lorebase.env}"
PROJECT="${LOREBASE_COMPOSE_PROJECT:-civ-lorebase}"
NAME="${HERALD_CONTAINER:-civ-herald}"
PORT="${HERALD_HOST_PORT:-8190}"
DOMAIN="${LOREBASE_DOMAIN:-world}"
[ -f "$ENV_FILE" ] || { echo "run npm run lorebase:up first ($ENV_FILE missing)" >&2; exit 1; }
TAG="$(grep -E '^LOREBASE_TAG=' "$ENV_FILE" | cut -d= -f2)"; TAG="${TAG:-civ-demo}"

case "${1:-up}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" --network "${PROJECT}_default" -p "127.0.0.1:${PORT}:8090" \
      -e LOREBASE_URL=http://keeper:8080 -e LOREBASE_DOMAIN="$DOMAIN" -e LOREBASE_BRANCH="${LOREBASE_BRANCH:-main}" \
      -e LOREBASE__HERALD__TRANSPORT=streamable_http -e LOREBASE__HERALD__HTTP__HOST=0.0.0.0 \
      -e LOREBASE__HERALD__HTTP__ALLOWED_HOSTS="[\"127.0.0.1:${PORT}\",\"localhost:${PORT}\"]" \
      "lorebase:$TAG" python -m lorebase_herald >/dev/null
    for _ in $(seq 1 30); do
      if curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{}' | grep -qE '^(200|400|401|406)$'; then
        echo "Herald ready on http://127.0.0.1:${PORT}/mcp"; exit 0
      fi
      sleep 1
    done
    echo "Herald did not start; see: docker logs $NAME" >&2; exit 1 ;;
  down) docker rm -f "$NAME" ;;
  logs) docker logs --tail 100 "$NAME" ;;
  *) echo "usage: $0 [up|down|logs]" >&2; exit 2 ;;
esac
