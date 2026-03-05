-- Core source catalog
CREATE TABLE IF NOT EXISTS sources (
    slug TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    label TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('insurance-news', 'fund')),
    tags TEXT DEFAULT NULL
);

-- Raw HTML snapshots per fetch. Keeps history for debugging parsers.
CREATE TABLE IF NOT EXISTS source_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    source_slug TEXT NOT NULL REFERENCES sources(slug),
    url TEXT NOT NULL,
    raw_html TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    http_status INTEGER,
    notes TEXT,
    UNIQUE(source_slug, fetched_at)
);

-- Normalized insurance/finance news articles (one row per article).
CREATE TABLE IF NOT EXISTS articles (
    article_id TEXT PRIMARY KEY,
    source_slug TEXT NOT NULL REFERENCES sources(slug),
    headline TEXT NOT NULL,
    summary TEXT,
    body TEXT,
    source_url TEXT NOT NULL,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    author TEXT,
    tags TEXT,
    raw_html TEXT,
    UNIQUE(source_slug, source_url)
);

-- Fund NAV snapshots for the four focus funds.
CREATE TABLE IF NOT EXISTS fund_navs (
    nav_id TEXT PRIMARY KEY,
    fund_code TEXT NOT NULL,
    fund_name TEXT,
    nav_date TEXT NOT NULL,
    nav_value REAL,
    nav_currency TEXT DEFAULT 'TWD',
    daily_change_pct REAL,
    source_slug TEXT NOT NULL REFERENCES sources(slug),
    source_url TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    raw_html TEXT,
    UNIQUE(fund_code, nav_date)
);

CREATE TABLE IF NOT EXISTS policy_documents (
    policy_id TEXT PRIMARY KEY,
    insurer TEXT NOT NULL,
    product_name TEXT NOT NULL,
    product_code TEXT,
    version TEXT,
    effective_date TEXT,
    file_path TEXT,
    summary TEXT,
    coverage_json TEXT,
    raw_text TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
