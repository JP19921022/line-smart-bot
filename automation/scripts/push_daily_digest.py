#!/usr/bin/env python3
"""Generate daily digest assets and broadcast via LINE."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Iterable

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from scripts import build_insurance_digest as digest  # noqa: E402

DEFAULT_LIMIT = 3
DEFAULT_TITLE = "保險日報"
DEFAULT_SUBTITLE = "每日市場重點"
TARGET_USER_IDS = [uid.strip() for uid in os.getenv("DIGEST_TARGET_USER_IDS", "").split(",") if uid.strip()]
SOURCE_SLUGS = [slug.strip() for slug in os.getenv("DIGEST_SOURCE_SLUGS", "").split(",") if slug.strip()]
DISABLE_FLAG_PATH = os.getenv(
    "DIGEST_DISABLE_FLAG_PATH",
    str(ROOT / "automation" / "config" / "digest_disabled.flag"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Push daily digest to LINE")
    parser.add_argument("--date", type=str, help="Target date (YYYY-MM-DD). Defaults to today")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--cover-title", type=str, default=DEFAULT_TITLE)
    parser.add_argument("--cover-subtitle", type=str, default=DEFAULT_SUBTITLE)
    parser.add_argument("--dry-run", action="store_true", help="Generate assets but skip LINE broadcast")
    return parser.parse_args()


def run_pipeline(target_date: str, limit: int, title: str, subtitle: str) -> tuple[Path, Path]:
    digest_prefix = ROOT / "artifacts" / "digests" / f"digest-{target_date}"
    cover_path = ROOT / "artifacts" / "covers" / f"digest-cover-{target_date}.png"
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "run_daily_digest_pipeline.py"),
        "--date",
        target_date,
        "--limit",
        str(limit),
        "--cover-title",
        title,
        "--cover-subtitle",
        subtitle,
        "--digest-prefix",
        str(digest_prefix),
        "--cover-output",
        str(cover_path),
    ]
    for slug in SOURCE_SLUGS:
        cmd.extend(["--source", slug])
    subprocess.run(cmd, check=True)
    return digest_prefix, cover_path


def load_digest_text(prefix: Path) -> tuple[str, list[str]]:
    md_path = prefix.with_suffix(".md")
    json_path = prefix.with_suffix(".json")
    markdown = md_path.read_text(encoding="utf-8")
    items = json.loads(json_path.read_text(encoding="utf-8"))
    return markdown, items


def build_message(items: list[dict], target_date: str) -> str:
    header = f"【保險日報｜{target_date}" + "】"
    lines = [header]
    for idx, item in enumerate(items, start=1):
        headline = item["headline"]
        summary = item["summary"]
        impact = item.get("impact")
        recommendations = item.get("recommendations", [])
        source_slug = item.get("source_slug", "")
        source_url = item.get("source_url", "")
        lines.append(f"{idx}. {headline}")
        lines.append(f"   - 50字摘要：{summary}")
        if impact:
            lines.append(f"   - 保戶影響：{impact}")
        if recommendations:
            lines.append("   - 建議：")
            for rec in recommendations:
                lines.append(f"      • {rec}")
        if source_slug or source_url:
            lines.append(f"   - 來源：{source_slug} | {source_url}")
        lines.append("")
    lines.append("資料來源：內部資料庫")
    return "\n".join(lines).strip()


def upload_cover(path: Path) -> str:
    with path.open("rb") as fh:
        resp = requests.post(
            "https://tmpfiles.org/api/v1/upload",
            files={"file": (path.name, fh)},
            timeout=60,
        )
    resp.raise_for_status()
    data = resp.json()
    url = data["data"]["url"]
    parts = url.rstrip("/").split("/")
    if len(parts) >= 2:
        file_id = parts[-2]
        filename = parts[-1]
        return f"https://tmpfiles.org/dl/{file_id}/{filename}"
    return url


def broadcast_message(text: str, image_url: str, dry_run: bool) -> None:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "line_broadcast.py"),
        "--text",
        text,
    ]
    if image_url:
        cmd.extend(["--image-url", image_url])
    if TARGET_USER_IDS:
        for uid in TARGET_USER_IDS:
            cmd.extend(["--user-id", uid])
    if dry_run:
        print("[dry-run] would run:", " ".join(cmd))
        return
    subprocess.run(cmd, check=True)
    print("Broadcast sent", "(targeted)" if TARGET_USER_IDS else "")


def main() -> None:
    if os.path.exists(DISABLE_FLAG_PATH):
        print(f"Daily digest push disabled via flag: {DISABLE_FLAG_PATH}")
        return
    args = parse_args()
    target_date = digest.resolve_date(args.date)
    digest_prefix, cover_path = run_pipeline(target_date, args.limit, args.cover_title, args.cover_subtitle)
    markdown, items = load_digest_text(digest_prefix)
    # Use only the top `limit` items for the message
    message = build_message(items[: args.limit], target_date)
    image_url = upload_cover(cover_path) if cover_path.exists() else ""
    broadcast_message(message, image_url, args.dry_run)
    print("Digest + cover ready. Message length:", len(message))
    if args.dry_run:
        print("(dry-run) No LINE broadcast sent.")
    else:
        print("Broadcast sent via LINE.")


if __name__ == "__main__":
    main()
