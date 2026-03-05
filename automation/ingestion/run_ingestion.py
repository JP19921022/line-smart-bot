#!/usr/bin/env python3
"""Bootstrap scraper for insurance + fund sources."""

from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import requests
from requests.packages.urllib3.exceptions import InsecureRequestWarning

KNOWLEDGE_DIR = Path("knowledge")
DB_PATH = KNOWLEDGE_DIR / "insurance.db"
VERIFY_SSL = False  # MoneyDJ certificates fail default macOS trust chain, so skip for now
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
)
DEFAULT_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.ctee.com.tw/",
}


@dataclass(frozen=True)
class Source:
    slug: str
    url: str
    category: str


SOURCES: tuple[Source, ...] = (
    Source("kgi_accp138", "https://kgilife.moneydj.com/w/wr/wr05.djhtm?a=ACCP138-TFO3", "insurance-news"),
    Source("kgi_tlz64", "https://kgilife.moneydj.com/w/wb/wb05.djhtm?a=TLZ64-TFP6", "insurance-news"),
    Source("kgi_acti71", "https://kgilife.moneydj.com/w/wr/wr05.djhtm?a=ACTI71-TFS6", "insurance-news"),
    Source("chubb_jfzn3", "https://chubb.moneydj.com/w/wb/wb05.djhtm?a=JFZN3-BGUJF059", "insurance-news"),
    Source("ctee_insurance", "https://www.ctee.com.tw/finance/insurance", "insurance-news"),
    Source("rmim_news", "https://www.rmim.com.tw/news", "insurance-news"),
    Source("bw_money_insurance", "https://www.businessweekly.com.tw/channel/money/0000000323", "insurance-news"),
    Source("fund_accp138", "https://kgilife.moneydj.com/w/wr/wr02.djhtm?a=ACCP138-TFO3", "fund"),
    Source("fund_albt8", "https://kgilife.moneydj.com/w/wb/wb01.djhtm?a=ALBT8-TFU6", "fund"),
    Source("fund_jfzn3", "https://kgilife.moneydj.com/w/wb/wb01.djhtm?a=JFZN3-TFU5", "fund"),
    Source("fund_acti71", "https://kgilife.moneydj.com/w/wr/wr02.djhtm?a=ACTI71-TFS6", "fund"),
)


requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

def ensure_db() -> None:
    KNOWLEDGE_DIR.mkdir(exist_ok=True)
    schema_path = KNOWLEDGE_DIR / "schema.sql"
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema file missing: {schema_path}")
    with sqlite3.connect(DB_PATH) as conn, open(schema_path, "r", encoding="utf-8") as fh:
        conn.executescript(fh.read())


def seed_sources(conn: sqlite3.Connection) -> None:
    conn.executemany(
        """
        INSERT INTO sources (slug, url, label, category, tags)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET url=excluded.url, label=excluded.label, category=excluded.category, tags=excluded.tags
        """,
        [
            (source.slug, source.url, source.slug.replace("_", " "), source.category, None)
            for source in SOURCES
        ],
    )


def fetch_html(url: str) -> str:
    resp = requests.get(
        url,
        headers=DEFAULT_HEADERS,
        timeout=30,
        verify=VERIFY_SSL,
    )
    resp.raise_for_status()
    return resp.text


def record_snapshot(conn: sqlite3.Connection, source: Source, html: str) -> None:
    snapshot_id = uuid.uuid4().hex
    fetched_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        INSERT INTO source_snapshots (snapshot_id, source_slug, url, raw_html, fetched_at, http_status, notes)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
        """,
        (snapshot_id, source.slug, source.url, html, fetched_at),
    )


def run_once(sources: Iterable[Source]) -> None:
    ensure_db()
    with sqlite3.connect(DB_PATH) as conn:
        seed_sources(conn)
        for source in sources:
            try:
                html = fetch_html(source.url)
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] fetch failed for {source.slug}: {exc}")
                continue
            try:
                record_snapshot(conn, source, html)
                print(f"[ok] stored snapshot for {source.slug}")
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] db write failed for {source.slug}: {exc}")


if __name__ == "__main__":
    run_once(SOURCES)
