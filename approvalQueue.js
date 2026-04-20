// approvalQueue.js
// Tier-2 #6  敏感詞審核佇列 — 寫入端（app.js 用）
//
// app.js 收到訊息、AI 擬好 draftReply 後，呼叫：
//   const held = await approvalQueue.maybeHold({ event, userText, draftReply, displayName });
//   if (held) { reply a safe placeholder; return; }
//   else      { send draftReply as normal; }
//
// 也可以給 cron 用的 send worker（approved 狀態送出 → 標記 sent）—
// 但目前實作裡「approve」的送出是在 dashboard/server.js 的 POST /api/approval-queue/:id/approve
// 路由直接做，因為 dashboard 本身就有 LINE token，不必跨程序排隊。
//
// 敏感詞預設：理賠 / 退保 / 客訴 / 投訴 / 申訴 / 取消契約
// 可用環境變數 APPROVAL_KEYWORDS（逗號分隔）覆蓋。

'use strict';

const supabase = require('./supabaseClient');

const DEFAULT_KEYWORDS = ['理賠', '退保', '客訴', '投訴', '申訴', '取消契約', '解約'];

function getKeywords() {
  const raw = (process.env.APPROVAL_KEYWORDS || '').trim();
  if (!raw) return DEFAULT_KEYWORDS;
  return raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
}

function detectKeywords(text) {
  if (!text) return [];
  const kw = getKeywords();
  const hit = [];
  for (const k of kw) {
    if (text.includes(k)) hit.push(k);
  }
  return hit;
}

/**
 * 檢查 userText 有沒有敏感詞；有就把 draftReply 存進 approval_queue。
 * 回傳：
 *   { held: true,  id }  → app.js 應該「不」送 draftReply，改回 safeResponse
 *   { held: false }      → app.js 照原本流程送 draftReply
 *   { held: false, reason } → 異常（例如 Supabase 不可用）
 */
async function maybeHold({ event, userText, draftReply, displayName }) {
  const matched = detectKeywords(userText);
  if (matched.length === 0) return { held: false };

  // 如果 Supabase 無法用，fail open：不擋訊息，讓系統照常回。
  // 這是刻意設計 — 我們不能因為 DB 壞了就讓所有敏感詞對話被丟棄。
  if (!supabase) {
    console.warn('[approvalQueue] supabase not available, skipping hold');
    return { held: false, reason: 'no-supabase' };
  }

  const userId = event?.source?.userId || null;
  if (!userId) return { held: false, reason: 'no-user-id' };

  try {
    const { data, error } = await supabase.from('approval_queue').insert({
      user_id:          userId,
      display_name:     displayName || '',
      incoming_text:    (userText || '').slice(0, 2000),
      draft_reply:      (draftReply || '').slice(0, 4000),
      matched_keywords: matched,
      status:           'pending'
    }).select().single();

    if (error) {
      console.error('[approvalQueue] insert failed:', error.message);
      return { held: false, reason: 'db-error' };
    }
    console.log(`[approvalQueue] HELD id=${data.id} user=${userId} kw=${matched.join(',')}`);
    return { held: true, id: data.id, matched };
  } catch (err) {
    console.error('[approvalQueue] threw:', err && err.message);
    return { held: false, reason: 'threw' };
  }
}

module.exports = { maybeHold, detectKeywords, getKeywords };
