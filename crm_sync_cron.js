'use strict';
/**
 * crm_sync_cron.js — 定時從 Render Supabase 同步 LINE 對話摘要到 CRM
 * pm2 啟動：pm2 start crm_sync_cron.js --name crm-sync --cron "0 * * * *"
 * 手動測試：node crm_sync_cron.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT           = __dirname;
const CRM_LEADS_FILE = path.join(ROOT, 'data', 'crm_leads.json');
const CONTACTS_FILE  = path.join(ROOT, 'contacts.json');
const CRM_ACTS_FILE  = path.join(ROOT, 'data', 'crm_activities.json');
const RENDER_URL     = (process.env.RENDER_BASE_URL || 'https://line-smart-bot-sg.onrender.com')
                      + '/admin/line-summaries?token='
                      + (process.env.ADMIN_EXPORT_TOKEN || '9be202464d61893592d114323d863068d8d07a8e2aa8f42a');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ── 建立 lineId / userId → CRM lead.id 的映射 ──
function buildMap(leads, contacts) {
  const map = new Map(); // userId → { crmId, name }
  for (const l of leads) {
    if (l.lineId) map.set(l.lineId.trim(), { crmId: l.id, name: l.name });
  }
  for (const c of contacts) {
    if (!c.userId || map.has(c.userId)) continue;
    const dn = (c.name || '').trim().toLowerCase();
    const m = leads.find(l => {
      const n = (l.name || '').trim().toLowerCase();
      return n && dn && (n.includes(dn) || dn.includes(n));
    });
    if (m) map.set(c.userId, { crmId: m.id, name: m.name });
  }
  return map;
}

// ── 自動配對：把 contacts.json 未配對的 userId 補入 crm_leads.json ──
function autoLinkNewContacts(leads, contacts) {
  const existingIds = new Set(leads.filter(l => l.lineId).map(l => l.lineId.trim()));
  let updated = 0;
  for (const c of contacts) {
    if (!c.userId || c.userId === 'U_TEST_001') continue;
    if (existingIds.has(c.userId)) continue;
    // 名字比對
    const dn = (c.name || '').trim().toLowerCase();
    const match = leads.find(l => {
      if (l.lineId) return false; // 已配對的跳過
      const n = (l.name || '').trim().toLowerCase();
      return n && dn && n.length > 1 && (n.includes(dn) || dn.includes(n));
    });
    if (match) {
      match.lineId    = c.userId;
      match.lineBound = 'yes';
      match.updatedAt = new Date().toISOString();
      existingIds.add(c.userId);
      updated++;
      console.log(`  🔗 自動配對：${c.name} → ${match.name} (${match.id})`);
    }
  }
  return updated;
}

async function runSync() {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log(`\n[${now}] 🔄 開始同步 LINE 對話摘要...`);

  // 1. 讀取本機資料
  const leadsRaw = readJson(CRM_LEADS_FILE, []);
  const leads    = Array.isArray(leadsRaw) ? leadsRaw : (leadsRaw.leads || []);
  const contacts = readJson(CONTACTS_FILE, []);

  // 2. 自動配對未連結的聯絡人
  const linked = autoLinkNewContacts(leads, contacts);
  if (linked > 0) {
    writeJson(CRM_LEADS_FILE, leads);
    console.log(`  ✅ 自動配對 ${linked} 位新客戶的 lineId`);
  }

  // 3. 建立映射 map
  const map = buildMap(leads, contacts);
  console.log(`  buildMap: ${map.size} 筆對應`);

  // 4. 從 Render 拉摘要
  let summaries = [];
  try {
    const data = await fetchJson(RENDER_URL);
    summaries = data.summaries || [];
    console.log(`  Render 回傳 ${summaries.length} 筆摘要`);
  } catch(e) {
    console.error(`  ❌ Render 拉取失敗: ${e.message}`);
    return;
  }

  if (summaries.length === 0) {
    console.log('  ⚠️ 0 筆摘要，無需更新');
    return;
  }

  // 5. 合併到 crm_activities.json
  const all = readJson(CRM_ACTS_FILE, {});
  let merged = 0, skipped = 0;

  for (const row of summaries) {
    let cid  = row.client_id || '';
    let name = row.display_name || '';

    // 嘗試換成 CRM imp_xxx id
    if (cid.startsWith('line_')) {
      const uid = cid.replace(/^line_/, '');
      const info = map.get(uid);
      if (info) { cid = info.crmId; name = info.name; }
    }
    if (row.user_id && (!cid || cid.startsWith('line_'))) {
      const info = map.get(row.user_id);
      if (info) { cid = info.crmId; name = info.name; }
    }

    // 如果還是無法配對，用 LINE 名字建立臨時 key（讓使用者能看到）
    if (!cid || cid.startsWith('line_')) {
      skipped++;
      continue; // 暫時跳過，等用戶在 CRM 建立該聯絡人
    }

    const act = {
      id:      'sb_' + (row.id || Date.now() + Math.random()),
      type:    '💬 LINE',
      content: row.content || '',
      at:      row.created_at || new Date().toISOString(),
    };
    if (!Array.isArray(all[cid])) all[cid] = [];
    if (!all[cid].some(a => a.id === act.id)) { all[cid].push(act); merged++; }
  }

  // 排序並限制每人最多 200 筆
  for (const cid of Object.keys(all)) {
    all[cid].sort((a, b) => new Date(b.at) - new Date(a.at));
    if (all[cid].length > 200) all[cid] = all[cid].slice(0, 200);
  }

  writeJson(CRM_ACTS_FILE, all);
  const total = Object.values(all).reduce((s, a) => s + a.length, 0);
  console.log(`  ✅ 同步完成：${merged} 筆新增，${skipped} 筆待配對，共 ${total} 筆（${Object.keys(all).length} 位客戶）`);
}

// 立即執行一次
runSync().catch(console.error);

// 之後每 30 分鐘執行一次（pm2 cron 模式下其實不會到這裡，但手動執行時有用）
if (process.env.NODE_ENV !== 'cron') {
  setInterval(() => runSync().catch(console.error), 30 * 60 * 1000);
  console.log('⏰ 自動同步已啟動，每 30 分鐘執行一次');
}
