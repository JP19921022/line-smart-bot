#!/usr/bin/env python3
"""Parse stored source snapshots into normalized tables."""

from __future__ import annotations

import argparse
import hashlib
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

DB_PATH = Path("knowledge/insurance.db")
BASE_URLS = {
    "kgi": "https://kgilife.moneydj.com",
    "chubb": "https://chubb.moneydj.com",
}


@dataclass(slots=True)
class SnapshotRow:
    snapshot_id: str
    source_slug: str
    source_url: str
    category: str
    fetched_at: str
    raw_html: str


@dataclass(slots=True)
class FundNav:
    fund_code: str
    fund_name: Optional[str]
    nav_date: str
    nav_value: Optional[float]
    daily_change_pct: Optional[float]
    currency: Optional[str]


@dataclass(slots=True)
class ArticleRow:
    article_id: str
    source_slug: str
    headline: str
    source_url: str
    published_at: str
    summary: Optional[str]
    body: Optional[str]
    raw_html: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process stored HTML snapshots")
    parser.add_argument("--only", choices=("fund", "news"))
    parser.add_argument("--since", type=str)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


CATEGORY_FILTER = {
    None: None,
    "fund": "fund",
    "news": "insurance-news",
}


def load_snapshots(conn: sqlite3.Connection, *, category: str | None, since: str | None) -> list[SnapshotRow]:
    query = [
        "SELECT ss.snapshot_id, ss.source_slug, ss.url, s.category, ss.fetched_at, ss.raw_html",
        "FROM source_snapshots ss",
        "JOIN sources s ON s.slug = ss.source_slug",
        "WHERE 1=1",
    ]
    params: list[str] = []
    db_category = CATEGORY_FILTER.get(category)
    if db_category:
        query.append("AND s.category = ?")
        params.append(db_category)
    if since:
        dt = datetime.fromisoformat(since).date()
        since_iso = datetime.combine(dt, datetime.min.time(), tzinfo=timezone.utc).isoformat()
        query.append("AND ss.fetched_at >= ?")
        params.append(since_iso)
    query.append("ORDER BY ss.fetched_at DESC")
    rows = conn.execute("\n".join(query), params).fetchall()
    return [SnapshotRow(*row) for row in rows]


def parse_fund_snapshot(snapshot: SnapshotRow) -> FundNav:
    soup = BeautifulSoup(snapshot.raw_html, "html.parser")

    def text_for(th_label: str) -> Optional[str]:
        info_table = soup.select_one("table.just-tb-v-4")
        if not info_table:
            return None
        for row in info_table.find_all("tr"):
            th = row.find("th")
            if th and th_label in th.get_text(strip=True):
                td = row.find("td")
                return td.get_text(strip=True) if td else None
        return None

    nav_table = soup.select_one("table.reversion-xs")
    nav_date_iso: str
    nav_value: Optional[float]
    change_pct: Optional[float]
    if nav_table:
        nav_rows = nav_table.find_all("tr")
        if len(nav_rows) < 2:
            raise ValueError("Unexpected nav table shape")
        value_cells = [cell.get_text(strip=True) for cell in nav_rows[1].find_all("td")]
        if len(value_cells) < 3:
            raise ValueError("Unable to extract nav metrics")
        nav_date_iso = normalize_date(value_cells[0])
        nav_value = parse_float(value_cells[1])
        change_pct = parse_float(value_cells[2])
    else:
        nav_table = soup.select_one("table.simple-dt-responsive")
        if not nav_table:
            raise ValueError("Nav table not found in snapshot")
        rows = nav_table.select("tbody tr")
        if not rows:
            raise ValueError("No nav rows found")
        first_cells = rows[0].find_all("td")
        if len(first_cells) < 2:
            raise ValueError("Unexpected domestic nav row structure")
        nav_date_iso = normalize_date(first_cells[0].get_text(strip=True))
        nav_value = parse_float(first_cells[1].get_text(strip=True))
        change_pct = None
        if len(rows) > 1:
            prev_cells = rows[1].find_all("td")
            if len(prev_cells) >= 2:
                prev_value = parse_float(prev_cells[1].get_text(strip=True))
                if nav_value is not None and prev_value is not None and prev_value != 0:
                    change_pct = round((nav_value - prev_value) / prev_value * 100, 4)

    fund_name = text_for("基金名稱") or header_title(soup)
    currency = text_for("計價幣別") or guess_currency(fund_name)
    fund_code = derive_fund_code(snapshot)

    return FundNav(
        fund_code=fund_code,
        fund_name=fund_name,
        nav_date=nav_date_iso,
        nav_value=nav_value,
        daily_change_pct=change_pct,
        currency=currency,
    )


