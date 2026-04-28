'use strict';
const supabase = require('./supabaseClient');
const summaryQueue = require('./summaryQueue');

const CRM_BASE_URL = 'https://dashboard.jp-sync.xyz';
const CRM_TOKEN    = process.env.CRM_ADMIN_TOKEN;

// 把 memoryStore 鎖在 module scope，讓 summaryQueue 的 worker tick 可以抓到
let _memoryStoreRef = null;
let _queueStarted   = false;

// 每累積幾則新訊息就生成一次摘要
const SUMMARY_THRESHOLD = 3;

// ── 自建 Anthropic client（不依賴外部傳入，確保 Gemini 路線也能生成摘要）──
let _anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('[CRM] Anthropic client 初始化成功');
  } else {
    console.warn('[CRM] ANTHROPIC_API_KEY 未設定，CRM 摘要功能停用');
  }
} catch (e) {
  console.error('[CRM] Anthropic 初始化失敗：', e.message);
}

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

// ── 確保聯絡人永久存在 Supabase（Render 重啟也不遺失）──────────
async function ensureContactInSupabase(userId, displayName) {
  if (!supabase || !userId) return;
  try {
    const { count } = await supabase
      .from('interaction_logs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (!count) {
      await supabase.from('interaction_logs').insert({
        client_id: `line_${userId}`,
        user_id: userId,
        display_name: displayName || '新客戶',
        type: '👤 新聯絡人',
        content: '首次傳訊，系統自動建立聯絡人記錄',
      });
      console.log(`[CRM] 新聯絡人已存入 Supabase：${displayName || userId}`);
    }
  } catch (e) {
    // 非關鍵，靜默忽略
  }
}

// ──────────────────────────────────────────────
// 每次 AI 回覆後呼叫：計數 + 必要時自動摘要
// ──────────────────────────────────────────────
async function trackAndMaybeSummarize(userId, displayName, _passedClient, memoryStore) {
  // 優先用自建 client，確保 Gemini 路線也能生成摘要
  const client = _anthropic || _passedClient;
  if (!userId || !client) return;

  // 每則訊息都確保聯絡人存在 Supabase（Render 重啟不遺失任何人）
  ensureContactInSupabase(userId, displayName).catch(() => {});

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

  // 🔁 Tier-2 #5：改進 Supabase pending_summaries 佇列，worker 會撿起來做。
  //    Render 重啟不再蒸發。memoryStore 用 module scope ref 鎖住，worker tick 時才抓得到。
  _memoryStoreRef = memoryStore || _memoryStoreRef;
  _ensureQueueStarted();
  summaryQueue.enqueue(userId, displayName).catch(err => {
    console.error('[CRM] 摘要 enqueue 失敗:', err && err.message);
  });
}

// 只啟動一次：把 processFn 注入 queue，worker 撿到 row 時會呼叫 _generateAndStore
function _ensureQueueStarted() {
  if (_queueStarted) return;
  _queueStarted = true;
  const client = _anthropic;
  if (!client) {
    console.warn('[CRM] summaryQueue: Anthropic 未設定，worker 以降級模式啟動');
  }
  summaryQueue.start({
    processFn: async (uid, dn) => {
      // worker tick 會呼叫這裡 → 直接走原本的 _generateAndStore
      if (!_memoryStoreRef) {
        // 如果在 enqueue 之前重啟過，memoryStoreRef 可能是 null；
        // 此 tick 先丟錯，queue 會 retry；下一則訊息進來 track 時會 set ref。
        throw new Error('memoryStore ref not set yet');
      }
      await _generateAndStore(uid, dn, client, _memoryStoreRef);
    }
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
    // err.message 對 Anthropic SDK 來說常常是 "400 {...JSON...}"，先解一層
    const status = err && (err.status || err.statusCode);
    const rawMsg = (err && err.message) || String(err);
    let parsedMsg = rawMsg;
    try {
      const m = rawMsg.match(/\{.*\}$/s);
      if (m) {
        const j = JSON.parse(m[0]);
        if (j && j.error && j.error.message) parsedMsg = j.error.message;
      }
    } catch (_) { /* keep rawMsg */ }
    console.error(`摘要 AI 呼叫失敗 [status=${status || 'n/a'}]：${parsedMsg}`);

    // 錯誤寫入 Supabase，方便診斷
    // 注意：supabase-js v2 的 .insert() 回傳的是 PostgrestFilterBuilder（thenable），
    //      它沒有 .catch() 方法。一定要用 try/catch 包，不能 .catch(() => {})。
    //      之前用 .catch(() => {}) 會丟 "TypeError: ... .catch is not a function"，
    //      worker retry 3 次都跑這條，把真正的 Anthropic 錯誤蓋掉。
    if (supabase) {
      try {
        await supabase.from('interaction_logs').insert({
          client_id:    `line_${userId}`,
          user_id:      userId,
          display_name: displayName || '',
          type:         '❌ ERROR',
          content:      `AI 呼叫失敗 [${status || 'n/a'}]：${parsedMsg}`.slice(0, 1000),
        });
      } catch (logErr) {
        console.error('寫入 ❌ ERROR log 也失敗：', logErr && logErr.message);
      }
    }

    // 4xx → 通常是餘額 / auth / model 名稱問題，retry 也沒用
    //        return 讓 worker markDone（不堆 queue），下次新訊息進來會重新 enqueue
    // 5xx / 無 status / timeout → throw 讓 worker retry
    const isPermanent = status && status >= 400 && status < 500;
    if (isPermanent) return;
    throw new Error(`anthropic_transient status=${status || 'n/a'}: ${parsedMsg}`);
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
async function forceSummary(userId, displayName, _passedClient, memoryStore) {
  const client = _anthropic || _passedClient;
  if (!client) { console.error('[CRM] forceSummary: 無可用 Anthropic client'); return; }
  await _generateAndStore(userId, displayName, client, memoryStore);
}

module.exports = { trackAndMaybeSummarize, forceSummary };
