// ──────────────────────────────────────────────
//  Tier-2 #8-B  Retention cleaner
// ──────────────────────────────────────────────
//
//  定期把 Supabase 幾張「稽核用」的表清掉老資料，避免久了累積太多
//  客戶訊息內容留著（符合最小保留原則，也方便 UI 載入）：
//
//    approval_queue       — sent/rejected/failed 超過 N 天清掉
//    scheduled_broadcasts — sent/cancelled/failed 超過 N 天清掉
//    pending_summaries    — failed 超過 N 天清掉
//
//  保留天數預設 14。改 env  CRM_RETENTION_DAYS  可以覆蓋。
//  每 6 小時跑一次；啟動後 30 秒做第一次。
//

const DEFAULT_RETENTION_DAYS = Number(process.env.CRM_RETENTION_DAYS || 14);
const CLEAN_INTERVAL_MS = Number(process.env.CRM_RETENTION_INTERVAL_MS || 6 * 60 * 60 * 1000);
const FIRST_DELAY_MS = 30 * 1000;

async function cleanTable(supabase, table, statusList, timeColumn, days) {
  const cutoffIso = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const { data, error } = await supabase
    .from(table)
    .delete()
    .in('status', statusList)
    .lt(timeColumn, cutoffIso)
    .select('id');
  if (error) {
    console.warn(`[retention] ${table} clean error:`, error.message);
    return 0;
  }
  return Array.isArray(data) ? data.length : 0;
}

async function runOnce(supabase, days) {
  if (!supabase) return;
  try {
    const a = await cleanTable(supabase, 'approval_queue',
      ['sent', 'rejected', 'failed'], 'created_at', days);
    const b = await cleanTable(supabase, 'scheduled_broadcasts',
      ['sent', 'cancelled', 'failed'], 'created_at', days);
    const c = await cleanTable(supabase, 'pending_summaries',
      ['failed'], 'enqueued_at', days);
    if (a + b + c > 0) {
      console.log(`[retention] cleaned: approval_queue=${a}, scheduled_broadcasts=${b}, pending_summaries=${c} (>${days}d)`);
    }
  } catch (e) {
    console.warn('[retention] run error:', e.message);
  }
}

function startRetentionCleaner({ supabase }) {
  if (!supabase) {
    console.warn('[retention] Supabase 未設定，cleaner 不啟動');
    return { stop: () => {} };
  }
  let stopped = false;
  let timer = null;
  async function loop() {
    if (stopped) return;
    await runOnce(supabase, DEFAULT_RETENTION_DAYS);
    if (!stopped) timer = setTimeout(loop, CLEAN_INTERVAL_MS);
  }
  timer = setTimeout(loop, FIRST_DELAY_MS);
  console.log(`[retention] cleaner 啟動（保留 ${DEFAULT_RETENTION_DAYS} 天，每 ${CLEAN_INTERVAL_MS/3600000}h 跑一次）`);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

module.exports = { startRetentionCleaner };