def parse_news_snapshot(snapshot: SnapshotRow) -> list[ArticleRow]:
    if snapshot.source_slug.startswith("kgi_"):
        return parse_kgi_news(snapshot)
    if snapshot.source_slug.startswith("chubb_"):
        return parse_chubb_news(snapshot)
    raise ValueError(f"Unsupported news source: {snapshot.source_slug}")


def parse_kgi_news(snapshot: SnapshotRow) -> list[ArticleRow]:
    soup = BeautifulSoup(snapshot.raw_html, "html.parser")
    table = soup.select_one("table.simple-dt-responsive")
    if not table:
        return []
    rows = table.select("tbody tr")
    articles: list[ArticleRow] = []
    base_url = BASE_URLS["kgi"]
    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        date_text = cells[0].get_text(strip=True)
        link = cells[1].find("a")
        if not link:
            continue
        href = urljoin(base_url, link.get("href", ""))
        headline = link.get_text(strip=True)
        article_id = build_article_id(snapshot.source_slug, href or headline + date_text)
        articles.append(
            ArticleRow(
                article_id=article_id,
                source_slug=snapshot.source_slug,
                headline=headline,
                source_url=href,
                published_at=normalize_date(date_text),
                summary=None,
                body=None,
                raw_html=str(row),
            )
        )
    return articles


def parse_chubb_news(snapshot: SnapshotRow) -> list[ArticleRow]:
    soup = BeautifulSoup(snapshot.raw_html, "html.parser")
    table = soup.select_one("table.table-bordered")
    if not table:
        return []
    rows = table.select("tbody tr")
    articles: list[ArticleRow] = []
    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 7:
            continue
        ex_date = normalize_date(cells[0].get_text(strip=True))
        payout_date = cells[1].get_text(strip=True)
        status = cells[3].get_text(strip=True)
        value = cells[4].get_text(strip=True)
        rate = cells[5].get_text(strip=True)
        currency = cells[6].get_text(strip=True)
        headline = f"配息公告（除息日 {ex_date}）"
        summary = f"收益分配日 {payout_date}，狀態 {status}，息值 {value}，配息率 {rate}%，幣別 {currency}"
        synthetic_url = f"{snapshot.source_url}#ex-date-{ex_date}"
        article_id = build_article_id(snapshot.source_slug, synthetic_url)
        articles.append(
            ArticleRow(
                article_id=article_id,
                source_slug=snapshot.source_slug,
                headline=headline,
                source_url=synthetic_url,
                published_at=ex_date,
                summary=summary,
                body=None,
                raw_html=str(row),
            )
        )
    return articles


def header_title(soup: BeautifulSoup) -> Optional[str]:
    header = soup.select_one("div.page-header h4")
    if header:
        return header.get_text(strip=True).split("\n")[0]
    return None


def guess_currency(text: Optional[str]) -> Optional[str]:
    if not text:
        return "TWD"
    keywords = {
        "美元": "USD",
        "美金": "USD",
        "台幣": "TWD",
        "新台幣": "TWD",
        "新臺幣": "TWD",
        "人民幣": "CNY",
        "港幣": "HKD",
        "歐元": "EUR",
        "澳幣": "AUD",
        "日圓": "JPY",
        "英鎊": "GBP",
    }
    for kw, code in keywords.items():
        if kw in text:
            return code
    return "TWD"


def derive_fund_code(snapshot: SnapshotRow) -> str:
    parsed = urlparse(snapshot.source_url)
    qs = parse_qs(parsed.query)
    if "a" in qs and qs["a"]:
        return qs["a"][0]
    if "-" in snapshot.source_slug:
        return snapshot.source_slug.split("-", maxsplit=1)[1]
    return snapshot.source_slug


