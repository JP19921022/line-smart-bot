#!/usr/bin/env bash
# Tier-2 #9-C: 安裝本地 git hooks
# 用 git config core.hooksPath 方式設定 — 這樣 hooks 是追版本的，不是各人自己維護
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.githooks"

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo "❌ 找不到 $HOOKS_DIR"
  exit 1
fi

# 確保所有 hook script 可執行
chmod +x "$HOOKS_DIR"/* 2>/dev/null || true

# 指向 repo 內的 hooks（取代各自 .git/hooks）
git config --local core.hooksPath .githooks

echo "✅ git hooks 已設定。commit 前會自動 node --check"
echo "   hooks path: $(git config --local core.hooksPath)"
echo
echo "停用（臨時）：git commit --no-verify"
echo "停用（永久）：git config --local --unset core.hooksPath"
