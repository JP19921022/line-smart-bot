// summaryQueue.js
// Tier-2 #5  CRM 摘要持久化佇列
//
// 原本 crmIntegration.js 用 setImmediate() + .catch(console.error) 做 fire-and-forget，
// Render 重啟時正在跑的摘要就沒了。這個模組把「要摘要誰」先寫進 Supabase
// pending_summaries，由一支 worker loop 逐筆處理，成功才 DELETE。
//
// 供 crmIntegration.js 使用：
//   const queue = require('./summaryQueue');
//   queue.start(() => { _anthropic, memoryStore, processFn });
//   queue.enqueue(userId, displayName);
//
// 對外 API：
//   start(opts)      - 啟動 worker（app.js 啟動時呼叫一次）
//   stop()           - 停掉 worker（test / SIGTERM）
//   enqueue(uid, dn) - 放一筆進 queue；若 Supabase 壞了 fallback 到立即執行
//   flushOnce()      - 手動跑一次撿隊列（debug / admin 用）

'use strict';

const supabase = require('./supabaseClient');

const TABLE = 'pending_summaries';
const POLL_INTERVAL_MS = 15 * 1000;   // 15 秒撿一次
const STALE_AFTER_MS   = 5 * 60 * 1000; // processing 超過 5 分鐘 → 視為死掉，還原成 pending
const MAX_RETRY        = 3;
const BATCH_SIZE       = 3;            // 一 tick 最多跑 3 筆，避免打 Anthropic 太凶

let _timer = null;
let _running = false;   // 是否正在跑一輪（避免 interval 疊上去）
let _processFn = null;  // 外部注入：(userId, displayName) => Promise<void>，實際做摘要

function now() { return new Date().toISOString(); }

// ──────────────────────────────────────────────
//  Enqueue
// ──────────────────────────────────────────────
async function enqueue(userId, displayName) {
  if (!userId) return { ok: false, reason: 'no-user-id' };

  // Supabase 不可用 → fallback：直接跑，維持舊行為（至少不會退化）
  if (!supabase) {
    try {
      if (_processFn) await _processFn(userId, displayName);
      return { ok: true, fallback: 'inline' };
    } catch (err) {
      console.error('[summaryQueue] inline fallback failed:', err.message);
      return { ok: false, reason: 'inline-failed' };
    }
  }

  try {
    // 插入一筆 pending；若該 user_id 已有 pending/processing（unique index 擋住），
    // Supabase 會回 23505（unique violation），我們視為「已經排過了」靜默忽略。
    const { error } = await supabase.from(TABLE).insert({
      user_id:      userId,
      display_name: displayName || '',
      status:       'pending',
      enqueued_at:  now()
    });

    if (error) {
      // 23505 = duplicate；那代表已經在佇列裡，不是 error
      const code = error.code || '';
      const msg  = error.message || '';
      if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
        return { ok: true, dedup: true };
      }
      console.error('[summaryQueue] enqueue error:', msg);
      return { ok: false, reason: 'db-error' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[summaryQueue] enqueue threw:', err.message);
    return { ok: false, reason: 'threw' };
  }
}

// ──────────────────────────────────────────────
//  撿死掉的 processing（worker 被 kill 卡住的）
// ──────────────────────────────────────────────
async function _reviveStale() {
  if (!supabase) return;
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  try {
    const { error } = await supabase
      .from(TABLE)
      .update({ status: 'pending', started_at: null })
      .eq('status', 'processing')
      .lt('started_at', cutoff);
    if (error) console.error('[summaryQueue] reviveStale error:', error.message);
  } catch (err) {
    console.error('[summaryQueue] reviveStale threw:', err.message);
  }
}

// ──────────────────────────────────────────────
//  原子領取一筆（status=pending → processing）
//  Supabase 沒有 SELECT FOR UPDATE SKIP LOCKED，用條件式 UPDATE 模擬：
//    UPDATE ... SET status='processing', started_at=NOW()
//    WHERE id=? AND status='pending'
//    RETURNING *
//  如果 affected rows = 0 → 這筆已被別的 worker 搶走
// ──────────────────────────────────────────────
async function _claimOne(row) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: 'processing', started_at: now() })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select();
  if (error) return null;
  if (!data || data.length === 0) return null; // 別的 worker 搶走了
  return data[0];
}

async function _markDone(id) {
  // 成功 → 直接刪掉，表格不堆垃圾
  await supabase.from(TABLE).delete().eq('id', id);
}

async function _markRetry(row, errMsg) {
  const retry = (row.retry_count || 0) + 1;
  const next = retry >= MAX_RETRY ? 'failed' : 'pending';
  await supabase.from(TABLE).update({
    status:      next,
    retry_count: retry,
    last_error:  (errMsg || '').slice(0, 1000),
    started_at:  null
  }).eq('id', row.id);
}

// ──────────────────────────────────────────────
//  一輪：撿 BATCH_SIZE 筆 pending 來處理
// ──────────────────────────────────────────────
async function flushOnce() {
  if (!supabase || !_processFn) return { handled: 0 };
  if (_running) return { handled: 0, skipped: 'already-running' };
  _running = true;
  try {
    await _reviveStale();

    const { data: rows, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('status', 'pending')
      .order('enqueued_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error('[summaryQueue] pick error:', error.message);
      return { handled: 0 };
    }
    if (!rows || rows.length === 0) return { handled: 0 };

    let handled = 0;
    for (const r of rows) {
      const claimed = await _claimOne(r);
      if (!claimed) continue; // 被別人搶走

      try {
        await _processFn(claimed.user_id, claimed.display_name || '');
        await _markDone(claimed.id);
        handled++;
      } catch (err) {
        const m = err && (err.message || String(err));
        console.error(`[summaryQueue] process failed user=${claimed.user_id}:`, m);
        await _markRetry(claimed, m);
      }
    }
    return { handled };
  } finally {
    _running = false;
  }
}

// ──────────────────────────────────────────────
//  啟動 / 停止
// ──────────────────────────────────────────────
function start(opts) {
  if (!opts || typeof opts.processFn !== 'function') {
    throw new Error('summaryQueue.start requires opts.processFn');
  }
  _processFn = opts.processFn;
  if (_timer) return;

  _timer = setInterval(() => {
    flushOnce().catch(err => console.error('[summaryQueue] tick error:', err && err.message));
  }, POLL_INTERVAL_MS);
  if (typeof _timer.unref === 'function') _timer.unref();

  // 啟動時立刻跑一次，把 Render 重啟前沒做完的接起來
  setImmediate(() => {
    flushOnce().catch(err => console.error('[summaryQueue] boot flush error:', err && err.message));
  });

  console.log(`[summaryQueue] worker started, poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE}`);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, enqueue, flushOnce };