def normalize_date(raw: str) -> str:
    raw = raw.strip()
    for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"Unrecognized date format: {raw}")


def parse_float(raw: str | None) -> Optional[float]:
    if not raw:
        return None
    cleaned = raw.replace(",", "").replace("%", "").strip()
    if cleaned in {"", "N/A", "-"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def build_article_id(source_slug: str, seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    return f"{source_slug}-{digest[:16]}"


def upsert_fund_nav(conn: sqlite3.Connection, snapshot: SnapshotRow, nav: FundNav, *, dry_run: bool) -> None:
    nav_id = f"{nav.fund_code}-{nav.nav_date}"
    params = (
        nav_id,
        nav.fund_code,
        nav.fund_name,
        nav.nav_date,
        nav.nav_value,
        nav.currency or "TWD",
        nav.daily_change_pct,
        snapshot.source_slug,
        snapshot.source_url,
        snapshot.fetched_at,
        snapshot.raw_html,
    )
    sql = (
        "INSERT INTO fund_navs (nav_id, fund_code, fund_name, nav_date, nav_value, nav_currency, daily_change_pct, source_slug, source_url, fetched_at, raw_html)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(fund_code, nav_date) DO UPDATE SET "
        " fund_name=excluded.fund_name,"
        " nav_value=excluded.nav_value,"
        " nav_currency=excluded.nav_currency,"
        " daily_change_pct=excluded.daily_change_pct,"
        " source_slug=excluded.source_slug,"
        " source_url=excluded.source_url,"
        " fetched_at=excluded.fetched_at,"
        " raw_html=excluded.raw_html"
    )
    if dry_run:
        print(f"[dry-run] fund {nav.fund_code} {nav.nav_date} nav={nav.nav_value} change={nav.daily_change_pct}")
    else:
        conn.execute(sql, params)
        print(f"[fund] upserted {nav.fund_code} @ {nav.nav_date}")


def upsert_articles(conn: sqlite3.Connection, snapshot: SnapshotRow, rows: list[ArticleRow], *, dry_run: bool) -> None:
    sql = (
        "INSERT INTO articles (article_id, source_slug, headline, summary, body, source_url, published_at, fetched_at, raw_html)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(article_id) DO UPDATE SET "
        " headline=excluded.headline,"
        " summary=excluded.summary,"
        " body=excluded.body,"
        " source_url=excluded.source_url,"
        " published_at=excluded.published_at,"
        " fetched_at=excluded.fetched_at,"
        " raw_html=excluded.raw_html"
    )
    for row in rows:
        params = (
            row.article_id,
            row.source_slug,
            row.headline,
            row.summary,
            row.body,
            row.source_url,
            row.published_at,
            snapshot.fetched_at,
            row.raw_html,
        )
        if dry_run:
            print(f"[dry-run] article {row.source_slug} {row.published_at} {row.headline}")
        else:
            conn.execute(sql, params)


def main() -> None:
    args = parse_args()
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Database not found: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH)
    try:
        snapshots = load_snapshots(conn, category=args.only, since=args.since)
        if not snapshots:
            print("No snapshots found for given filters")
            return
        processed = 0
        for snapshot in snapshots:
            if snapshot.category == "fund" and args.only in (None, "fund"):
                try:
                    nav = parse_fund_snapshot(snapshot)
                except Exception as exc:
                    print(f"[warn] failed to parse fund snapshot {snapshot.snapshot_id}: {exc}")
                    continue
                upsert_fund_nav(conn, snapshot, nav, dry_run=args.dry_run)
                processed += 1
            if snapshot.category == "insurance-news" and args.only in (None, "news"):
                try:
                    articles = parse_news_snapshot(snapshot)
                except Exception as exc:
                    print(f"[warn] failed to parse news snapshot {snapshot.snapshot_id}: {exc}")
                    continue
                if articles:
                    upsert_articles(conn, snapshot, articles, dry_run=args.dry_run)
                    processed += len(articles)
        if args.dry_run:
            print(f"Processed {processed} items (dry-run, no DB writes)")
        else:
            conn.commit()
            print(f"Processed {processed} items")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
