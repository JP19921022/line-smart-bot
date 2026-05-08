-- 建立問卷回覆資料表
-- 請到 Supabase Dashboard → SQL Editor → 貼上並執行

CREATE TABLE IF NOT EXISTS survey_responses (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      text        NOT NULL,
  answers      jsonb,
  score        numeric,
  note         text        DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  ip           text        DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 索引（加速查詢）
CREATE INDEX IF NOT EXISTS idx_survey_user_id      ON survey_responses (user_id);
CREATE INDEX IF NOT EXISTS idx_survey_submitted_at ON survey_responses (submitted_at DESC);

-- 允許 service role 讀寫（預設已有，這行確保 RLS 不擋）
ALTER TABLE survey_responses DISABLE ROW LEVEL SECURITY;
