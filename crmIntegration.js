'use strict';
const supabase = require('./supabaseClient');

const CRM_BASE_URL = 'https://dashboard.jp-sync.xyz';
const CRM_TOKEN    = process.env.CRM_ADMIN_TOKEN;

// 每累積幾則新訊息就生成一次摘要
const SUMMARY_THRESHOLD = 3;

// ── 從 Supabase 計算距離上次摘要後的新訊息數（Render 重啟也不歸零）──
async function _getMsgCountSinceLastSummary(userId) {
  if (!supabase) return 0;
  try {
    // 取得最近一次摘要的時間
    const { data: lastLog } = await supabase
      .from('interaction_logs')
      .select('created_at')
      .eq('user_id', userId)
      .eq('type', '💬 LINE')
      .order('created_at', { ascending: false })
      .limit(1);

    const since = lastLog && lastLog[0]
      ? lastLog[0].created_at
      : new Date(0).toISOString(); // 從未摘要過 → 從頭算

    // 計算那之後的 user 訊息數
    const { count } = await supabase
      .from('conversation_history')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('role', 'user')
      .gt('created_at', since);

    return count || 0;
  } catch (err) {
    console.error('計算訊息數失敗：', err.message);
    return 0;
  }
}

// ──────────────────────────────────────────────
// 每次 AI 回覆後呼叫：計數 + 必要時自動摘要
// ──────────────────────────────────────────────
async function trackAndMaybeSummarize(userId, displayName, anthropicClient, memoryStore) {
  if (!userId || !anthropicClient) return;

  // 用 Supabase 計數（Render 重啟不歸零），fallback 用記憶體計數
  let count = 0;
  if (supabase) {
    count = await _getMsgCountSinceLastSummary(userId);
  } else {
    // fallback：記憶體計數
    count = (trackAndMaybeSummarize._counter?.get(userId) || 0) + 1;
    if (!trackAndMaybeSummarize._counter) trackAndMaybeSummarize._counter = new Map();
    trackAndMaybeSummarize._counter.set(userId, count);
  }

  console.log(`[CRM] ${displayName || userId} 距上次摘要：${count} 則`);

  if (count < SUMMARY_THRESHOLD) return;

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
  const { clientId, lead } = await _matchCrmClient(userId, displayName);
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

  // ② 寫入 CRM 互動記錄區塊（Route C — 顯示在 App 互動記錄 UI）
  await _pushActivityToCrm(finalClientId, summary);

  // ③ 同步更新 CRM 客戶備忘欄（Route B — 保留向下相容）
  if (lead) {
    await _pushSummaryToCrm(lead, summary);
  }
}

// ──────────────────────────────────────────────
// 透過 CRM API 比對客戶：LINE userId / 顯示名稱 → { clientId, lead }
// 優先用 lineId === userId（精確），次用姓名模糊比對
// ──────────────────────────────────────────────
async function _matchCrmClient(userId, displayName) {
  if (!CRM_TOKEN) return { clientId: null, lead: null };
  try {
    const res = await fetch(`${CRM_BASE_URL}/api/crm/data`, {
      headers: { 'x-admin-token': CRM_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { clientId: null, lead: null };
    const data = await res.json();
    const leads = data.leads || [];

    // ① 優先：lineId 欄位 === LINE userId（最準確）
    let match = leads.find(l => l.lineId && l.lineId.trim() === (userId || '').trim());

    // ② 備用：姓名模糊比對（displayName 包含 CRM 姓名，或 CRM 姓名包含 displayName）
    if (!match && displayName) {
      const dn = displayName.trim().toLowerCase();
      match = leads.find(l => {
        const n = (l.name || '').trim().toLowerCase();
        return n && (dn.includes(n) || n.includes(dn));
      });
    }

    if (match) {
      console.log(`✅ CRM 客戶比對成功：${match.name} (id: ${match.id})`);
    } else {
      console.log(`⚠️ CRM 找不到對應客戶，userId=${userId} displayName=${displayName}`);
    }
    return match ? { clientId: match.id, lead: match } : { clientId: null, lead: null };
  } catch (err) {
    console.error('CRM API 比對失敗：', err.message);
    return { clientId: null, lead: null };
  }
}

// ──────────────────────────────────────────────
// Route C：把摘要寫入 CRM 互動記錄區塊（新 API）
// ──────────────────────────────────────────────
async function _pushActivityToCrm(clientId, summary) {
  if (!CRM_TOKEN || !clientId) return;
  try {
    const res = await fetch(`${CRM_BASE_URL}/api/crm/activities`, {
      method: 'POST',
      headers: {
        'x-admin-token': CRM_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId,
        activity: {
          id:      'a_' + Date.now(),
          type:    '💬 LINE',
          content: summary,
          at:      new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log(`✅ CRM 互動記錄已寫入 → clientId: ${clientId}`);
    } else {
      console.error('CRM 互動記錄寫入失敗：', res.status);
    }
  } catch (err) {
    console.error('CRM 互動記錄寫入錯誤：', err.message);
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
