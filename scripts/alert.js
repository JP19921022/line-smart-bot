// scripts/alert.js
// 排程 / 長駐任務的故障告警 helper。
// 用法：在排程腳本的 try/catch 裡，catch 分支呼叫 alertOwner(jobName, err)
// 會 push 一則 LINE 訊息到 .env 裡 LINE_TEST_USER_ID（= 你自己），並寫一筆 log。
// 任何失敗（token missing / LINE API 炸掉 / 網路斷）都「吞掉」，
// 不會讓原本的排程錯誤被這個 helper 蓋掉。

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'alert.log');

function logLocal(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch (_) {
    // 最後一道防線都寫不出來就算了，不要再丟 error
  }
}

function twNow() {
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString();
  }
}

function trimErr(e) {
  if (!e) return '(no error object)';
  const msg = (e.stack || e.message || String(e)).toString();
  // LINE 單則文字訊息 5000 字上限，保險 1200
  return msg.length > 1200 ? msg.slice(0, 1200) + '\n…(truncated)' : msg;
}

async function alertOwner(jobName, err, extra) {
  const to = process.env.LINE_TEST_USER_ID;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  const head = `🚨 排程告警：${jobName || 'unknown'}\n時間：${twNow()}`;
  const body = trimErr(err);
  const tail = extra ? `\n---\n${String(extra).slice(0, 500)}` : '';
  const text = `${head}\n---\n${body}${tail}`;

  // 無論如何先寫到本地 log，LINE push 炸掉也還有這份
  logLocal(`[${jobName}] ${String(err && (err.stack || err.message || err)).slice(0, 500)}`);

  if (!to || !token) {
    logLocal(`[${jobName}] missing LINE_TEST_USER_ID or LINE_CHANNEL_ACCESS_TOKEN; skip push`);
    return { ok: false, reason: 'missing-env' };
  }

  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        to,
        messages: [{ type: 'text', text }]
      })
    });
    const rb = await r.text().catch(() => '');
    if (!r.ok) {
      logLocal(`[${jobName}] push failed status=${r.status} body=${rb.slice(0, 300)}`);
      return { ok: false, status: r.status };
    }
    logLocal(`[${jobName}] push ok`);
    return { ok: true };
  } catch (e) {
    logLocal(`[${jobName}] push threw: ${String(e && (e.message || e))}`);
    return { ok: false, reason: 'threw' };
  }
}

// 包裝整個 async main：catch 後吐告警 + 非零 exit
// 用法：require('./scripts/alert').runJob('daily_push', async () => { ...原本的邏輯... });
async function runJob(jobName, mainFn) {
  try {
    await mainFn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[${jobName}] FATAL`, err);
    await alertOwner(jobName, err);
    process.exitCode = 1;
  }
}

module.exports = { alertOwner, runJob };
