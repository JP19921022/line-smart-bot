#!/bin/bash
# Tier-1/2 contacts.json 每日備份 + 保留策略
#
# 策略：
#   * 每次執行都複製當天一份 contacts-YYYYMMDD-HHMMSS.json
#   * contacts-latest.json 永遠是最新
#   * 保留最近 30 天；超過的自動刪除
#   * 保留最近 60 天內的「每週六」那一份（當季度快照）
#   * 刪除目標前先 gzip 壓一份（改檔名加 .gz）— 可選，預設開
#
# 用法：bash backup_contacts.sh
# 設成 cron：@daily /bin/bash $HOME/line-bot/backup_contacts.sh >> /tmp/backup_contacts.log 2>&1
set -euo pipefail

SRC="$HOME/line-bot/contacts.json"
BACKUP_DIR="$HOME/line-bot/backups"
DATE_TAG=$(date +"%Y%m%d-%H%M%S")
OUT="$BACKUP_DIR/contacts-$DATE_TAG.json"
LATEST="$BACKUP_DIR/contacts-latest.json"

KEEP_DAYS=${KEEP_DAYS:-30}

mkdir -p "$BACKUP_DIR"

if [ ! -f "$SRC" ]; then
  echo "❌ contacts.json 不存在：$SRC"
  exit 1
fi

cp "$SRC" "$OUT"
cp "$SRC" "$LATEST"

echo "✅ 已備份：$OUT"
echo "✅ 已更新最新檔：$LATEST"

# ── 保留策略 ──
# 刪掉 KEEP_DAYS 天以前的未壓縮 .json（排除 -latest）
echo "🧹 清理 >$KEEP_DAYS 天的備份..."
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "contacts-*.json" \
  ! -name "contacts-latest.json" \
  -mtime +$KEEP_DAYS \
  -print -delete || true

# 壓縮 7 天以前尚未壓縮的（省空間，方便保留更久）
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "contacts-*.json" \
  ! -name "contacts-latest.json" \
  -mtime +7 \
  -exec gzip -f {} \; 2>/dev/null || true

# 清掉 KEEP_DAYS*2 天以前的 .gz 壓縮檔
find "$BACKUP_DIR" -maxdepth 1 -type f \
  -name "contacts-*.json.gz" \
  -mtime +$((KEEP_DAYS * 2)) \
  -print -delete || true

echo "✅ 清理完成"
