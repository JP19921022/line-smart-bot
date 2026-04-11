const supabase = require('./supabaseClient');

const MAX_ROWS_PER_USER = 50;

function initMemoryStore() {
  if (supabase) {
    console.log('✅ Memory store: 使用 Supabase 雲端資料庫');
  } else {
    console.warn('⚠️  Memory store: Supabase 未連線，記憶功能停用');
  }
}

async function saveMemory({ userId, topic, summary }) {
  if (!supabase || !userId || !summary) return;

  await supabase.from('user_memories').insert({
    user_id: userId,
    topic: topic || '一般諮詢',
    summary,
  });

  // 只保留最新 MAX_ROWS_PER_USER 筆，刪除超出的舊資料
  const { data: rows } = await supabase
    .from('user_memories')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (rows && rows.length > MAX_ROWS_PER_USER) {
    const idsToDelete = rows.slice(MAX_ROWS_PER_USER).map((r) => r.id);
    await supabase.from('user_memories').delete().in('id', idsToDelete);
  }
}

async function getRecentMemories(userId, topic, limit = 3) {
  if (!supabase || !userId) return [];

  let query = supabase
    .from('user_memories')
    .select('summary, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  // 若有明確主題就篩選，否則取全部
  if (topic && topic !== '一般諮詢') {
    query = query.eq('topic', topic);
  }

  const { data } = await query;
  return (data || []).map((row) => `- ${row.summary}（${row.created_at}）`);
}

// ── 對話歷史（Conversation History）─────────────────────────
const SESSION_MAX_TURNS = 50;
// 本地快取，避免每次都打 API
const localCache = new Map(); // userId -> messages[]

async function loadSessionHistory(userId) {
  if (!supabase || !userId) return [];

  // 若本地有快取就直接用
  if (localCache.has(userId)) return localCache.get(userId);

  const { data } = await supabase
    .from('conversation_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(SESSION_MAX_TURNS * 2);

  const messages = (data || []).map(({ role, content }) => ({ role, content }));
  localCache.set(userId, messages);
  return messages;
}

async function saveSessionMessage(userId, role, content) {
  if (!userId) return;

  // 更新本地快取
  const messages = localCache.get(userId) || [];
  messages.push({ role, content });
  const maxMessages = SESSION_MAX_TURNS * 2;
  if (messages.length > maxMessages) {
    messages.splice(0, messages.length - maxMessages);
  }
  localCache.set(userId, messages);

  // 寫入 Supabase（非同步，不等待）
  if (supabase) {
    supabase.from('conversation_history').insert({ user_id: userId, role, content })
      .then(async () => {
        // 修剪超出上限的舊訊息
        const { data: rows } = await supabase
          .from('conversation_history')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
        if (rows && rows.length > maxMessages) {
          const idsToDelete = rows.slice(maxMessages).map((r) => r.id);
          await supabase.from('conversation_history').delete().in('id', idsToDelete);
        }
      })
      .catch((err) => console.error('saveSessionMessage 失敗：', err));
  }
}

module.exports = {
  initMemoryStore,
  saveMemory,
  getRecentMemories,
  loadSessionHistory,
  saveSessionMessage,
};
