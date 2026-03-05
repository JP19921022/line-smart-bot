#!/usr/bin/env python3
"""Generate digest files + cover image in one go."""

from __future__ import annotations

import argparse
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from scripts import build_insurance_digest as digest

DEFAULT_DIGEST_DIR = Path("artifacts/digests")
DEFAULT_COVER_DIR = Path("artifacts/covers")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the daily digest pipeline")
    parser.add_argument("--date", type=str, help="Target date (YYYY-MM-DD). Defaults to today")
    parser.add_argument("--limit", type=int, default=3, help="Number of articles to include")
    parser.add_argument("--source", action="append", dest="sources", help="Filter by source slug (repeatable)")
    parser.add_argument("--digest-prefix", type=str, help="Where to save digest files (without extension)")
    parser.add_argument("--cover-output", type=str, help="Path for the generated cover image")
    parser.add_argument("--cover-title", type=str, default="保險日報")
    parser.add_argument("--cover-subtitle", type=str, default="每日策略重點")
    return parser.parse_args()


def default_paths(target_date: str) -> tuple[Path, Path]:
    digest_prefix = DEFAULT_DIGEST_DIR / f"digest-{target_date}"
    cover_output = DEFAULT_COVER_DIR / f"digest-cover-{target_date}.png"
    return digest_prefix, cover_output


def format_bullet(item: dict) -> str:
    headline = item["headline"]
    headline = headline.replace("收益分配", "月配").replace("配息公告", "月配公告")
    if len(headline) > 12:
        headline = headline[:12] + "…"
    month_day = item["published_at"][5:]
    return f"{headline}｜{month_day}"


def main() -> None:
    args = parse_args()
    target_date = digest.resolve_date(args.date)
    digest_prefix, cover_output = default_paths(target_date)
    if args.digest_prefix:
        digest_prefix = Path(args.digest_prefix)
    if args.cover_output:
        cover_output = Path(args.cover_output)

    conn = digest.sqlite3.connect(digest.DB_PATH)  # type: ignore[attr-defined]
    conn.row_factory = digest.sqlite3.Row  # type: ignore[attr-defined]
    try:
        rows = digest.fetch_articles(
            conn,
            target_date=target_date,
            start_date=None,
            limit=args.limit,
            sources=args.sources,
        )
        if not rows:
            raise RuntimeError("No articles found for the selected date")
        dict_rows = [digest.row_to_dict(row) for row in rows]
        digest.save_dual_outputs(rows, dict_rows, digest_prefix)
    finally:
        conn.close()

    bullets = [format_bullet(item) for item in dict_rows][:3]
    cmd = [
        sys.executable,
        "scripts/generate_cover_image.py",
        "--title",
        args.cover_title,
        "--subtitle",
        args.cover_subtitle,
        "--output",
        str(cover_output),
    ]
    for bullet in bullets:
        cmd.extend(["--bullet", bullet])
    subprocess.run(cmd, check=True)
    print(f"Digest saved to {digest_prefix}.[md|json]; cover saved to {cover_output}")


if __name__ == "__main__":
    main()
