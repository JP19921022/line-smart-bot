-- 主動推送觸發事件資料表
CREATE TABLE IF NOT EXISTS proactive_triggers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_date TIMESTAMPTZ NOT NULL,
  context TEXT,
  sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE proactive_triggers DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_proactive_triggers_pending
  ON proactive_triggers(trigger_date, sent)
  WHERE sent = false;
