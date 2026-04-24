#!/usr/bin/env bash
# Tier-2 #8-C: 安裝 launchd 服務，Mac 開機後自動啟動 dashboard
# 用法：bash install.sh
set -euo pipefail

LABEL="com.junfeng.linebot-dashboard"
SRC_PLIST="$(cd "$(dirname "$0")" && pwd)/${LABEL}.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST_PLIST="$DEST_DIR/${LABEL}.plist"

if [[ ! -f "$SRC_PLIST" ]]; then
  echo "❌ 找不到 plist: $SRC_PLIST"
  exit 1
fi

NODE_BIN=$(command -v node || true)
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ 找不到 node，請先安裝 Node.js"
  exit 1
fi

mkdir -p "$DEST_DIR"

# 把 __HOME__ 換成真實 $HOME，node 路徑也補上
sed -e "s|__HOME__|$HOME|g" \
    -e "s|/usr/local/bin/node|$NODE_BIN|g" \
    "$SRC_PLIST" > "$DEST_PLIST"

echo "📝 已寫入 $DEST_PLIST"

# 如果已經載入過，先卸再載
if launchctl list | grep -q "$LABEL"; then
  echo "♻️  卸載舊的 $LABEL"
  launchctl unload "$DEST_PLIST" 2>/dev/null || true
fi

echo "🚀 載入 $LABEL"
launchctl load -w "$DEST_PLIST"

sleep 2
if launchctl list | grep -q "$LABEL"; then
  echo "✅ 安裝完成。dashboard 會在開機後自動啟動在 http://127.0.0.1:3977"
  echo "   日誌：/tmp/junfeng-linebot-dashboard.{out,err}.log"
  echo
  echo "停用指令："
  echo "   launchctl unload -w $DEST_PLIST"
else
  echo "⚠️  launchctl list 找不到 $LABEL，檢查 /tmp/junfeng-linebot-dashboard.err.log"
  exit 1
fi
