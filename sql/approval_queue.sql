-- ──────────────────────────────────────────────
--  Tier-2 #6  敏感詞審核佇列
-- ──────────────────────────────────────────────
--
--  目的：當客戶訊息包含敏感詞（理賠 / 退保 / 客訴 / 投訴 ...）時，
--        LINE bot 不自動回覆，而是把 AI 擬好的草稿丟進這張表。
--        管理員在 dashboard 看到後可以「核可送出」、「改寫後送」或「拒絕」。
--
--  在 Supabase SQL editor 貼這整份跑一次即可。
--
--  欄位說明：
--    status:
--      pending   - 等待審核（UI 顯示）
--      approved  - 審核通過，正在嘗試送 LINE push
--      sent      - 已成功送出（保留 3 天做稽核）
--      rejected  - 人工拒絕，不送
--      failed    - send 失敗（例如 token 過期），可重試
--

CREATE TABLE IF NOT EXISTS approval_queue (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  display_name      TEXT,
  incoming_text     TEXT,                -- 客戶傳了什麼
  draft_reply       TEXT        NOT NULL, -- AI 擬好的草稿
  matched_keywords  TEXT[],               -- 觸發了哪些關鍵字
  status            TEXT        NOT NULL DEFAULT 'pending',
  final_reply       TEXT,                 -- 核可時若被改寫，存這份
  reviewed_by       TEXT,                 -- 審核者標記（暫存 client token hash / 後端身分）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  last_error        TEXT
);

-- dashboard 查 pending 用
CREATE INDEX IF NOT EXISTS idx_approval_queue_status_time
  ON approval_queue (status, created_at DESC);

-- 同一人 pending 不去 dedup — 連續幾則都可能該審，全部都要進 queue。
