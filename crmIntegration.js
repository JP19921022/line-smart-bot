'use strict';
const supabase = require('./supabaseClient');

const CRM_BASE_URL = 'https://dashboard.jp-sync.xyz';
const CRM_TOKEN    = process.env.CRM_ADMIN_TOKEN;

// 每累積幾則新訊息就生成一次摘要
const SUMMARY_THRESHOLD = 10;

// 本地計數器 { userId: count }（重啟歸零，但不影響功能）
const msgCounter = new Map();

// ──────────────────────────────────────────────
// 每次 AI 回覆後呼叫：計數 + 必要時自動摘要
// ──────────────────────────────────────────────
async function trackAndMaybeSummarize(userId, displayName, anthropicClient, memoryStore) {
  if (!userId || !anthropicClient) return;

  const count = (msgCounter.get(userId) || 0) + 1;
  msgCounter.set(userId, count);

  if (count < SUMMARY_THRESHOLD) return;
  msgCounter.set(userId, 0); // 重置計數

  // 非同步執行，不阻塞主回覆流程
  setImmediate(() => {
    _generateAndStore(userId, displayName, anthropicClient, memoryStore)
      .catch(err => console.error('CRM 摘要失敗：', err.message));
  });
}

// ──────────────────────────────────────────────
// 生成對話摘要並寫入 Supabase + CRM
// ──────────────────────────────────────────────
async function _generateAndStore(userId, displayName, anthropicClient, memoryStore) {
  // 取最近 20 則對話
  const history = await memoryStore.loadSessionHistory(userId);
  if (!history || history.length < 5) return;

  const recent = history.slice(-20);
  const conversationText = recent
    .map(m => `${m.role === 'user' ? '客戶' : '小平'}：${m.content}`)
    .join('\n');

  // 用 Haiku 快速生成摘要（省費用）
  const summaryPrompt = `請將以下 LINE 對話整理成「互動記錄摘要」，格式：
- 客戶主要問題/需求：
- 討論重點：
- 客戶意願（冷淡 / 有興趣 / 積極）：
- 建議下次跟進重點：
字數 150 字以內，繁體中文。

對話記錄：
${conversationText}`;

  let summary = '';
  try {
    const res = await anthropicClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: summaryPrompt }],
    });
    summary = res.content[0].text.trim();
  } catch (err) {
    console.error('摘要 AI 呼叫失敗：', err.message);
    return;
  }

  // 比對 CRM 客戶 ID
  const clientId = await _matchCrmClient(displayName);
  const finalClientId = clientId || `line_${userId}`;

  // 寫入 Supabase interaction_logs
  if (supabase) {
    const { error } = await supabase.from('interaction_logs').insert({
      client_id:    finalClientId,
      user_id:      userId,
      display_name: displayName || '',
      type:         '💬 LINE',
      content:      summary,
    });
    if (error) {
      console.error('interaction_logs 寫入失敗：', error.message);
    } else {
      console.log(`✅ LINE 摘要已儲存 → ${displayName || userId}（CRM ID: ${finalClientId}）`);
    }
  }
}

// ──────────────────────────────────────────────
// 透過 CRM API 比對客戶：LINE 顯示名稱 → client_id
// ──────────────────────────────────────────────
async function _matchCrmClient(displayName) {
  if (!CRM_TOKEN || !displayName) return null;
  try {
    const res = await fetch(`${CRM_BASE_URL}/api/crm/data`, {
      headers: { 'x-admin-token': CRM_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const leads = data.leads || [];
    const match = leads.find(l =>
      l.lineId && l.lineId.trim() === displayName.trim() && l.lineBound === 'yes'
    );
    return match ? match.id : null;
  } catch (err) {
    console.error('CRM API 比對失敗：', err.message);
    return null;
  }
}

// ──────────────────────────────────────────────
// 手動觸發：立即生成並儲存當前對話摘要
// 可由特定關鍵字（如「結束對話」）或 webhook 呼叫
// ──────────────────────────────────────────────
async function forceSummary(userId, displayName, anthropicClient, memoryStore) {
  msgCounter.set(userId, 0);
  await _generateAndStore(userId, displayName, anthropicClient, memoryStore);
}

module.exports = { trackAndMaybeSummarize, forceSummary };
