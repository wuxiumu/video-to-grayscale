#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
fail(){ echo "✗ $1" >&2; exit 1; }; ok(){ echo "✓ $1"; }
command -v node >/dev/null || fail "需要 Node"
[[ -f package.json && -f src/cli.js ]] || fail "缺少 CLI"
[[ -f .env.example ]] || fail "缺少 .env.example"
ok "核心文件齐全"
[[ -d node_modules ]] || npm install --no-fund --no-audit
npm run check
ok "npm run check 通过"
echo ""; echo "smoke: ok"
