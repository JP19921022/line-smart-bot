#!/usr/bin/env bash
# Tier-2 #9-C 幫手：安全清除 .git/index.lock
#
# 用法：bash scripts/git-unlock.sh
#
# 只有當「沒有其他 git 進程在跑」且「lock 檔超過 10 秒沒動」時才會刪。
# 避免誤殺正在跑的 git。
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
LOCK="$REPO_ROOT/.git/index.lock"

if [[ ! -f "$LOCK" ]]; then
  echo "✅ 沒有 .git/index.lock，無需處理"
  exit 0
fi

# 檢查是否有 git 進程在跑
if pgrep -f "git\b" > /dev/null 2>&1; then
  echo "⚠️  偵測到 git 進程正在跑："
  pgrep -lf "git\b" | head -5
  echo
  echo "請先等它結束，或確認那些進程是不是卡住的 git。"
  echo "若真的卡住：pkill -f 'git\\b' 然後再跑這個 script。"
  exit 1
fi

# 檢查 lock 檔年齡
AGE_SEC=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null) ))
if [[ $AGE_SEC -lt 10 ]]; then
  echo "⚠️  lock 檔只有 $AGE_SEC 秒前才建立，可能還在用，先等等"
  exit 1
fi

rm -f "$LOCK"
echo "✅ 已清除 $LOCK (閒置 $AGE_SEC 秒)"
echo
echo "📎 根因排查：如果常常要跑這個 script，通常是："
echo "   1) VSCode/Cursor 的 git 整合 (disable Git: Autofetch / 關掉 git plugin)"
echo "   2) GitHub Desktop / Fork / SourceTree 在背景打開"
echo "   3) iCloud / Dropbox 同步到 .git 目錄 (排除 .git/)"
