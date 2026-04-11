-- 長期記憶摘要表
CREATE TABLE IF NOT EXISTS user_memories (
  id        BIGSERIAL PRIMARY KEY,
  user_id   TEXT NOT NULL,
  topic     TEXT NOT NULL DEFAULT '一般諮詢',
  summary   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_memories
  ON user_memories(user_id, topic, created_at DESC);

-- 對話歷史表（每一輪的完整訊息）
CREATE TABLE IF NOT EXISTS conversation_history (
  id        BIGSERIAL PRIMARY KEY,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL,
  content   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_history
  ON conversation_history(user_id, created_at ASC);

-- 關閉 RLS（私有後端 bot，不需要行級安全）
ALTER TABLE user_memories        DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_history DISABLE ROW LEVEL SECURITY;
