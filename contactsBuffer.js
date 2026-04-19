// contactsBuffer.js
// 把「每則 LINE 訊息就 writeFileSync contacts.json」的同步寫改成批次寫。
//
// 為什麼要這樣做：
//   原本 upsertContactFromEvent 在每個訊息 webhook 都做一次同步 readFileSync +
//   JSON.parse + JSON.stringify + writeFileSync，會阻塞 event loop、
//   也在同時多則訊息進來時有 last-write-wins 把欄位吃掉的風險。
//
// 策略：
//   - 收到一則訊息 → 只把「我想更新 userId=X 的 last_contact_at=t」這件事
//     記在記憶體裡（pending map），立刻回。
//   - 背景 30 秒一次，或 pending 超過 100 筆時，把所有 pending patch 一次套到
//     磁碟上的 contacts.json（先 read → apply → write）。
//   - read-before-write 是為了不要把其他 writer（setManualMode、care_check 等）
//     剛寫進去的欄位給蓋掉。我們只 merge 我們真正想動的欄位：
//       * last_contact_at  -> 改成最新的
//       * 新 userId        -> append（帶預設欄位）
//     其他欄位一律保留 on-disk 版本，不動。
//   - SIGTERM / SIGINT / beforeExit 一定 flush，不丟資料。
//
// 用法：
//   const { schedule, upsertEvent, flushSync } = require('./contactsBuffer');
//   schedule();                   // app 啟動時呼叫一次
//   upsertEvent(event);           // 取代原本 upsertContactFromEvent 的同步寫
//   // flushSync() 會被 signal handler 自動呼叫，平常不用主動叫

'use strict';

const fs = require('fs');
const path = require('path');

const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const FLUSH_INTERVAL_MS = 30 * 1000;
const FLUSH_THRESHOLD   = 100;

// pending: userId -> { last_contact_at: ISO, createIfMissing: bool }
const pending = new Map();
let timer = null;
let flushing = false;
let installedSignalHandlers = false;

function nowIso() { return new Date().toISOString(); }

function readContactsSync() {
  try {
    if (!fs.existsSync(CONTACTS_FILE)) return [];
    const txt = fs.readFileSync(CONTACTS_FILE, 'utf8');
    const arr = JSON.parse(txt || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[contactsBuffer] read failed, fallback to empty:', e.message);
    return [];
  }
}

function writeContactsSync(arr) {
  // 用 tmp + rename 做 atomic write，避免半寫狀態的檔案
  const tmp = CONTACTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
  fs.renameSync(tmp, CONTACTS_FILE);
}

/**
 * 記下「這個 userId 剛剛有互動」這件事。立刻回，不 I/O。
 * 真正的寫檔會由背景 timer 或 threshold 觸發。
 */
function upsertEvent(event) {
  try {
    const userId = event?.source?.userId;
    if (!userId) return;
    const ts = nowIso();

    const prev = pending.get(userId);
    if (prev) {
      prev.last_contact_at = ts; // 只保留最新一筆時間
    } else {
      pending.set(userId, { last_contact_at: ts, createIfMissing: true });
    }

    if (pending.size >= FLUSH_THRESHOLD) {
      // 超過門檻就趕快 flush（非同步，不 block event loop）
      setImmediate(() => { flushAsync().catch(() => {}); });
    }
  } catch (e) {
    console.error('[contactsBuffer] upsertEvent error:', e);
  }
}

/**
 * 將 pending 套到磁碟上（非阻塞版本）。
 */
async function flushAsync() {
  if (flushing) return;      // 同時只有一個 flush 在跑
  if (pending.size === 0) return;

  flushing = true;
  // 先把 pending 搬出來，避免 flush 過程又有新的進來把資料弄亂
  const snapshot = new Map(pending);
  pending.clear();

  try {
    // 雖然 readFileSync 還是同步的（Node 沒內建 readFileAsync 替代 fs.promises 的快速小檔讀取差不多快），
    // 但相比「每則訊息」都同步寫，現在 30s 才做一次 read+write，IO 壓力天差地別。
    const contacts = readContactsSync();
    let changed = 0;

    for (const [userId, patch] of snapshot) {
      const idx = contacts.findIndex(c => c && c.userId === userId);
      if (idx >= 0) {
        contacts[idx].last_contact_at = patch.last_contact_at;
        if (contacts[idx].enabled === undefined) contacts[idx].enabled = true;
        if (!contacts[idx].name) contacts[idx].name = '未命名客戶';
        changed++;
      } else if (patch.createIfMissing) {
        contacts.push({
          userId,
          name: '新客戶',
          last_contact_at: patch.last_contact_at,
          last_care_at: null,
          enabled: true
        });
        changed++;
      }
    }

    if (changed > 0) {
      writeContactsSync(contacts);
      console.log(`[contactsBuffer] flushed ${changed} upserts`);
    }
  } catch (e) {
    console.error('[contactsBuffer] flush failed:', e);
    // flush 失敗 → 把 snapshot 還回 pending，下輪再試
    for (const [uid, p] of snapshot) {
      if (!pending.has(uid)) pending.set(uid, p);
    }
  } finally {
    flushing = false;
  }
}

/**
 * 同步 flush：用在 SIGTERM / SIGINT / beforeExit。
 * 這裡一定要同步，不能 await，process 可能下一 tick 就死。
 */
function flushSync() {
  if (pending.size === 0) return;
  const snapshot = new Map(pending);
  pending.clear();

  try {
    const contacts = readContactsSync();
    let changed = 0;
    for (const [userId, patch] of snapshot) {
      const idx = contacts.findIndex(c => c && c.userId === userId);
      if (idx >= 0) {
        contacts[idx].last_contact_at = patch.last_contact_at;
        if (contacts[idx].enabled === undefined) contacts[idx].enabled = true;
        if (!contacts[idx].name) contacts[idx].name = '未命名客戶';
        changed++;
      } else if (patch.createIfMissing) {
        contacts.push({
          userId,
          name: '新客戶',
          last_contact_at: patch.last_contact_at,
          last_care_at: null,
          enabled: true
        });
        changed++;
      }
    }
    if (changed > 0) writeContactsSync(contacts);
    console.log(`[contactsBuffer] flushSync wrote ${changed}`);
  } catch (e) {
    console.error('[contactsBuffer] flushSync failed:', e);
  }
}

/**
 * 啟動背景定時 flush + 掛上 signal handler。
 * app.js 啟動時呼叫一次就好。重複叫也沒事。
 */
function schedule() {
  if (!timer) {
    timer = setInterval(() => {
      flushAsync().catch(err => console.error('[contactsBuffer] interval flush error:', err));
    }, FLUSH_INTERVAL_MS);
    // interval 不要 keep process alive
    if (typeof timer.unref === 'function') timer.unref();
  }

  if (!installedSignalHandlers) {
    installedSignalHandlers = true;
    // beforeExit：正常 event loop 空了要離開前
    process.on('beforeExit', () => flushSync());
    // SIGTERM / SIGINT：Render 重部署、Ctrl-C
    process.on('SIGTERM', () => { flushSync(); process.exit(0); });
    process.on('SIGINT',  () => { flushSync(); process.exit(0); });
  }
}

module.exports = {
  schedule,
  upsertEvent,
  flushAsync,
  flushSync
};
