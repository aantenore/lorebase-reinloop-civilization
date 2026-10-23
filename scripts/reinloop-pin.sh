#!/usr/bin/env bash
# Pin reinloop to a committed snapshot: vendor/reinloop-<shortsha>.tgz + package.json dependency.
# Usage: npm run reinloop:pin -- [path-to-reinloop-checkout] [sha]   (defaults: ../reinloop, its HEAD)
# Only committed history is used (git archive), never the working tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/../reinloop}"
SRC="$(cd "$SRC" && pwd)"
SHA="$(git -C "$SRC" rev-parse "${2:-HEAD}")"
SHORT="${SHA:0:8}"
OUT="vendor/reinloop-$SHORT.tgz"
if [ -n "$(git -C "$SRC" status --porcelain)" ]; then
  echo "[pin] $SRC has uncommitted changes: they are ignored, snapshot of $SHORT" >&2
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$SRC" archive "$SHA" | tar -x -C "$WORK"
(cd "$WORK" && npm install --no-audit --no-fund --silent && npm run build --silent && npm pack --silent >/dev/null)
mkdir -p "$ROOT/vendor"
cp "$WORK"/reinloop-*.tgz "$ROOT/$OUT"
node -e '
const fs = require("fs"); const p = process.argv[1]; const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.dependencies.reinloop = "file:" + process.argv[2]; fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$ROOT/package.json" "$OUT"
(cd "$ROOT" && npm install --no-audit --no-fund --silent)
echo "[pin] reinloop $SHORT -> $OUT ($(du -h "$ROOT/$OUT" | cut -f1)); remove older vendor/reinloop-*.tgz if unused"
