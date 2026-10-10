#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
fail(){ echo "✗ $1" >&2; exit 1; }; ok(){ echo "✓ $1"; }
command -v node >/dev/null || fail "需要 Node"
[[ -f package.json && -f src/cli.js ]] || fail "缺少 CLI"
[[ -f .env.example ]] || fail "缺少 .env.example"
ok "核心文件齐全"
node --check src/cli.js
ok "cli.js 语法 OK"
# doctor 若存在则跑（不强制 tests/ 目录）
if npm run | grep -q " doctor"; then
  npm run doctor >/tmp/vtg-doctor.out 2>&1 && ok "doctor 通过" || echo "⚠ doctor 有告警（见 /tmp/vtg-doctor.out）"
fi
echo ""; echo "smoke: ok"
