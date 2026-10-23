#!/usr/bin/env bash
# Herald (the Lorebase MCP server) from the upstream compose profile `mcp`, next to the Keeper
# started by lorebase-up.sh. Agents read the world through it (read tools only, enforced by the
# game server).
set -euo pipefail
case "${1:-up}" in
  up) exec bash "$(dirname "${BASH_SOURCE[0]}")/lorebase-up.sh" herald ;;
  down) exec bash "$(dirname "${BASH_SOURCE[0]}")/lorebase-up.sh" herald-down ;;
  logs) exec bash "$(dirname "${BASH_SOURCE[0]}")/lorebase-up.sh" herald-logs ;;
  *) echo "usage: $0 [up|down|logs]" >&2; exit 2 ;;
esac
