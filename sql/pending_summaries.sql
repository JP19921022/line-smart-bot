-- ──────────────────────────────────────────────
--  Tier-2 #5  CRM 摘要持久化佇列
-- ──────────────────────────────────────────────
--
--  目的：原本 crmIntegration.js 用 `setImmediate()` 做 fire-and-forget 的
--        摘要生成，一旦 Render 在摘要做到一半重新部署，整份摘要就人間蒸發。
--        改把「要摘要誰」先寫入這張表，由 worker loop 逐筆處理，做完才
--        刪掉。Render 重啟 → worker 再啟動 → 還沒做的會接著做。
--
--  使用方式：在 Supabase SQL editor 貼這整份跑一次就好。
--
--  狀態欄位：
--    pending    - 排隊中，等 worker 撿
--    processing - 某個 worker 正在處理（有 started_at 時間戳）
--    （成功 → 直接 DELETE，不留垃圾）
--    failed     - 超過 retry 上限才進這裡，方便排查
--

CREATE TABLE IF NOT EXISTS pending_summaries (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT        NOT NULL,
  display_name  TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending',
  retry_count   INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

-- 撿最舊的 pending 用
CREATE INDEX IF NOT EXISTS idx_pending_summaries_status_time
  ON pending_summaries (status, enqueued_at);

-- 同一個 userId 只能有一筆 pending 或 processing，避免重複排隊
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_summaries_active_user
  ON pending_summaries (user_id)
  WHERE status IN ('pending', 'processing');
