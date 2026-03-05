#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

python3 ingestion/run_ingestion.py
python3 ingestion/process_snapshots.py
python3 scripts/push_daily_digest.py --limit 3 --cover-title "基金快訊" --cover-subtitle "每日市場重點"
