// linePushHelper.js
// 共用的 LINE push / reply 小工具。被 app.js、dashboard/server.js、
// 以及未來新的排程腳本共用，避免重複實作 fetch LINE API 的程式碼。
//
// push：任何時候都可以送（有 monthly quota 限制）
// reply：只能在用戶剛傳訊息的 30 秒內送，且 replyToken 只能用一次
//
// 讀 token 順序：
//   1) process.env.LINE_CHANNEL_ACCESS_TOKEN
//   2) <root>/.env 檔裡的 LINE_CHANNEL_ACCESS_TOKEN=...
//   （dashboard 在本機跑時 env 可能沒被載入 → 從 .env 檔讀出來）

'use strict';

const fs = require('fs');
const path = require('path');

let _cachedToken = null;

function loadToken() {
  if (_cachedToken) return _cachedToken;
  let tok = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!tok) {
    try {
      // <repoRoot>/.env  —— 這個檔會在 dashboard/server.js 的上一層
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        const txt = fs.readFileSync(envPath, 'utf8');
        const m = txt.match(/^LINE_CHANNEL_ACCESS_TOKEN=(.*)$/m);
        if (m) tok = m[1].trim().replace(/^"|"$/g, '');
      }
    } catch (_) {}
  }
  _cachedToken = tok || null;
  return _cachedToken;
}

async function pushText(userId, text) {
  const token = loadToken();
  if (!token) return { ok: false, reason: 'missing-token' };
  if (!userId || !text) return { ok: false, reason: 'bad-args' };

  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text }]
      })
    });
    const body = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, status: r.status, body };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'threw', error: err && err.message };
  }
}

/**
 * 批次 push：逐一送，回傳成功/失敗筆數。
 * 不 parallel — LINE 有 rate limit，一個一個 fetch 就好。
 */
async function pushTextToMany(userIds, text) {
  const results = [];
  let ok = 0, fail = 0;
  for (const uid of userIds) {
    const r = await pushText(uid, text);
    results.push({ userId: uid, ...r });
    if (r.ok) ok++; else fail++;
  }
  return { ok, fail, results };
}

module.exports = { pushText, pushTextToMany, loadToken };
