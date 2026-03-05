const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MEMORY_DB_PATH = path.resolve(__dirname, 'data', 'memory.db');
const MAX_ROWS_PER_USER = 50;
let db;

function initMemoryStore() {
  const dir = path.dirname(MEMORY_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(MEMORY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_user_topic ON user_memories(user_id, topic, created_at DESC)').run();
}

function saveMemory({ userId, topic, summary }) {
  if (!db || !userId || !summary) {
    return;
  }
  db.prepare('INSERT INTO user_memories (user_id, topic, summary) VALUES (?, ?, ?)').run(userId, topic || '一般諮詢', summary);
  db.prepare(`
    DELETE FROM user_memories
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id FROM user_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
      )
  `).run(userId, userId, MAX_ROWS_PER_USER);
}

function getRecentMemories(userId, topic, limit = 3) {
  if (!db || !userId) {
    return [];
  }
  const rows = db.prepare(`
    SELECT summary, created_at
    FROM user_memories
    WHERE user_id = ?
      AND (topic = ? OR ? = '一般諮詢')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, topic, topic, limit);
  return rows.map((row) => `- ${row.summary}（${row.created_at}）`);
}

module.exports = {
  initMemoryStore,
  saveMemory,
  getRecentMemories,
};
