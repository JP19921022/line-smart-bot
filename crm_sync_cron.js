'use strict';
/**
 * crm_sync_cron.js — 定時從 Render 同步 LINE 對話摘要到 CRM
 * 功能：同步摘要 / 自動建檔新客戶 / keep-alive ping
 * pm2：pm2 start crm_sync_cron.js --name crm-sync
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT           = __dirname;
const CRM_LEADS_FILE = path.join(ROOT, 'data', 'crm_leads.json');
const CONTACTS_FILE  = path.join(ROOT, 'contacts.json');
const CRM_ACTS_FILE  = path.join(ROOT, 'data', 'crm_activities.json');
const RENDER_BASE    = process.env.RENDER_BASE_URL || 'https://line-smart-bot-sg.onrender.com';
const RENDER_URL     = RENDER_BASE + '/admin/line-summaries?token='
                     + (process.env.ADMIN_EXPORT_TOKEN || '9be202464d61893592d114323d863068d8d07a8e2aa8f42a');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function fetchJson(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── keep-alive：每 10 分鐘 ping Render ──────────
function keepAlive() {
  https.get(RENDER_BASE + '/status', { timeout: 10000 }, (res) => {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[${now}] 💓 Render 狀態: HTTP ${res.statusCode}`);
    res.resume();
  }).on('error', (e) => {
    console.warn(`💓 Keep-alive 失敗: ${e.message}`);
  }).on('timeout', function() { this.destroy(); });
}

// ── 建立 lineId → CRM lead 的映射 ──────────────
function buildMap(leads, contacts) {
  const map = new Map();
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

// ── 名字比對自動配對 ───────────────────────────
function autoLinkNewContacts(leads, contacts) {
  const existingIds = new Set(leads.filter(l => l.lineId).map(l => l.lineId.trim()));
  let updated = 0;
  for (const c of contacts) {
    if (!c.userId || c.userId === 'U_TEST_001') continue;
    if (existingIds.has(c.userId)) continue;
    const dn = (c.name || '').trim().toLowerCase();
    const match = leads.find(l => {
      if (l.lineId) return false;
      const n = (l.name || '').trim().toLowerCase();
      return n && dn && n.length > 1 && (n.includes(dn) || dn.includes(n));
    });
    if (match) {
      match.lineId = c.userId; match.lineBound = 'yes';
      match.updatedAt = new Date().toISOString();
      existingIds.add(c.userId); updated++;
      console.log(`  🔗 自動配對：${c.name} → ${match.name}`);
    }
  }
  return updated;
}

// ── 自動建立新客戶 CRM 名片 ────────────────────
function autoCreateNewLeads(leads, summaries, map) {
  const existingLineIds = new Set(leads.filter(l => l.lineId).map(l => l.lineId.trim()));
  let created = 0;
  const seen = new Set();

  for (const row of summaries) {
    const uid = row.user_id || (row.client_id || '').replace(/^line_/, '');
    if (!uid || uid === 'U_TEST_001' || existingLineIds.has(uid) || map.has(uid) || seen.has(uid)) continue;
    seen.add(uid);

    const name = row.display_name || `LINE用戶_${uid.slice(-6)}`;
    const newLead = {
      id:        `line_${Date.now()}_${uid.slice(-6)}`,
      name,
      lineId:    uid,
      lineBound: 'yes',
      phone:     '', email: '',
      status:    '待確認',
      tags:      ['LINE自動建檔'],
      notes:     '從 LINE 對話自動建立，請確認並補充客戶資料',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    leads.push(newLead);
    map.set(uid, { crmId: newLead.id, name });
    existingLineIds.add(uid);
    created++;
    console.log(`  🆕 自動建檔：${name} (${uid.slice(0,15)}...)`);
  }
  return created;
}

async function runSync() {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log(`\n[${now}] 🔄 開始同步...`);

  const leadsRaw = readJson(CRM_LEADS_FILE, []);
  const leads    = Array.isArray(leadsRaw) ? leadsRaw : (leadsRaw.leads || []);
  const contacts = readJson(CONTACTS_FILE, []);

  // 1. 名字比對自動配對
  const linked = autoLinkNewContacts(leads, contacts);
  if (linked > 0) writeJson(CRM_LEADS_FILE, leads);

  // 2. 建立映射
  const map = buildMap(leads, contacts);
  console.log(`  映射：${map.size} 筆`);

  // 3. 從 Render 拉摘要
  let summaries = [];
  try {
    const data = await fetchJson(RENDER_URL);
    summaries = data.summaries || [];
    console.log(`  Render 回傳 ${summaries.length} 筆摘要`);
  } catch(e) {
    console.error(`  ❌ Render 拉取失敗: ${e.message}`);
    return;
  }
  if (!summaries.length) { console.log('  ⚠️ 0 筆'); return; }

  // 4. 自動建立新客戶名片
  const created = autoCreateNewLeads(leads, summaries, map);
  if (created > 0) {
    writeJson(CRM_LEADS_FILE, leads);
    console.log(`  🆕 新建 ${created} 位客戶名片`);
  }

  // 5. 合併到 crm_activities.json
  const all = readJson(CRM_ACTS_FILE, {});
  let merged = 0, skipped = 0;

  for (const row of summaries) {
    let cid = row.client_id || '';
    let name = row.display_name || '';
    if (cid.startsWith('line_')) {
      const info = map.get(cid.replace(/^line_/, ''));
      if (info) { cid = info.crmId; name = info.name; }
    }
    if (row.user_id && (!cid || cid.startsWith('line_'))) {
      const info = map.get(row.user_id);
      if (info) { cid = info.crmId; name = info.name; }
    }
    if (!cid || cid.startsWith('line_')) { skipped++; continue; }

    const act = {
      id:      'sb_' + (row.id || Date.now() + Math.random()),
      type:    '💬 LINE',
      content: row.content || '',
      at:      row.created_at || new Date().toISOString(),
    };
    if (!Array.isArray(all[cid])) all[cid] = [];
    if (!all[cid].some(a => a.id === act.id)) { all[cid].push(act); merged++; }
  }

  for (const cid of Object.keys(all)) {
    all[cid].sort((a, b) => new Date(b.at) - new Date(a.at));
    if (all[cid].length > 200) all[cid] = all[cid].slice(0, 200);
  }

  writeJson(CRM_ACTS_FILE, all);
  const total = Object.values(all).reduce((s, a) => s + a.length, 0);
  console.log(`  ✅ +${merged} 新增, ${skipped} 待配對, 共 ${total} 筆 (${Object.keys(all).length} 客戶)`);
}

// 立即執行
runSync().catch(console.error);
keepAlive();

// 每 10 分鐘 keep-alive
setInterval(keepAlive, 10 * 60 * 1000);
// 每 30 分鐘同步
setInterval(() => runSync().catch(console.error), 30 * 60 * 1000);
console.log('⏰ 已啟動：keep-alive 每10分鐘 / 同步每30分鐘');
