-- ──────────────────────────────────────────────
--  Tier-2 #7-D  AI 草稿模板庫 Reply Templates
-- ──────────────────────────────────────────────
--
--  目的：審核佇列裡的草稿，常常會被調整成幾個固定回法（例如
--        「理賠流程標準話術」、「投保進度查詢話術」）。存成模板後，
--        下次遇到類似狀況可以一鍵帶入、審核更快。
--
--  在 Supabase SQL editor 貼這整份跑一次即可。
--

CREATE TABLE IF NOT EXISTS reply_templates (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT        NOT NULL,            -- 模板名稱（顯示用）
  body          TEXT        NOT NULL,            -- 模板內容
  tags          TEXT[],                           -- 標記這個模板適用的情境（與客戶 tag 獨立）
  use_count     INTEGER     NOT NULL DEFAULT 0,  -- 被套用次數
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    TEXT
);

-- 同名 title 不允許重複（方便 upsert 與管理）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reply_templates_title
  ON reply_templates (title);

-- 列表排序用（最近用的排前面）
CREATE INDEX IF NOT EXISTS idx_reply_templates_lastused
  ON reply_templates (last_used_at DESC NULLS LAST, use_count DESC);
