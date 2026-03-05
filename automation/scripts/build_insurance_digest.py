#!/usr/bin/env python3
"""Build a daily insurance/fund digest from the SQLite knowledge base."""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Iterable

DB_PATH = Path("knowledge/insurance.db")
DEFAULT_LIMIT = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build insurance/fund digest")
    parser.add_argument("--date", type=str, help="Target end date (YYYY-MM-DD). Defaults to today.")
    parser.add_argument("--from-date", type=str, help="Optional start date (inclusive)")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="Number of articles to include")
    parser.add_argument("--source", action="append", help="Filter by source_slug (can repeat)")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown", help="Output format")
    parser.add_argument("--output", type=str, help="Optional path to save the digest")
    parser.add_argument("--save-prefix", type=str, help="Write both markdown/json files to this prefix")
    return parser.parse_args()


def resolve_date(value: str | None) -> str:
    if not value:
        return date.today().isoformat()
    return datetime.fromisoformat(value).date().isoformat()


def resolve_optional_date(value: str | None) -> str | None:
    if not value:
        return None
    return datetime.fromisoformat(value).date().isoformat()


def fetch_articles(
    conn: sqlite3.Connection,
    *,
    target_date: str,
    start_date: str | None,
    limit: int,
    sources: Iterable[str] | None,
) -> list[sqlite3.Row]:
    query = [
        "SELECT article_id, source_slug, headline, summary, published_at, source_url",
        "FROM articles",
        "WHERE published_at <= ?",
    ]
    params: list[str] = [target_date]
    if start_date:
        query.append("AND published_at >= ?")
        params.append(start_date)
    if sources:
        query.append("AND source_slug IN (%s)" % ",".join("?" for _ in sources))
        params.extend(sources)
    query.append("ORDER BY published_at DESC")
    query.append("LIMIT ?")
    params.append(limit)
    return conn.execute("\n".join(query), params).fetchall()


def format_digest(rows: Iterable[sqlite3.Row]) -> str:
    lines: list[str] = []
    for idx, row in enumerate(rows, start=1):
        headline = row["headline"]
        published_at = row["published_at"]
        source_slug = row["source_slug"]
        source_url = row["source_url"]
        summary = build_summary(row)
        impact = build_impact(row)
        recommendations = build_recommendations(row)
        lines.append(f"### {idx}. {headline} ({published_at})")
        lines.append(f"- 50字摘要：{summary}")
        lines.append(f"- 保戶影響：{impact}")
        lines.append("- 建議：")
        for i, rec in enumerate(recommendations, start=1):
            lines.append(f"  {i}. {rec}")
        lines.append(f"- 來源：{source_slug} | {source_url}")
        lines.append("")
    return "\n".join(lines).strip()


def build_summary(row: sqlite3.Row) -> str:
    headline = row["headline"]
    published_at = row["published_at"]
    return f"{headline}，公告日期 {published_at}。"


def build_impact(row: sqlite3.Row) -> str:
    headline = row["headline"]
    if "配息" in headline or "收益" in headline:
        return "涉及月配基金現金流，月領族與連結保單需注意入帳節奏。"
    return "與基金策略變動相關，適合用來檢視投資/保障配置。"


def build_recommendations(row: sqlite3.Row) -> list[str]:
    headline = row["headline"]
    recs = [
        "檢視該基金在你保單或投資組合中的比重。",
        "確認近期現金需求與配息入帳日期是否匹配。",
        "與顧問討論是否需要調整部位或再平衡配置。",
    ]
    if "追募" in headline or "申報" in headline:
        recs[0] = "注意追募/申報時程，掌握能否申購或額度限制。"
    return recs


def row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "headline": row["headline"],
        "published_at": row["published_at"],
        "source_slug": row["source_slug"],
        "source_url": row["source_url"],
        "summary": build_summary(row),
        "impact": build_impact(row),
        "recommendations": build_recommendations(row),
    }


def save_dual_outputs(rows: list[sqlite3.Row], dict_rows: list[dict], prefix: Path) -> None:
    prefix.parent.mkdir(parents=True, exist_ok=True)
    markdown_path = prefix.with_suffix(".md")
    json_path = prefix.with_suffix(".json")
    markdown_path.write_text(format_digest(rows), encoding="utf-8")
    json_path.write_text(json.dumps(dict_rows, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    args = parse_args()
    target_date = resolve_date(args.date)
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Database not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = fetch_articles(
            conn,
            target_date=target_date,
            start_date=resolve_optional_date(args.from_date),
            limit=args.limit,
            sources=args.source,
        )
        if not rows:
            print("(no articles found for given filters)")
            return
        dict_rows = [row_to_dict(row) for row in rows]
        if args.format == "markdown":
            rendered = format_digest(rows)
        else:
            rendered = json.dumps(dict_rows, ensure_ascii=False, indent=2)
        print(rendered)
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered, encoding="utf-8")
        if args.save_prefix:
            save_dual_outputs(rows, dict_rows, Path(args.save_prefix))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
