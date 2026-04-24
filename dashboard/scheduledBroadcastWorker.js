// ──────────────────────────────────────────────
//  Tier-2 #7-B  排程推播 worker
// ──────────────────────────────────────────────
//
//  每 30 秒 poll 一次 scheduled_broadcasts，把到時間的 pending
//  原子性 claim 成 running，然後用 linePush 逐筆發送。
//  做完更新為 sent / failed / cancelled。
//
//  設計重點：
//   * 用 conditional UPDATE (WHERE status='pending') 避免多個 dashboard
//     同時 claim 同一筆的 race（目前只會有一個，但防呆）。
//   * fail-open：Supabase 未設定時 worker 直接 no-op，不會 crash dashboard。
//   * retry 上限 3 次；第 4 次 fail 直接標 failed。
//
const fs = require('fs');
const path = require('path');

const POLL_INTERVAL_MS = Number(process.env.SCHEDULED_BROADCAST_POLL_MS || 30000);
const MAX_RETRY = 3;

function loadTargetUsers(segment, tags, userIds, rootDir) {
  // 依 segment 從 contacts.json 選出目標
  const contactsFile = path.join(rootDir, 'contacts.json');
  let contacts = [];
  try {
    contacts = JSON.parse(fs.readFileSync(contactsFile, 'utf8')) || [];
  } catch (e) {
    return { targets: [], error: 'failed to read contacts.json: ' + e.message };
  }

  if (Array.isArray(userIds) && userIds.length > 0) {
    return { targets: userIds.map(String), error: null };
  }

  const tagsLower = Array.isArray(tags) ? tags.map(t => String(t || '').toLowerCase()).filter(Boolean) : [];

  const targets = contacts
    .filter(c => c && c.userId)
    .filter(c => {
      if (segment === 'all') return true;
      return c.enabled !== false;
    })
    .filter(c => {
      if (segment !== 'tags') return true;
      if (tagsLower.length === 0) return false;
      const ctags = (Array.isArray(c.tags) ? c.tags : []).map(t => String(t || '').toLowerCase());
      return tagsLower.some(t => ctags.includes(t));
    })
    .map(c => c.userId);

  return { targets, error: null };
}

async function processOne(supabase, linePush, row, rootDir) {
  const id = row.id;
  const { targets, error: targetErr } = loadTargetUsers(row.segment, row.tags, row.user_ids, rootDir);

  if (targetErr) {
    await markFailed(supabase, id, targetErr, row.retry_count);
    return;
  }
  if (targets.length === 0) {
    await markFailed(supabase, id, 'no targets', row.retry_count);
    return;
  }

  if (!linePush.loadToken || !linePush.loadToken()) {
    // token 暫時拿不到：不消耗 retry，下次 poll 再試
    await supabase.from('scheduled_broadcasts').update({
      status: 'pending', started_at: null, last_error: 'LINE token missing'
    }).eq('id', id);
    return;
  }

  let result;
  try {
    result = await linePush.pushTextToMany(targets, row.message);
  } catch (err) {
    await markFailed(supabase, id, 'push threw: ' + (err && err.message), row.retry_count);
    return;
  }

  await supabase.from('scheduled_broadcasts').update({
    status: 'sent',
    total_targets: targets.length,
    sent_count: result.ok,
    failed_count: result.fail,
    finished_at: new Date().toISOString(),
    last_error: null
  }).eq('id', id);

  console.log(`[scheduled-broadcast] #${id} sent: ${result.ok} ok / ${result.fail} fail (of ${targets.length})`);
}

async function markFailed(supabase, id, errMsg, currentRetry) {
  const retry = Number(currentRetry || 0);
  if (retry + 1 >= MAX_RETRY) {
    await supabase.from('scheduled_broadcasts').update({
      status: 'failed',
      retry_count: retry + 1,
      finished_at: new Date().toISOString(),
      last_error: errMsg
    }).eq('id', id);
    console.error(`[scheduled-broadcast] #${id} FAILED (max retry): ${errMsg}`);
  } else {
    // 回到 pending，等下一輪
    await supabase.from('scheduled_broadcasts').update({
      status: 'pending',
      retry_count: retry + 1,
      started_at: null,
      last_error: errMsg
    }).eq('id', id);
    console.warn(`[scheduled-broadcast] #${id} retry ${retry + 1}/${MAX_RETRY}: ${errMsg}`);
  }
}

async function pollOnce(supabase, linePush, rootDir) {
  if (!supabase) return;

  const nowIso = new Date().toISOString();
  // 找到時間且 pending 的那一筆最舊的
  const { data: rows, error } = await supabase
    .from('scheduled_broadcasts')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('[scheduled-broadcast] poll error:', error.message);
    return;
  }
  if (!rows || rows.length === 0) return;

  const row = rows[0];
  // 嘗試原子性 claim
  const { data: claimed, error: claimErr } = await supabase
    .from('scheduled_broadcasts')
    .update({ status: 'running', started_at: nowIso })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select();

  if (claimErr) {
    console.error('[scheduled-broadcast] claim error:', claimErr.message);
    return;
  }
  if (!claimed || claimed.length === 0) return; // 別人先撿了

  await processOne(supabase, linePush, row, rootDir);
}

function startScheduledBroadcastWorker({ supabase, linePush, rootDir }) {
  if (!supabase) {
    console.warn('[scheduled-broadcast] Supabase 未設定，worker 不啟動');
    return { stop: () => {} };
  }

  let stopped = false;
  let timer = null;

  async function loop() {
    if (stopped) return;
    try { await pollOnce(supabase, linePush, rootDir); }
    catch (e) { console.error('[scheduled-broadcast] loop error:', e.message); }
    if (!stopped) timer = setTimeout(loop, POLL_INTERVAL_MS);
  }

  // 啟動後延遲 5 秒再開跑，讓 dashboard 先穩下來
  timer = setTimeout(loop, 5000);
  console.log(`[scheduled-broadcast] worker 啟動 (poll ${POLL_INTERVAL_MS / 1000}s)`);

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); }
  };
}

module.exports = {
  startScheduledBroadcastWorker,
  loadTargetUsers,   // 給 API preview 用
};
