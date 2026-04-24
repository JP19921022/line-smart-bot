-- ──────────────────────────────────────────────
--  Tier-2 #7-B  排程推播 Scheduled broadcasts
-- ──────────────────────────────────────────────
--
--  目的：原本 manual-broadcast 只能「立即送」。這張表讓管理員可以
--        指定未來某個時間點發送，由 worker loop 每 30 秒撿一次表，
--        到時間就觸發 LINE push。
--
--  在 Supabase SQL editor 貼這整份跑一次即可。
--
--  欄位說明：
--    segment:
--      'enabled'  - 所有 enabled 客戶
--      'all'      - 全部客戶
--      'tags'     - 配合 tags[] 欄位，OR 邏輯
--      'custom'   - 配合 user_ids[] 指定名單
--
--    status:
--      pending    - 排隊中，等 worker 撿
--      running    - 某個 worker 正在送（有 started_at 時間戳）
--      sent       - 已送出完成（保留 7 天做稽核）
--      failed     - 超過重試上限，放棄
--      cancelled  - 管理員手動取消
--

CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
  id              BIGSERIAL PRIMARY KEY,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  message         TEXT        NOT NULL,
  segment         TEXT        NOT NULL DEFAULT 'enabled',
  tags            TEXT[],
  user_ids        TEXT[],
  status          TEXT        NOT NULL DEFAULT 'pending',
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  total_targets   INTEGER,
  sent_count      INTEGER,
  failed_count    INTEGER,
  created_by      TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  last_error      TEXT
);

-- worker 撿「到時間」的 pending 排程用
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_status_time
  ON scheduled_broadcasts (status, scheduled_at);

-- 管理介面列表排序用
CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_created
  ON scheduled_broadcasts (created_at DESC);
