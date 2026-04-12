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

  // 比對 CRM 客戶（取得 lead 物件 + client_id）
  const { clientId, lead } = await _matchCrmClient(displayName);
  const finalClientId = clientId || `line_${userId}`;

  // ① 寫入 Supabase interaction_logs
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
      console.log(`✅ Supabase 摘要已儲存 → ${displayName || userId}`);
    }
  }

  // ② 同步更新 CRM 客戶備忘欄（Route B）
  if (lead) {
    await _pushSummaryToCrm(lead, summary);
  }
}

// ──────────────────────────────────────────────
// 透過 CRM API 比對客戶：LINE 顯示名稱 → { clientId, lead }
// ──────────────────────────────────────────────
async function _matchCrmClient(displayName) {
  if (!CRM_TOKEN || !displayName) return { clientId: null, lead: null };
  try {
    const res = await fetch(`${CRM_BASE_URL}/api/crm/data`, {
      headers: { 'x-admin-token': CRM_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { clientId: null, lead: null };
    const data = await res.json();
    const leads = data.leads || [];
    const match = leads.find(l =>
      l.lineId && l.lineId.trim() === displayName.trim() && l.lineBound === 'yes'
    );
    return match ? { clientId: match.id, lead: match } : { clientId: null, lead: null };
  } catch (err) {
    console.error('CRM API 比對失敗：', err.message);
    return { clientId: null, lead: null };
  }
}

// ──────────────────────────────────────────────
// 把 LINE 摘要追加寫入 CRM 客戶備忘欄（note）
// 並透過 CRM API 全量更新 leads
// ──────────────────────────────────────────────
async function _pushSummaryToCrm(matchedLead, summary) {
  if (!CRM_TOKEN) return;
  try {
    // 先取得所有 leads（避免覆蓋其他客戶資料）
    const getRes = await fetch(`${CRM_BASE_URL}/api/crm/data`, {
      headers: { 'x-admin-token': CRM_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!getRes.ok) return;
    const data = await getRes.json();
    const leads = data.leads || [];

    // 時間戳記 + 摘要，追加到備忘欄前端
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const noteEntry = `【LINE摘要 ${now}】\n${summary}\n${'─'.repeat(20)}\n`;

    // 更新對應客戶的 note 欄位
    const updatedLeads = leads.map(l => {
      if (l.id !== matchedLead.id) return l;
      return {
        ...l,
        note: noteEntry + (l.note || ''),
        updatedAt: new Date().toISOString(),
      };
    });

    // 全量寫回 CRM
    const postRes = await fetch(`${CRM_BASE_URL}/api/crm/data`, {
      method: 'POST',
      headers: {
        'x-admin-token': CRM_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ leads: updatedLeads }),
      signal: AbortSignal.timeout(8000),
    });

    if (postRes.ok) {
      console.log(`✅ CRM 備忘欄已更新 → ${matchedLead.name || matchedLead.lineId}`);
    } else {
      console.error('CRM API 寫入失敗：', postRes.status);
    }
  } catch (err) {
    console.error('CRM 備忘欄更新失敗：', err.message);
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
