require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Database = require('better-sqlite3');
const { ensureFile: ensureAbEventStore, getStatsByVariant, DEFAULT_EVENT_FILE } = require('../ab_event_store');
const supabase = require('../supabaseClient'); // Supabase 用於拉對話紀錄
const linePush = require('../linePushHelper'); // 共用 LINE push 工具（審核佇列 / 手動廣播）

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const ROOT = path.join(process.env.HOME, 'line-bot');
const LOG_DIR = path.join(ROOT, 'logs');
const CONTACTS_FILE = path.join(ROOT, 'contacts.json');
const RULES_FILE = path.join(ROOT, 'rules.json');
const AB_TEST_FILE = path.join(ROOT, 'ab_test.json');
const ADMIN_TOKEN_FILE = path.join(ROOT, 'dashboard', '.admin_token');
const GLOBAL_MANUAL_FILE = path.join(ROOT, 'status', 'global_manual.json');
const LAYOUT_BACKUP_DIR = path.join(ROOT, 'dashboard', 'backups');
const UI_VERSION_FILE = path.join(ROOT, 'dashboard', 'public', '.ui_version');
const PROD_LOCK_FILE = path.join(ROOT, 'dashboard', '.prod_lock');
const OPS_DB_FILE = path.join(ROOT, 'data', 'ops.db');
const MESSAGE_ITEMS_FILE = path.join(ROOT, 'message_items.json');
const CRM_DATA_FILE = path.join(ROOT, 'data', 'crm_leads.json');
const CRM_ACTIVITIES_FILE = path.join(ROOT, 'data', 'crm_activities.json');
const SURVEY_RESPONSES_FILE = path.join(ROOT, 'survey_responses.json');
const OA_MANUAL_LOG_FILE = path.join(LOG_DIR, 'oa_manual_broadcast.jsonl');
const RENDER_BASE_URL = process.env.RENDER_BASE_URL || 'https://line-smart-bot-sg.onrender.com';
const PUBLIC_MEDIA_BASE_URL = process.env.PUBLIC_MEDIA_BASE_URL || '';

// Admin export token（用來跟 Render 拉資料）讀取順序：
// 1) 環境變數 ADMIN_EXPORT_TOKEN
// 2) 本機檔案 <ROOT>/dashboard/.admin_export_token（不進版控）
// 都沒有就 warn + 設 null，相關端點會自行跳過。不再硬寫在源碼。
const ADMIN_EXPORT_TOKEN_FILE = path.join(ROOT, 'dashboard', '.admin_export_token');
function loadAdminExportToken() {
  if (process.env.ADMIN_EXPORT_TOKEN) return process.env.ADMIN_EXPORT_TOKEN.trim();
  try {
    if (fs.existsSync(ADMIN_EXPORT_TOKEN_FILE)) {
      const t = fs.readFileSync(ADMIN_EXPORT_TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
  } catch (_) {}
  return null;
}
const ADMIN_EXPORT_TOKEN = loadAdminExportToken();
if (!ADMIN_EXPORT_TOKEN) {
  console.warn(`[WARN] ADMIN_EXPORT_TOKEN 未設定（env 或 ${ADMIN_EXPORT_TOKEN_FILE} 都沒有），Render 同步相關端點將無法使用。`);
}

const DEFAULT_RULES = {
  pickCount: 5,
  dailyLimitPerUser: 1,
  minHoursBetweenCare: 24,
  requireEnabled: true,
  emergencyDailyLimitCap: 200
};

const DEFAULT_AB_TEST = {
  enabled: false,
  experimentName: 'care-message-variant',
  variantA: { name: 'A', weight: 50 },
  variantB: { name: 'B', weight: 50 },
  updatedAt: null
};

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function readJson(file, fallback = []) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function toDateTW(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
function todayTW() { return toDateTW(new Date()); }
function toTW(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
}

function ensureAdminToken() {
  const fromEnv = process.env.DASHBOARD_ADMIN_TOKEN;
  if (fromEnv) return fromEnv;
  if (fs.existsSync(ADMIN_TOKEN_FILE)) return fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
  const t = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  fs.mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_TOKEN_FILE, t, 'utf8');
  return t;
}
const ADMIN_TOKEN = ensureAdminToken();
ensureAbEventStore(DEFAULT_EVENT_FILE);

fs.mkdirSync(path.dirname(OPS_DB_FILE), { recursive: true });
const opsDb = new Database(OPS_DB_FILE);
opsDb.pragma('journal_mode = WAL');
if (!fs.existsSync(MESSAGE_ITEMS_FILE)) writeJson(MESSAGE_ITEMS_FILE, []);
opsDb.exec(`
CREATE TABLE IF NOT EXISTS customers (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  source TEXT DEFAULT 'LINE',
  tags TEXT DEFAULT '',
  value_score REAL DEFAULT 0,
  last_contact_at TEXT,
  last_care_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS journey_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  segment TEXT,
  template TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS import_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  row_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

function getGlobalManual() {
  try {
    if (!fs.existsSync(GLOBAL_MANUAL_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(GLOBAL_MANUAL_FILE, 'utf8'));
    return Boolean(data.enabled);
  } catch { return false; }
}
function setGlobalManual(enabled) {
  writeJson(GLOBAL_MANUAL_FILE, { enabled: Boolean(enabled), updated_at: new Date().toISOString() });
}
function getUiVersion(){
  try { return fs.readFileSync(UI_VERSION_FILE,'utf8').trim() || 'unknown'; } catch { return 'unknown'; }
}
function isProdLocked(){
  try { return !fs.existsSync(PROD_LOCK_FILE) || fs.readFileSync(PROD_LOCK_FILE,'utf8').trim() !== 'off'; } catch { return true; }
}
function getUiVersion(){
  try { return fs.readFileSync(UI_VERSION_FILE, 'utf8').trim() || 'unknown'; } catch { return 'unknown'; }
}
function isProdLocked(){
  try { return fs.existsSync(PROD_LOCK_FILE) && fs.readFileSync(PROD_LOCK_FILE,'utf8').trim() !== 'off'; } catch { return true; }
}

function syncCustomersFromContacts() {
  const contacts = readJson(CONTACTS_FILE, []);
  const up = opsDb.prepare(`INSERT INTO customers(user_id,name,source,tags,value_score,last_contact_at,last_care_at,updated_at)
    VALUES (@userId,@name,'LINE','',0,@last_contact_at,@last_care_at,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      name=excluded.name,
      last_contact_at=COALESCE(excluded.last_contact_at, customers.last_contact_at),
      last_care_at=COALESCE(excluded.last_care_at, customers.last_care_at),
      updated_at=datetime('now')`);
  const tx = opsDb.transaction((rows) => {
    for (const r of rows) if (r.userId) up.run({
      userId: r.userId,
      name: r.name || '',
      last_contact_at: r.last_contact_at || null,
      last_care_at: r.last_care_at || null
    });
  });
  tx(contacts);
}

function loadRules() {
  const curr = readJson(RULES_FILE, {});
  return { ...DEFAULT_RULES, ...curr };
}

function saveRules(incoming = {}) {
  const next = {
    ...DEFAULT_RULES,
    ...incoming,
    pickCount: Math.max(1, Number(incoming.pickCount ?? DEFAULT_RULES.pickCount)),
    dailyLimitPerUser: Math.max(1, Number(incoming.dailyLimitPerUser ?? DEFAULT_RULES.dailyLimitPerUser)),
    minHoursBetweenCare: Math.max(0, Number(incoming.minHoursBetweenCare ?? DEFAULT_RULES.minHoursBetweenCare)),
    emergencyDailyLimitCap: Math.max(1, Number(incoming.emergencyDailyLimitCap ?? DEFAULT_RULES.emergencyDailyLimitCap)),
    requireEnabled: Boolean(incoming.requireEnabled)
  };
  writeJson(RULES_FILE, next);
  return next;
}

function loadAbTest() {
  const curr = readJson(AB_TEST_FILE, {});
  return { ...DEFAULT_AB_TEST, ...curr };
}

function saveAbTest(incoming = {}) {
  const base = loadAbTest();
  const next = {
    ...base,
    ...incoming,
    enabled: Boolean(incoming.enabled),
    variantA: { ...base.variantA, ...(incoming.variantA || {}) },
    variantB: { ...base.variantB, ...(incoming.variantB || {}) },
    updatedAt: new Date().toISOString()
  };
  writeJson(AB_TEST_FILE, next);
  return next;
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

function parseSendRandom(dateTW) {
  const txt = readText(path.join(LOG_DIR, 'send_random5.log'));
  const rows = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^\[(.*?)\]\s+OK\s+(\S+)\s*(.*?)\s+msg=(.*)$/);
    if (!m) continue;
    const d = new Date(m[1]);
    if (Number.isNaN(d.getTime()) || (dateTW && toDateTW(d) !== dateTW)) continue;
    const rawName = (m[3] || '').trim();
    const cleanName = rawName.replace(/\s*variant=[A-Za-z0-9_-]+\s*$/,'').trim();
    rows.push({ iso: m[1], date: toDateTW(d), time: toTW(m[1]), userId: m[2], name: cleanName, messagePreview: (m[4] || '').trim() });
  }
  return rows;
}

function parsePipeline(dateTW) {
  const txt = readText(path.join(LOG_DIR, 'pipeline_run.log'));
  const tasks = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^\[(.*?)\]\s+STEP\[(.*?)\]\s+(success|attempt=.*start|failed.*)$/);
    if (!m) continue;
    const d = new Date(m[1].replace(' ', 'T'));
    if (Number.isNaN(d.getTime()) || (dateTW && toDateTW(d) !== dateTW)) continue;
    tasks.push({ time: toTW(d.toISOString()), step: m[2], status: m[3] });
  }
  return tasks;
}

function parseAlerts(dateTW) {
  const txt = readText(path.join(LOG_DIR, 'alerts.log'));
  const lines = txt.split('\n').filter(Boolean).filter(line => {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\s/);
    return m && (!dateTW || m[1] === dateTW);
  });

  // 若同一步驟有 RESOLVED 紀錄，隱藏較早的 failed 告警
  const resolved = new Set();
  for (const line of lines) {
    if (!line.includes('RESOLVED')) continue;
    const m = line.match(/STEP\[(.*?)\]/);
    if (m) resolved.add(m[1]);
  }

  return lines.filter(line => {
    const m = line.match(/STEP\[(.*?)\]/);
    if (!m) return !line.includes('RESOLVED');
    const step = m[1];
    if (line.includes('RESOLVED')) return false;
    if (resolved.has(step) && line.toLowerCase().includes('failed')) return false;
    return true;
  }).slice(-20).map(line => {
    const low = line.toLowerCase();
    let severity = '一般';
    if (low.includes('failed after') || low.includes('error')) severity = '重要';

    let reason = '流程執行失敗';
    let suggestion = '建議點「一鍵重試」，並檢查 .env 與網路連線。';
    let step = null;
    const m = line.match(/STEP\[(.*?)\]/);
    if (m) {
      step = m[1];
      reason = `步驟 ${step} 執行失敗`;
      suggestion = `重試步驟 ${step}；若重複失敗，檢查對應腳本與 token。`;
    }
    if (low.includes('token')) {
      reason = '憑證或 token 可能缺失';
      suggestion = '確認 .env 中 LINE_CHANNEL_ACCESS_TOKEN 與相關設定。';
    }

    return { line, severity, reason, suggestion, step };
  });
}

function parseOaManual(dateTW) {
  const txt = readText(OA_MANUAL_LOG_FILE);
  const rows = [];
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      const iso = j.sentAt || j.createdAt || new Date().toISOString();
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      if (dateTW && toDateTW(d) !== dateTW) continue;
      const cnt = Number(j.count || 0);
      rows.push({
        iso: d.toISOString(),
        date: toDateTW(d),
        time: toTW(d.toISOString()),
        userId: 'OA-BROADCAST',
        name: 'OA群發',
        messagePreview: `【OA群發】${j.title || '未命名'}｜發送 ${cnt} 人${j.note ? `｜${j.note}` : ''}`,
        count: cnt,
        source: 'oa_manual'
      });
    } catch {}
  }
  return rows;
}

function parseManualPush(dateTW) {
  const txt = readText(path.join(LOG_DIR, 'app.log'));
  const rows = [];
  for (const line of txt.split('\n')) {
    // common app.log shape: [iso] ... Uxxxxxxxx... or push ... to=Uxxxx
    const mTs = line.match(/^\[(.*?)\]/);
    const mUid = line.match(/U[0-9a-f]{32}/i);
    if (!mTs || !mUid) continue;
    const ts = mTs[1];
    const d = new Date(ts.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) continue;
    if (dateTW && toDateTW(d) !== dateTW) continue;
    rows.push({
      iso: d.toISOString(),
      date: toDateTW(d),
      time: toTW(d.toISOString()),
      userId: mUid[0],
      name: '',
      messagePreview: '（手動 push）'
    });
  }
  return rows;
}

function parseSendDoneSummary() {
  const txt = readText(path.join(LOG_DIR, 'send_random5.log'));
  const rows = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^\[(.*?)\]\s+DONE\s+today=(\d{4}-\d{2}-\d{2})\s+ok=(\d+)\s+fail=(\d+)/);
    if (!m) continue;
    const d = new Date(m[1]);
    if (Number.isNaN(d.getTime())) continue;
    rows.push({ date: m[2], ok: Number(m[3] || 0), fail: Number(m[4] || 0) });
  }
  return rows;
}

function trends(days = 7) {
  const sent = parseSendRandom(null);
  const done = parseSendDoneSummary();
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = toDateTW(d);
    const doneForDay = done.filter(x => x.date === key);
    const fail = doneForDay.reduce((sum, x) => sum + Number(x.fail || 0), 0);
    const attempts = doneForDay.reduce((sum, x) => sum + Number(x.ok || 0) + Number(x.fail || 0), 0);
    out.push({ date: key, sent: sent.filter(x => x.date === key).length, fail, attempts });
  }
  return out;
}

function hashVariant(userId = '') {
  let sum = 0;
  for (const ch of userId) sum += ch.charCodeAt(0);
  return sum % 2 === 0 ? 'A' : 'B';
}

function getUserTimeline(userId) {
  const contacts = readJson(CONTACTS_FILE, []);
  const user = contacts.find(c => c.userId === userId) || null;
  const events = [];
  if (user?.last_contact_at) events.push({ type: 'last_contact', at: user.last_contact_at, title: '最後互動', detail: user.last_contact_at });
  if (user?.last_care_at) events.push({ type: 'last_care', at: user.last_care_at, title: '最後主動定聯', detail: user.last_care_at });
  if (user?.manual_updated_at) events.push({ type: 'manual_mode', at: user.manual_updated_at, title: `手動模式${user.manual_mode ? '開啟' : '關閉'}`, detail: user.manual_updated_at });

  for (const row of parseSendRandom(null)) {
    if (row.userId !== userId) continue;
    events.push({ type: 'care_sent', at: row.iso, title: '已發送關心訊息', detail: row.messagePreview });
  }

  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { user, events: events.slice(0, 50) };
}

function parseCronField(field, min, max) {
  const vals = new Set();
  const chunks = String(field).split(',');
  for (const chunk of chunks) {
    if (chunk === '*') {
      for (let i = min; i <= max; i++) vals.add(i);
      continue;
    }
    const stepMatch = chunk.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Math.max(1, Number(stepMatch[1]));
      for (let i = min; i <= max; i += step) vals.add(i);
      continue;
    }
    const rangeMatch = chunk.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      let a = Number(rangeMatch[1]);
      let b = Number(rangeMatch[2]);
      if (a > b) [a, b] = [b, a];
      for (let i = Math.max(min, a); i <= Math.min(max, b); i++) vals.add(i);
      continue;
    }
    const n = Number(chunk);
    if (!Number.isNaN(n) && n >= min && n <= max) vals.add(n);
  }
  return vals;
}

function nextRunsFromCron(expr, count = 3) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return [];
  const [mi, hr, dom, mon, dow] = parts;
  const mins = parseCronField(mi, 0, 59);
  const hrs = parseCronField(hr, 0, 23);
  const doms = parseCronField(dom, 1, 31);
  const mons = parseCronField(mon, 1, 12);
  const dows = parseCronField(dow, 0, 7);

  const out = [];
  const now = new Date();
  let probe = new Date(now.getTime() + 60000);
  probe.setSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 60 && out.length < count; i++) {
    const minute = probe.getMinutes();
    const hour = probe.getHours();
    const day = probe.getDate();
    const month = probe.getMonth() + 1;
    const dayOfWeek = probe.getDay();
    const dayOfWeekAlt = dayOfWeek === 0 ? 7 : dayOfWeek;

    const match = mins.has(minute) && hrs.has(hour) && doms.has(day) && mons.has(month) && (dows.has(dayOfWeek) || dows.has(dayOfWeekAlt));
    if (match) out.push(new Date(probe));
    probe = new Date(probe.getTime() + 60000);
  }
  return out.map(d => ({ iso: d.toISOString(), tw: toTW(d.toISOString()) }));
}

function getSchedule() {
  return new Promise((resolve) => {
    exec('crontab -l', (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: (stderr || err.message || 'crontab unavailable').trim(), rows: [] });
      const rows = String(stdout || '').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'));
      const parsed = rows.map(line => {
        const parts = line.split(/\s+/);
        const expr = parts.slice(0, 5).join(' ');
        return { line, expr, nextRuns: nextRunsFromCron(expr, 3) };
      });
      resolve({ ok: true, rows: parsed });
    });
  });
}

app.get('/api/admin-status', (req, res) => {
  const token = req.headers['x-admin-token'];
  res.json({ ok: token === ADMIN_TOKEN, uiVersion: getUiVersion(), prodLock: isProdLocked() });
});

app.post('/api/survey-track', (req, res) => {
  try {
    const userId = String(req.body?.userId || req.body?.uid || '').trim();
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const payload = {
      userId,
      answers: req.body?.answers || req.body?.data || null,
      score: Number(req.body?.score ?? NaN),
      note: String(req.body?.note || '').trim(),
      submittedAt: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
    };

    const responses = readJson(SURVEY_RESPONSES_FILE, []);
    responses.push(payload);
    writeJson(SURVEY_RESPONSES_FILE, responses);

    const contacts = readJson(CONTACTS_FILE, []);
    const idx = contacts.findIndex(c => c.userId === userId);
    if (idx >= 0) {
      contacts[idx].last_contact_at = payload.submittedAt;
      contacts[idx].survey_last_at = payload.submittedAt;
      if (payload.note) contacts[idx].survey_last_note = payload.note.slice(0, 200);
    } else {
      contacts.push({
        userId,
        name: '新客戶',
        enabled: true,
        last_contact_at: payload.submittedAt,
        survey_last_at: payload.submittedAt,
        survey_last_note: payload.note.slice(0, 200)
      });
    }
    writeJson(CONTACTS_FILE, contacts);

    res.json({ ok: true, userId, submittedAt: payload.submittedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/survey-stats', requireAdmin, (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
    const rows = readJson(SURVEY_RESPONSES_FILE, []);
    const now = new Date();
    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = toDateTW(d);
      trend.push({ date: key, count: rows.filter(x => toDateTW(x.submittedAt) === key).length });
    }
    const today = toDateTW(now);
    const todayCount = trend.find(x => x.date === today)?.count || 0;
    res.json({ ok: true, todayCount, trend, total: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/prod-lock', requireAdmin, (req, res) => {
  res.json({ ok:true, locked:isProdLocked(), uiVersion:getUiVersion() });
});

app.post('/api/prod-lock', requireAdmin, (req, res) => {
  const locked = Boolean(req.body?.locked);
  fs.writeFileSync(PROD_LOCK_FILE, locked ? 'on' : 'off', 'utf8');
  res.json({ ok:true, locked:isProdLocked() });
});

app.post('/api/upload-care-media', requireAdmin, async (req, res) => {
  try {
    const { filename, contentType, base64 } = req.body || {};
    if (!filename || !base64) return res.status(400).json({ ok:false, error:'filename/base64 required' });
    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = path.extname(safe) || '';
    const name = `${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const data = Buffer.from(String(base64), 'base64');
    fs.writeFileSync(path.join(uploadDir, name), data);
    const type = String(contentType || '').toLowerCase();
    const mediaType = type.startsWith('image/') ? 'image' : (type.startsWith('video/') ? 'video' : 'file');
    if (mediaType === 'file') {
      return res.status(400).json({ ok:false, error:'目前僅支援圖片/影片；LINE Bot 不支援一般檔案附件訊息' });
    }

    // 如果是圖片，嘗試上傳到 imgbb 取得公開 https URL（LINE 必須要公開網址才能存取）
    let publicUrl = '';
    const imgbbKey = process.env.IMGBB_API_KEY || '';
    if (imgbbKey && mediaType === 'image') {
      try {
        const form = new URLSearchParams();
        form.append('image', String(base64));
        const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
        const imgbbData = await imgbbRes.json();
        if (imgbbData?.data?.url) {
          publicUrl = imgbbData.data.url;
          console.log(`[upload-care-media] imgbb 上傳成功：${publicUrl}`);
        } else {
          console.warn('[upload-care-media] imgbb 回傳異常：', JSON.stringify(imgbbData));
        }
      } catch (e) {
        console.error('[upload-care-media] imgbb 上傳失敗：', e.message);
      }
    }

    res.json({ ok:true, path:`/uploads/${name}`, mediaType, publicUrl });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

app.post('/api/oa-manual-log', requireAdmin, (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const count = Number(req.body?.count || 0);
    const note = String(req.body?.note || '').trim();
    const sentAt = String(req.body?.sentAt || new Date().toISOString()).trim();
    if (!title) return res.status(400).json({ ok:false, error:'title required' });
    if (!Number.isFinite(count) || count <= 0) return res.status(400).json({ ok:false, error:'count must be > 0' });
    fs.mkdirSync(path.dirname(OA_MANUAL_LOG_FILE), { recursive: true });
    fs.appendFileSync(OA_MANUAL_LOG_FILE, JSON.stringify({ title, count, note, sentAt, createdAt: new Date().toISOString() }) + '\n', 'utf8');
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

app.get('/api/oa-manual-log', requireAdmin, (req, res) => {
  const date = String(req.query.date || todayTW()).trim();
  res.json({ ok:true, rows: parseOaManual(date) });
});

app.get('/api/layout-presets', requireAdmin, (req, res) => {
  fs.mkdirSync(LAYOUT_BACKUP_DIR, { recursive: true });
  const files = fs.readdirSync(LAYOUT_BACKUP_DIR).filter(f => f.endsWith('.html')).sort().reverse();
  res.json({ ok:true, files });
});

app.post('/api/layout-presets/save', requireAdmin, (req, res) => {
  if (isProdLocked()) return res.status(423).json({ ok:false, error:'正式版已鎖定，先解鎖再保存版面' });
  const name = String(req.body?.name || '').trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g,'_');
  if (!name) return res.status(400).json({ ok:false, error:'name required' });
  fs.mkdirSync(LAYOUT_BACKUP_DIR, { recursive: true });
  const src = path.join(ROOT, 'dashboard', 'public', 'index.html');
  const out = path.join(LAYOUT_BACKUP_DIR, `${name}.html`);
  fs.copyFileSync(src, out);
  res.json({ ok:true, file: path.basename(out) });
});

app.post('/api/layout-presets/apply', requireAdmin, (req, res) => {
  if (isProdLocked()) return res.status(423).json({ ok:false, error:'正式版已鎖定，先解鎖再套用版面' });
  const file = String(req.body?.file || '');
  const src = path.join(LAYOUT_BACKUP_DIR, file);
  const dst = path.join(ROOT, 'dashboard', 'public', 'index.html');
  if (!fs.existsSync(src)) return res.status(404).json({ ok:false, error:'preset not found' });
  fs.copyFileSync(src, dst);
  res.json({ ok:true, applied:file });
});

app.get('/api/global-manual-mode', requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${RENDER_BASE_URL}/admin/global-manual?token=${ADMIN_EXPORT_TOKEN}`);
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok:false, error:j.error || 'remote error' });
    return res.json({ enabled: Boolean(j.enabled) });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.post('/api/global-manual-mode', requireAdmin, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const r = await fetch(`${RENDER_BASE_URL}/admin/global-manual?token=${ADMIN_EXPORT_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok:false, error:j.error || 'remote error' });
    return res.json({ ok: true, enabled: Boolean(j.enabled) });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get('/api/rules', requireAdmin, (req, res) => {
  res.json(loadRules());
});

app.post('/api/rules', requireAdmin, (req, res) => {
  res.json({ ok: true, rules: saveRules(req.body || {}) });
});

app.get('/api/ab-test', requireAdmin, (req, res) => {
  res.json(loadAbTest());
});

app.post('/api/ab-test', requireAdmin, (req, res) => {
  res.json({ ok: true, config: saveAbTest(req.body || {}) });
});

app.get('/api/ab-test/stats', requireAdmin, (req, res) => {
  try {
    const date = String(req.query.date || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const campaignId = String(req.query.campaignId || '').trim();

    let fromIso = from || '';
    let toIso = to || '';

    if (date && !fromIso && !toIso) {
      fromIso = `${date}T00:00:00+08:00`;
      toIso = `${date}T23:59:59.999+08:00`;
    }

    const stats = getStatsByVariant({ from: fromIso || undefined, to: toIso || undefined, campaignId: campaignId || undefined });

    res.json({
      ok: true,
      stats: {
        A: { sent: stats.A.sent, replied: stats.A.replied, reply_rate: stats.A.reply_rate },
        B: { sent: stats.B.sent, replied: stats.B.replied, reply_rate: stats.B.reply_rate }
      },
      filters: {
        date: date || null,
        from: fromIso || null,
        to: toIso || null,
        campaignId: campaignId || null
      }
    });
  } catch (error) {
    console.error('ab-test stats failed:', error);
    res.status(500).json({ ok: false, error: 'failed_to_compute_ab_stats' });
  }
});

app.get('/api/schedule', requireAdmin, async (req, res) => {
  res.json(await getSchedule());
});

app.get('/api/user-timeline', requireAdmin, (req, res) => {
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
  const timeline = getUserTimeline(userId);
  res.json({ ok: true, ...timeline });
});

app.get('/api/overview', requireAdmin, (req, res) => {
  const date = req.query.date || todayTW();
  const contacts = readJson(CONTACTS_FILE, []);
  const care = parseSendRandom(date);
  const oaManual = parseOaManual(date);
  const tasks = parsePipeline(date);
  const alerts = parseAlerts(date);

  const successCount = tasks.filter(t => t.status === 'success').length;
  const failCount = tasks.filter(t => String(t.status).startsWith('failed')).length;
  const sentIds = new Set(care.map(x => x.userId));

  let replied = 0;
  for (const c of contacts) {
    if (!sentIds.has(c.userId)) continue;
    const lc = c.last_contact_at ? new Date(c.last_contact_at).getTime() : 0;
    const lcare = c.last_care_at ? new Date(c.last_care_at).getTime() : 0;
    if (lc && lcare && lc > lcare) replied++;
  }

  const replyRate = sentIds.size ? Math.round((replied / sentIds.size) * 100) : 0;
  const successRate = (successCount + failCount) ? Math.round(successCount * 100 / (successCount + failCount)) : 100;

  const oaSent = oaManual.reduce((s, x) => s + Number(x.count || 0), 0);
  res.json({ date, totalContacts: contacts.length, enabledContacts: contacts.filter(c => c.enabled).length,
    tasksExecuted: successCount, taskFailures: failCount, taskSuccessRate: successRate,
    careSent: care.length + oaSent, replyRate, alertsCount: alerts.length, oaManualSent: oaSent });
});

app.get('/api/today-care', requireAdmin, async (req, res) => {
  const date = req.query.date || todayTW();
  const rows = [...parseSendRandom(date), ...parseManualPush(date), ...parseOaManual(date)];

  // dedupe by userId+time+preview
  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    const key = `${r.userId}|${r.time}|${r.messagePreview}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }

  // enrich name from contacts.json first
  const contacts = readJson(CONTACTS_FILE, []);
  const nameMap = new Map(contacts.filter(c => c.userId).map(c => [c.userId, c.name || '']));
  for (const r of uniq) {
    if (!r.name || r.name === '新客戶') {
      const nm = nameMap.get(r.userId);
      if (nm) r.name = nm;
    }
  }

  // fallback: fetch LINE profile displayName for unknown names
  try {
    let token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    if (!token) {
      const envPath = path.join(ROOT, '.env');
      if (fs.existsSync(envPath)) {
        const txt = fs.readFileSync(envPath, 'utf8');
        const m = txt.match(/^LINE_CHANNEL_ACCESS_TOKEN=(.*)$/m);
        if (m) token = m[1].trim().replace(/^"|"$/g, '');
      }
    }

    if (token) {
      for (const r of uniq) {
        if (!r.userId || (r.name && r.name !== '新客戶')) continue;
        const pr = await fetch(`https://api.line.me/v2/bot/profile/${r.userId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!pr.ok) continue;
        const pd = await pr.json();
        if (pd?.displayName) r.name = pd.displayName;
      }
    }
  } catch {}

  uniq.sort((a,b) => String(b.iso||'').localeCompare(String(a.iso||'')));
  res.json(uniq);
});
app.get('/api/today-tasks', requireAdmin, (req, res) => res.json(parsePipeline(req.query.date || todayTW())));
app.get('/api/alerts', requireAdmin, (req, res) => res.json(parseAlerts(req.query.date || todayTW())));
app.get('/api/trends', requireAdmin, (req, res) => res.json(trends(Number(req.query.days || 7))));

// --- Ops v2: dry-run + customer360 + multi-source imports ---
app.post('/api/dry-run', requireAdmin, (req, res) => {
  syncCustomersFromContacts();
  const segment = String(req.body?.segment || 'all');
  const limit = Math.min(Number(req.body?.limit || 30), 200);
  let where = '1=1';
  if (segment === 'new') where = "datetime(updated_at) >= datetime('now','-7 day')";
  if (segment === 'silent') where = "(last_contact_at IS NULL OR datetime(last_contact_at) < datetime('now','-30 day'))";
  if (segment === 'high') where = 'value_score >= 70';
  const rows = opsDb.prepare(`SELECT user_id as userId,name,last_contact_at,tags,value_score FROM customers WHERE ${where} ORDER BY datetime(COALESCE(last_contact_at,updated_at)) DESC LIMIT ?`).all(limit);
  res.json({ ok:true, segment, count: rows.length, rows });
});

app.get('/api/customer360', requireAdmin, (req, res) => {
  syncCustomersFromContacts();
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ ok:false, error:'userId required' });
  const customer = opsDb.prepare(`SELECT user_id as userId,name,source,tags,value_score,last_contact_at,last_care_at,updated_at FROM customers WHERE user_id=?`).get(userId);
  if (!customer) return res.status(404).json({ ok:false, error:'not found' });
  const journeys = opsDb.prepare(`SELECT id,name,segment,template,enabled FROM journey_rules WHERE enabled=1 ORDER BY id DESC`).all();
  res.json({ ok:true, customer, journeys });
});

app.post('/api/import/contacts', requireAdmin, (req, res) => {
  const source = String(req.body?.source || 'manual');
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const up = opsDb.prepare(`INSERT INTO customers(user_id,name,source,tags,value_score,last_contact_at,last_care_at,updated_at)
    VALUES (@userId,@name,@source,@tags,@value_score,@last_contact_at,@last_care_at,datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      name=COALESCE(excluded.name,customers.name),
      source=excluded.source,
      tags=CASE WHEN excluded.tags!='' THEN excluded.tags ELSE customers.tags END,
      value_score=MAX(customers.value_score, excluded.value_score),
      last_contact_at=COALESCE(excluded.last_contact_at, customers.last_contact_at),
      updated_at=datetime('now')`);
  const tx = opsDb.transaction((arr)=>{ for(const r of arr){ if(!r?.userId) continue; up.run({
    userId:r.userId,name:r.name||'',source,tags:r.tags||'',value_score:Number(r.value_score||0),last_contact_at:r.last_contact_at||null,last_care_at:r.last_care_at||null
  }); }});
  tx(rows);
  opsDb.prepare(`INSERT INTO import_logs(source,row_count) VALUES(?,?)`).run(source, rows.length);
  res.json({ ok:true, source, imported: rows.length });
});

app.get('/api/segments', requireAdmin, (req, res) => {
  syncCustomersFromContacts();
  const all = opsDb.prepare(`SELECT COUNT(*) c FROM customers`).get().c;
  const silent = opsDb.prepare(`SELECT COUNT(*) c FROM customers WHERE (last_contact_at IS NULL OR datetime(last_contact_at) < datetime('now','-30 day'))`).get().c;
  const high = opsDb.prepare(`SELECT COUNT(*) c FROM customers WHERE value_score >= 70`).get().c;
  const newer = opsDb.prepare(`SELECT COUNT(*) c FROM customers WHERE datetime(updated_at) >= datetime('now','-7 day')`).get().c;
  res.json({ ok:true, all, silent, high, new: newer });
});

app.get('/api/message-items', requireAdmin, (req, res) => {
  const items = readJson(MESSAGE_ITEMS_FILE, []);
  res.json({ ok:true, items });
});

app.post('/api/message-items', requireAdmin, (req, res) => {
  const body = req.body || {};
  const items = readJson(MESSAGE_ITEMS_FILE, []);
  const item = {
    id: body.id || `msg_${Date.now()}`,
    name: String(body.name || '未命名項目').trim(),
    category: String(body.category || '未分類').trim(),
    type: String(body.type || 'text').trim(),
    text: String(body.text || '').trim(),
    mediaUrl: String(body.mediaUrl || '').trim(),
    flexJson: String(body.flexJson || '').trim(),
    updatedAt: new Date().toISOString()
  };
  const idx = items.findIndex(x => x.id === item.id);
  if (idx >= 0) items[idx] = { ...items[idx], ...item }; else items.unshift(item);
  writeJson(MESSAGE_ITEMS_FILE, items);
  res.json({ ok:true, item, total: items.length });
});

app.post('/api/message-items/delete', requireAdmin, (req, res) => {
  const id = String(req.body?.id || '');
  const items = readJson(MESSAGE_ITEMS_FILE, []);
  const next = items.filter(x => x.id !== id);
  writeJson(MESSAGE_ITEMS_FILE, next);
  res.json({ ok:true, total: next.length });
});

// ── CRM 資料同步 API（讓手機與桌面共用同一份資料）──────────────
app.get('/api/crm/data', requireAdmin, (req, res) => {
  const leads = readJson(CRM_DATA_FILE, null);
  res.json({ ok: true, leads, updatedAt: leads ? fs.statSync(CRM_DATA_FILE).mtime.toISOString() : null });
});

app.post('/api/crm/data', requireAdmin, (req, res) => {
  const leads = req.body?.leads;
  if (!Array.isArray(leads)) return res.status(400).json({ ok: false, error: 'leads must be array' });
  fs.mkdirSync(path.dirname(CRM_DATA_FILE), { recursive: true });
  writeJson(CRM_DATA_FILE, leads);
  res.json({ ok: true, count: leads.length });
});

// ── CRM 互動記錄 API ────────────────────────────────────────────────────────
// GET /api/crm/activities          → 取得全部互動記錄（供 crm.html 開啟時同步）
// POST /api/crm/activities         → 新增單筆互動記錄（LINE Bot 呼叫此 endpoint）
// POST /api/crm/activities/batch   → 批次覆寫某客戶的全部記錄（crm.html 本地儲存同步用）

app.get('/api/crm/activities', requireAdmin, async (req, res) => {
  const all = readJson(CRM_ACTIVITIES_FILE, {});

  // 建立 lineId/userId → CRM client_id 映射 (支援 list 格式的 crm_leads.json)
  function buildMap() {
    const raw = readJson(CRM_DATA_FILE, []);
    const leads = Array.isArray(raw) ? raw : (raw.leads || []);
    const map = new Map();
    for (const l of leads) {
      if (l.lineId) map.set(l.lineId.trim(), l.id);
    }
    for (const c of readJson(CONTACTS_FILE, [])) {
      if (c.userId && !map.has(c.userId)) {
        const dn = (c.name||'').trim().toLowerCase();
        const m = leads.find(l => { const n=(l.name||'').trim().toLowerCase(); return n&&dn&&(n.includes(dn)||dn.includes(n)); });
        if (m) map.set(c.userId, m.id);
      }
    }
    console.log('[activities] buildMap 完成，共', map.size, '筆對應');
    return map;
  }

  // 合併資料列到 all
  function mergeRows(rows, map) {
    let merged = 0;
    for (const row of rows) {
      let cid = row.client_id || '';
      if (cid.startsWith('line_')) { cid = map.get(cid.replace(/^line_/, '')) || cid; }
      if (row.user_id && (!cid || cid.startsWith('line_'))) { cid = map.get(row.user_id) || cid; }
      if (!cid || cid.startsWith('line_')) { continue; }
      const act = { id: 'sb_'+(row.id||Date.now()+Math.random()), type:'💬 LINE', content:row.content||'', at:row.created_at||row.at||new Date().toISOString() };
      if (!Array.isArray(all[cid])) all[cid] = [];
      if (!all[cid].some(a => a.id === act.id)) { all[cid].push(act); merged++; }
    }
    console.log('[activities] mergeRows 完成：合併', merged, '/', rows.length, '筆，map 大小', map.size);
  }

  // 1. 從 Render 拉摘要（主要來源）
  try {
    const renderRes = await fetch(
      `${RENDER_BASE_URL}/admin/line-summaries?token=${ADMIN_EXPORT_TOKEN}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (renderRes.ok) {
      const rd = await renderRes.json();
      if (Array.isArray(rd.summaries) && rd.summaries.length > 0) {
        console.log('[activities] Render 回傳', rd.summaries.length, '筆');
        mergeRows(rd.summaries, buildMap());
      } else {
        console.log('[activities] Render 回傳 0 筆或格式不符:', JSON.stringify(rd).slice(0,100));
      }
    } else {
      console.log('[activities] Render 回應 HTTP', renderRes.status);
    }
  } catch (e) { console.log('[activities] Render 拉取失敗:', e.message); }

  // 2. 本機 Supabase 備援
  if (supabase) {
    try {
      const { data: rows, error } = await supabase.from('interaction_logs')
        .select('id,client_id,user_id,type,content,created_at').eq('type','💬 LINE')
        .order('created_at',{ascending:false}).limit(500);
      if (!error && Array.isArray(rows) && rows.length > 0) mergeRows(rows, buildMap());
    } catch(e) { console.error('[activities] Supabase 失敗:', e.message); }
  }

  // 排序
  for (const cid of Object.keys(all)) {
    all[cid].sort((a,b) => new Date(b.at)-new Date(a.at));
    if (all[cid].length > 200) all[cid] = all[cid].slice(0,200);
  }

  const total = Object.values(all).reduce((s,a)=>s+a.length,0);
  console.log('[activities] 最終回傳：', Object.keys(all).length, '位客戶，', total, '筆活動');
  res.json({ ok: true, activities: all });
});

app.post('/api/crm/activities', requireAdmin, (req, res) => {
  const { clientId, activity } = req.body || {};
  if (!clientId || !activity || !activity.type || !activity.at) {
    return res.status(400).json({ ok: false, error: 'clientId, activity.type, activity.at 為必填' });
  }
  fs.mkdirSync(path.dirname(CRM_ACTIVITIES_FILE), { recursive: true });
  const all = readJson(CRM_ACTIVITIES_FILE, {});
  if (!Array.isArray(all[clientId])) all[clientId] = [];
  // 避免重複寫入（以 id 去重）
  const act = {
    id: activity.id || ('a_' + Date.now()),
    type: activity.type,
    content: activity.content || '',
    at: activity.at,
  };
  const alreadyExists = all[clientId].some(a => a.id === act.id);
  if (!alreadyExists) {
    all[clientId].unshift(act); // 最新在最前
    // 每位客戶最多保留 200 筆
    if (all[clientId].length > 200) all[clientId] = all[clientId].slice(0, 200);
    writeJson(CRM_ACTIVITIES_FILE, all);
  }
  res.json({ ok: true, clientId, activityId: act.id, duplicate: alreadyExists });
});

// POST /api/crm/sync-now — 手動觸發從 Render 拉摘要並寫入 crm_activities.json
app.post('/api/crm/sync-now', requireAdmin, async (req, res) => {
  const https = require('https');
  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { timeout: 15000 }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });
  }
  try {
    const url = `${RENDER_BASE_URL}/admin/line-summaries?token=${ADMIN_EXPORT_TOKEN}`;
    const data = await fetchJson(url);
    const summaries = data.summaries || [];

    const crmRaw = readJson(CRM_DATA_FILE, []);
    const leads  = Array.isArray(crmRaw) ? crmRaw : (crmRaw.leads || []);
    const map = new Map();
    for (const l of leads) { if (l.lineId) map.set(l.lineId.trim(), l.id); }
    for (const c of readJson(CONTACTS_FILE, [])) {
      if (c.userId && !map.has(c.userId)) {
        const dn = (c.name||'').trim().toLowerCase();
        const m = leads.find(l => { const n=(l.name||'').trim().toLowerCase(); return n&&dn&&(n.includes(dn)||dn.includes(n)); });
        if (m) map.set(c.userId, m.id);
      }
    }

    const all = readJson(CRM_ACTIVITIES_FILE, {});
    let merged = 0;
    for (const row of summaries) {
      let cid = row.client_id || '';
      if (cid.startsWith('line_')) { cid = map.get(cid.replace(/^line_/, '')) || cid; }
      if (row.user_id && (!cid || cid.startsWith('line_'))) { cid = map.get(row.user_id) || cid; }
      if (!cid || cid.startsWith('line_')) continue;
      const act = { id:'sb_'+(row.id||Date.now()+Math.random()), type:'💬 LINE', content:row.content||'', at:row.created_at||new Date().toISOString() };
      if (!Array.isArray(all[cid])) all[cid] = [];
      if (!all[cid].some(a => a.id === act.id)) { all[cid].push(act); merged++; }
    }
    for (const cid of Object.keys(all)) {
      all[cid].sort((a,b) => new Date(b.at)-new Date(a.at));
      if (all[cid].length > 200) all[cid] = all[cid].slice(0,200);
    }
    fs.mkdirSync(path.dirname(CRM_ACTIVITIES_FILE), { recursive: true });
    writeJson(CRM_ACTIVITIES_FILE, all);
    const total = Object.values(all).reduce((s,a)=>s+a.length,0);
    console.log(`[sync-now] 同步完成：${merged} 筆新增，共 ${total} 筆`);
    res.json({ ok:true, merged, total, customers: Object.keys(all).length });
  } catch(e) {
    console.error('[sync-now] 失敗:', e.message);
    res.json({ ok:false, error: e.message });
  }
});

app.post('/api/crm/activities/batch', requireAdmin, (req, res) => {
  // crm.html 定期把 localStorage 的活動同步過來（整客戶覆寫）
  const { clientId, activities } = req.body || {};
  if (!clientId || !Array.isArray(activities)) {
    return res.status(400).json({ ok: false, error: 'clientId (string) 與 activities (array) 為必填' });
  }
  fs.mkdirSync(path.dirname(CRM_ACTIVITIES_FILE), { recursive: true });
  const all = readJson(CRM_ACTIVITIES_FILE, {});
  all[clientId] = activities.slice(0, 200);
  writeJson(CRM_ACTIVITIES_FILE, all);
  res.json({ ok: true, clientId, count: all[clientId].length });
});

app.post('/api/crm/open-folder', requireAdmin, (req, res) => {
  const id = String(req.body?.id || '').trim();
  const name = String(req.body?.name || '未命名客戶').trim();
  const safe = `${name}_${id}`.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
  const dir = path.join(ROOT, 'crm-files', safe);
  fs.mkdirSync(dir, { recursive: true });
  exec(`open '${dir}'`, () => {});
  res.json({ ok:true, dir });
});
app.get('/api/top-responders', requireAdmin, async (req, res) => {
  const date = req.query.date || todayTW();
  const local = readJson(CONTACTS_FILE, []);
  const localNameMap = new Map(local.filter(c => c.userId).map(c => [c.userId, c.name || '']));

  let source = local;
  try {
    const tokenCandidates = [ADMIN_EXPORT_TOKEN].filter(Boolean);
    for (const tk of tokenCandidates) {
      if (!tk) continue;
      const r = await fetch(`${RENDER_BASE_URL}/admin/contacts/export?token=${tk}`, {
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const remote = await r.json();
      if (Array.isArray(remote) && remote.length) {
        source = remote.map(rc => ({
          ...rc,
          name: (rc.name && rc.name !== '新客戶') ? rc.name : (localNameMap.get(rc.userId) || rc.name || '')
        }));
        break;
      }
    }
  } catch {}

  const rows = source.map(c => {
    const lc = c.last_contact_at ? new Date(c.last_contact_at) : null;
    const activeOnDate = lc ? (toDateTW(lc) === date) : false;
    return {
      userId: c.userId,
      name: c.name || '',
      last_contact_at: c.last_contact_at || null,
      last_care_at: c.last_care_at || null,
      activeOnDate
    };
  }).filter(x => x.userId)
    .sort((a, b) => Number(b.activeOnDate) - Number(a.activeOnDate) || String(b.last_contact_at || '').localeCompare(String(a.last_contact_at || '')))
    .slice(0, 20);

  // 新客戶名稱即時補全（從 LINE profile 取 displayName）
  try {
    let token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    if (!token) {
      const envPath = path.join(ROOT, '.env');
      if (fs.existsSync(envPath)) {
        const txt = fs.readFileSync(envPath, 'utf8');
        const m = txt.match(/^LINE_CHANNEL_ACCESS_TOKEN=(.*)$/m);
        if (m) token = m[1].trim().replace(/^"|"$/g, '');
      }
    }
    if (token) {
      for (const r of rows) {
        if (r.name && r.name !== '新客戶') continue;
        const p = await fetch(`https://api.line.me/v2/bot/profile/${r.userId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!p.ok) continue;
        const d = await p.json();
        if (d?.displayName) r.name = d.displayName;
      }
    }
  } catch {}

  res.json(rows);
});

app.get('/api/contacts', requireAdmin, (req, res) => res.json(readJson(CONTACTS_FILE, [])));

app.get('/api/contacts-live', requireAdmin, async (req, res) => {
  const local = readJson(CONTACTS_FILE, []);
  // 以本機為基礎，建立 userId → contact 的 Map
  const merged = new Map(local.filter(x=>x.userId).map(x=>[x.userId, {
    userId: x.userId,
    name: x.name || '新客戶',
    last_contact_at: x.last_contact_at || null,
    last_care_at: x.last_care_at || null,
    enabled: x.enabled !== false
  }]));

  // 嘗試從 Render 補充額外聯絡人（不覆蓋本機資料）
  try {
    const tokenCandidates = [ADMIN_EXPORT_TOKEN].filter(Boolean);
    for (const tk of tokenCandidates) {
      if (!tk) continue;
      const r = await fetch(`${RENDER_BASE_URL}/admin/contacts/export?token=${tk}`, {
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const remote = await r.json();
      if (!Array.isArray(remote)) continue;
      let added = 0;
      for (const x of remote) {
        if (!x.userId || merged.has(x.userId)) continue; // 本機已有的不覆蓋
        merged.set(x.userId, {
          userId: x.userId,
          name: (x.name && x.name !== '新客戶') ? x.name : '新客戶',
          last_contact_at: x.last_contact_at || null,
          last_care_at: x.last_care_at || null,
          enabled: x.enabled !== false
        });
        added++;
      }
      console.log(`[contacts-live] 本機 ${local.length} 筆 + Render 補 ${added} 筆 = 共 ${merged.size} 筆`);
      break;
    }
  } catch (e) {
    console.log('[contacts-live] Render 不可用，使用本機資料:', e.message);
  }

  const contacts = Array.from(merged.values());

  // 補全「新客戶」名稱（從 LINE API 查詢）
  try {
    let lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
    if (!lineToken) {
      const envPath = path.join(ROOT, '.env');
      if (fs.existsSync(envPath)) {
        const txt = fs.readFileSync(envPath, 'utf8');
        const m = txt.match(/^LINE_CHANNEL_ACCESS_TOKEN=(.*)$/m);
        if (m) lineToken = m[1].trim().replace(/^"|"$/g, '');
      }
    }
    if (lineToken) {
      for (const c of contacts) {
        if (!c.userId || (c.name && c.name !== '新客戶')) continue;
        const pr = await fetch(`https://api.line.me/v2/bot/profile/${c.userId}`, { headers: { Authorization: `Bearer ${lineToken}` } });
        if (!pr.ok) continue;
        const pd = await pr.json();
        if (pd?.displayName) c.name = pd.displayName;
      }
    }
  } catch {}

  return res.json({ ok:true, source:'local+render', contacts });
});

app.get('/api/quadrant-targets', requireAdmin, (req, res) => {
  const q = String(req.query.q || '');
  const contacts = readJson(CONTACTS_FILE, []);
  const now = Date.now();
  const in30d = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && (now - t) <= 30*24*3600*1000;
  };
  const rows = contacts.filter(c => c.userId).map(c => {
    const highValue = Boolean(c.enabled) && c.name && c.name !== '新客戶';
    const stable = in30d(c.last_contact_at);
    let quadrant = 'low_value_high_risk';
    if (highValue && stable) quadrant = 'high_value_stable';
    else if (highValue && !stable) quadrant = 'high_value_high_risk';
    else if (!highValue && stable) quadrant = 'low_value_stable';
    return { userId: c.userId, name: c.name || '', last_contact_at: c.last_contact_at || '', quadrant };
  }).filter(x => !q || x.quadrant === q).slice(0, 20);
  res.json({ ok:true, q, rows });
});

app.post('/api/contacts/import', requireAdmin, (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];
  if (!incoming.length) return res.status(400).json({ ok: false, error: 'empty payload' });
  const curr = readJson(CONTACTS_FILE, []);
  const map = new Map(curr.filter(c => c.userId).map(c => [c.userId, c]));
  let added = 0, updated = 0;
  for (const c of incoming) {
    if (!c.userId) continue;
    if (map.has(c.userId)) {
      const old = map.get(c.userId);
      const merged = { ...old, ...c };
      if ((c.name === '新客戶' || !c.name) && old?.name && old.name !== '新客戶') merged.name = old.name;
      if (old?.manual_mode !== undefined && merged.manual_mode === undefined) merged.manual_mode = old.manual_mode;
      map.set(c.userId, merged);
      updated++;
    } else {
      map.set(c.userId, c);
      added++;
    }
  }
  const merged = [...map.values()];
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  res.json({ ok: true, added, updated, total: merged.length });
});

app.post('/api/contacts/manual-mode', requireAdmin, (req, res) => {
  const { userId, manual } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
  const contacts = readJson(CONTACTS_FILE, []);
  const idx = contacts.findIndex(c => c.userId === userId);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'user not found' });
  contacts[idx].manual_mode = Boolean(manual);
  contacts[idx].manual_updated_at = new Date().toISOString();
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  res.json({ ok: true, userId, manual: contacts[idx].manual_mode });
});

app.get('/api/export/today.csv', requireAdmin, (req, res) => {
  const date = req.query.date || todayTW();
  const rows = parseSendRandom(date);
  const header = 'time,userId,name,messagePreview\n';
  const body = rows.map(r => [r.time, r.userId, r.name, r.messagePreview].map(x => `"${String(x || '').replaceAll('"', '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="care-${date}.csv"`);
  res.send(header + body);
});

app.post('/api/report/generate', requireAdmin, (req, res) => {
  const date = req.body?.date || todayTW();
  const overview = {
    contacts: readJson(CONTACTS_FILE, []).length,
    enabled: readJson(CONTACTS_FILE, []).filter(c => c.enabled).length,
    tasks: parsePipeline(date),
    care: parseSendRandom(date),
    alerts: parseAlerts(date)
  };

  const success = overview.tasks.filter(t => t.status === 'success').length;
  const failed = overview.tasks.filter(t => String(t.status).startsWith('failed')).length;

  const lines = [];
  lines.push(`# LINE 今日總覽報告 (${date})`);
  lines.push('');
  lines.push(`- 總名單：${overview.contacts}`);
  lines.push(`- 啟用名單：${overview.enabled}`);
  lines.push(`- 任務成功：${success}`);
  lines.push(`- 任務失敗：${failed}`);
  lines.push(`- 今日主動定聯：${overview.care.length}`);
  lines.push(`- 告警數：${overview.alerts.length}`);
  lines.push('');
  lines.push('## 今日任務');
  for (const t of overview.tasks) lines.push(`- ${t.time || ''}｜${t.step}｜${t.status}`);
  lines.push('');
  lines.push('## 今日主動定聯');
  for (const c of overview.care) lines.push(`- ${c.time || ''}｜${c.name || c.userId}｜${c.messagePreview || ''}`);
  lines.push('');
  lines.push('## 告警');
  if (!overview.alerts.length) lines.push('- 無');
  for (const a of overview.alerts) lines.push(`- ${a}`);

  const outDir = path.join(process.env.HOME, 'Desktop', '龍蝦', 'OpenClaw_一鍵還原包_20260310-143757');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `LINE_今日總覽報告-${date}.md`);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');

  res.json({ ok: true, path: outFile });
});

app.get('/api/care-templates', requireAdmin, (req, res) => {
  try {
    const file = path.join(ROOT, 'care_messages.json');
    const bank = readJson(file, {});
    const templates = Object.keys(bank).filter(k => Array.isArray(bank[k]) && bank[k].length > 0);
    res.json({ ok:true, templates });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get('/api/care-template-messages', requireAdmin, (req, res) => {
  try {
    const file = path.join(ROOT, 'care_messages.json');
    const bank = readJson(file, {});
    const template = String(req.query.template || '').trim();
    if (template && Array.isArray(bank[template])) return res.json({ ok:true, messages: bank[template] });
    const all = Object.values(bank).filter(Array.isArray).flat();
    res.json({ ok:true, messages: all });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

function readLineToken() {
  let token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token) {
    const envPath = path.join(ROOT, '.env');
    if (fs.existsSync(envPath)) {
      const txt = fs.readFileSync(envPath, 'utf8');
      const m = txt.match(/^LINE_CHANNEL_ACCESS_TOKEN=(.*)$/m);
      if (m) token = m[1].trim().replace(/^"|"$/g, '');
    }
  }
  return token;
}

app.post('/api/actions/run-care', requireAdmin, (req, res) => {
  if (req.body?.confirm !== 'RUN') return res.status(400).json({ ok: false, error: 'confirm token required' });
  const template = String(req.body?.template || '').trim();
  const fixedMessage = String(req.body?.message || '').trim();
  const mediaPath = String(req.body?.mediaPath || '').trim();
  const mediaType = String(req.body?.mediaType || '').trim();
  const mediaPreviewUrlIn = String(req.body?.mediaPreviewUrl || '').trim();
  const flexJson = String(req.body?.flexJson || '').trim();
  const safeTpl = template ? template.replace(/[^a-zA-Z0-9_\-]/g, '') : '';
  const fixedB64 = fixedMessage ? Buffer.from(fixedMessage, 'utf8').toString('base64') : '';
  const mediaTypeSafe = mediaType.replace(/[^a-z]/g, '');
  const mediaPreviewUrl = mediaPreviewUrlIn;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:3977').split(',')[0];
  let mediaUrl = '';
  if (mediaPath) {
    if (/^https?:\/\//i.test(mediaPath)) {
      mediaUrl = mediaPath;
    } else if (mediaPath.startsWith('/uploads/')) {
      const base = PUBLIC_MEDIA_BASE_URL || '';
      if (!base) {
        return res.status(400).json({ ok:false, error:'附件目前儲存在本機，LINE 無法讀取。請改用公開 https 圖片/影片網址，或設定 PUBLIC_MEDIA_BASE_URL。' });
      }
      mediaUrl = `${base.replace(/\/$/, '')}${mediaPath}`;
    } else {
      mediaUrl = `${proto}://${host}${mediaPath}`;
    }
  }
  const mediaB64 = mediaUrl ? Buffer.from(mediaUrl, 'utf8').toString('base64') : '';
  const mediaPreviewB64 = mediaPreviewUrl ? Buffer.from(mediaPreviewUrl, 'utf8').toString('base64') : '';
  const flexB64 = flexJson ? Buffer.from(flexJson, 'utf8').toString('base64') : '';

  if (mediaUrl && !/^https:\/\//i.test(mediaUrl)) {
    return res.status(400).json({ ok:false, error:'媒體網址必須是公開 https 連結' });
  }
  if (mediaTypeSafe === 'video') {
    if (/youtube\.com|youtu\.be/i.test(mediaUrl)) {
      return res.status(400).json({ ok:false, error:'LINE 不支援 YouTube 當影片訊息來源，需 mp4 直連網址' });
    }
    if (!/\.mp4(\?|$)/i.test(mediaUrl)) {
      return res.status(400).json({ ok:false, error:'影片網址需為 mp4 直連' });
    }
    if (!mediaPreviewUrl || !/^https:\/\//i.test(mediaPreviewUrl)) {
      return res.status(400).json({ ok:false, error:'影片發送需要 previewImageUrl（公開 https 圖片網址）' });
    }
  }

  const envParts = [];
  if (flexB64) envParts.push(`CARE_FLEX_B64='${flexB64}'`);
  if (fixedB64) envParts.push(`CARE_FIXED_MESSAGE_B64='${fixedB64}'`);
  else if (safeTpl) envParts.push(`CARE_TEMPLATE='${safeTpl}'`);
  if (mediaB64) envParts.push(`CARE_MEDIA_URL_B64='${mediaB64}'`);
  if (mediaPreviewB64) envParts.push(`CARE_MEDIA_PREVIEW_URL_B64='${mediaPreviewB64}'`);
  if (mediaTypeSafe) envParts.push(`CARE_MEDIA_TYPE='${mediaTypeSafe}'`);
  const envPrefix = envParts.length ? envParts.join(' ') + ' ' : '';
  const cmd = `cd '${ROOT}' && ${envPrefix}/opt/homebrew/bin/node send_random5.js`;
  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      const raw = (stderr || err.message || '').trim();
      let msg = raw;
      if (raw.includes('done-with-fail')) {
        const sendLog = readText(path.join(LOG_DIR, 'send_random5.log'));
        if (sendLog.includes('status=429') || sendLog.includes('monthly limit')) {
          msg = '發送失敗：LINE 月配額已用完（429）。請先補充額度後再重試。';
        } else {
          msg = '發送失敗：本次定聯全部失敗，請檢查附件網址、模板內容或 LINE API 回應。';
        }
      }
      return res.status(500).json({ ok: false, error: msg, raw });
    }
    res.json({ ok: true, output: stdout.trim(), template: safeTpl || null });
  });
});

app.post('/api/actions/test-send-media', requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.userId || '').trim();
    const message = String(req.body?.message || '這是一則測試訊息').trim();
    const mediaPath = String(req.body?.mediaPath || '').trim();
    const mediaType = String(req.body?.mediaType || '').trim();
    const mediaPreviewUrl = String(req.body?.mediaPreviewUrl || '').trim();
    if (!/^U[0-9a-f]{32}$/i.test(userId)) return res.status(400).json({ ok:false, error:'userId 格式錯誤' });

    let mediaUrl = mediaPath;
    if (mediaPath && !/^https?:\/\//i.test(mediaPath)) {
      if (mediaPath.startsWith('/uploads/')) {
        // 優先用 env 設定的公開 URL，否則嘗試從請求 Origin / Host 自動偵測（適用於 cloudflared 隧道）
        let baseUrl = PUBLIC_MEDIA_BASE_URL;
        if (!baseUrl) {
          const origin = req.headers.origin || '';
          const forwardedProto = req.headers['x-forwarded-proto'] || '';
          const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host || '';
          if (origin && /^https:\/\//i.test(origin)) {
            baseUrl = origin;
          } else if (forwardedProto === 'https' && forwardedHost) {
            baseUrl = `https://${forwardedHost}`;
          }
        }
        if (!baseUrl) return res.status(400).json({ ok:false, error:'本機 uploads 無法給 LINE 存取，請透過 cloudflared 隧道開啟面板後再試，或設定 PUBLIC_MEDIA_BASE_URL 環境變數' });
        mediaUrl = `${baseUrl.replace(/\/$/, '')}${mediaPath}`;
      }
    }

    if (mediaUrl && !/^https:\/\//i.test(mediaUrl)) return res.status(400).json({ ok:false, error:'媒體網址需為 https' });
    if (mediaType === 'video') {
      if (/youtube\.com|youtu\.be/i.test(mediaUrl)) return res.status(400).json({ ok:false, error:'LINE 不支援 YouTube 當影片訊息來源，需 mp4 直連網址' });
      if (!/\.mp4(\?|$)/i.test(mediaUrl)) return res.status(400).json({ ok:false, error:'影片網址需為 mp4 直連' });
      if (!/^https:\/\//i.test(mediaPreviewUrl)) return res.status(400).json({ ok:false, error:'影片封面圖需為 https 圖片網址' });
    }

    const token = readLineToken();
    if (!token) return res.status(500).json({ ok:false, error:'LINE token missing' });

    const messages = [{ type:'text', text: message || '測試訊息' }];
    if (mediaUrl && mediaType === 'image') messages.push({ type:'image', originalContentUrl: mediaUrl, previewImageUrl: mediaUrl });
    if (mediaUrl && mediaType === 'video') messages.push({ type:'video', originalContentUrl: mediaUrl, previewImageUrl: mediaPreviewUrl });

    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages })
    });
    const txt = await r.text();
    if (!r.ok) return res.status(500).json({ ok:false, error:`LINE API ${r.status}: ${txt}` });
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

app.post('/api/actions/retry-step', requireAdmin, (req, res) => {
  const step = req.body?.step;
  const cmds = {
    sync_materials: `cd '${ROOT}' && /opt/homebrew/bin/node sync_materials.js`,
    sync_render_contacts: `bash '${ROOT}/sync_render_contacts_to_desktop.sh'`,
    sync_names: `cd '${ROOT}' && set -a && [ -f ./.env ] && . ./.env; set +a; /opt/homebrew/bin/node sync_names.js`,
    sync_render_contacts_after_names: `bash '${ROOT}/sync_render_contacts_to_desktop.sh'`
  };
  if (!cmds[step]) return res.status(400).json({ ok: false, error: 'unsupported step' });
  exec(cmds[step], (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
    try {
      const now = new Date();
      const ts = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', ' ');
      fs.appendFileSync(path.join(LOG_DIR, 'alerts.log'), `[${ts}] STEP[${step}] RESOLVED by manual retry\n`, 'utf8');
    } catch {}
    res.json({ ok: true, step, output: (stdout || '').trim() });
  });
});

app.post('/api/actions/sync-contacts', requireAdmin, (req, res) => {
  const cmd = `cd '${ROOT}' && set -a && [ -f ./.env ] && . ./.env; set +a; bash './sync_render_contacts_to_desktop.sh' && /opt/homebrew/bin/node './sync_names.js' && bash './sync_render_contacts_to_desktop.sh'`;
  exec(cmd, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
    res.json({ ok: true, output: (stdout || '').trim() });
  });
});

app.get('/api/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const timer = setInterval(() => {
    const payload = { ts: Date.now() };
    res.write(`event: heartbeat\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }, 10000);

  req.on('close', () => clearInterval(timer));
});

// ──────────────────────────────────────────────
// Tier-2 #6  敏感詞審核佇列 API
// ──────────────────────────────────────────────
// 列出待審核 + 最近已處理的（給 dashboard 顯示用）
app.get('/api/approval-queue', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'supabase-unavailable' });
  try {
    const status = String(req.query.status || 'pending');
    const limit  = Math.min(Number(req.query.limit || 50), 200);
    let q = supabase.from('approval_queue').select('*').order('created_at', { ascending: false }).limit(limit);
    if (status && status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, rows: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

// 核可送出（可選 finalReply：改寫過的版本）
app.post('/api/approval-queue/:id/approve', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'supabase-unavailable' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad-id' });

  const finalReply = (req.body?.finalReply || '').toString().trim();

  try {
    // 1) 原子領取：pending → approved
    const { data: claimed, error: e1 } = await supabase
      .from('approval_queue')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'pending').select().single();
    if (e1 || !claimed) {
      return res.status(409).json({ ok: false, error: 'already-reviewed-or-not-found' });
    }
    const textToSend = finalReply || claimed.draft_reply || '';
    if (!textToSend) {
      await supabase.from('approval_queue').update({ status: 'rejected', last_error: 'empty reply' }).eq('id', id);
      return res.status(400).json({ ok: false, error: 'empty-reply' });
    }

    // 2) 送 LINE push
    const pr = await linePush.pushText(claimed.user_id, textToSend);
    if (!pr.ok) {
      await supabase.from('approval_queue').update({
        status: 'failed',
        last_error: `push failed: ${pr.reason || pr.status}`
      }).eq('id', id);
      return res.status(502).json({ ok: false, error: 'line-push-failed', detail: pr });
    }

    // 3) 標記 sent
    await supabase.from('approval_queue').update({
      status: 'sent',
      final_reply: finalReply || null,
      sent_at: new Date().toISOString()
    }).eq('id', id);

    res.json({ ok: true, id, sent: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

// 拒絕（不送任何東西給客戶）
app.post('/api/approval-queue/:id/reject', requireAdmin, async (req, res) => {
  if (!supabase) return res.status(503).json({ ok: false, error: 'supabase-unavailable' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'bad-id' });
  const reason = (req.body?.reason || '').toString().slice(0, 500);
  try {
    const { error } = await supabase
      .from('approval_queue')
      .update({
        status: 'rejected',
        reviewed_at: new Date().toISOString(),
        last_error: reason || null
      })
      .eq('id', id).eq('status', 'pending');
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

// ──────────────────────────────────────────────
// Tier-2 #6  手動廣播 API
// ──────────────────────────────────────────────
// body: { message: '...', userIds?: [...], segment?: 'all'|'enabled' }
// 若沒給 userIds，依 segment 從 contacts.json 挑：
//   all     → 所有有 userId 的
//   enabled → 只有 enabled !== false 的（預設）
app.post('/api/manual-broadcast', requireAdmin, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const segment = String(req.body?.segment || 'enabled').trim();
    const explicitIds = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(Boolean) : null;

    if (!message) return res.status(400).json({ ok: false, error: 'message required' });
    if (message.length > 4500) return res.status(400).json({ ok: false, error: 'message too long (LINE 5000 char limit)' });

    // 組 target 清單
    let targets = [];
    if (explicitIds && explicitIds.length > 0) {
      targets = explicitIds.map(String);
    } else {
      const contacts = readJson(CONTACTS_FILE, []);
      targets = contacts
        .filter(c => c && c.userId)
        .filter(c => segment === 'all' ? true : (c.enabled !== false))
        .map(c => c.userId);
    }

    if (targets.length === 0) return res.status(400).json({ ok: false, error: 'no targets' });
    if (targets.length > 500)  return res.status(400).json({ ok: false, error: 'too many targets (>500), split batch' });

    if (!linePush.loadToken()) {
      return res.status(503).json({ ok: false, error: 'LINE_CHANNEL_ACCESS_TOKEN missing' });
    }

    // 逐一 push（LINE 有 rate limit，不 parallel）
    const result = await linePush.pushTextToMany(targets, message);

    // 寫進既有的 oa_manual_broadcast 稽核 log
    try {
      fs.mkdirSync(path.dirname(OA_MANUAL_LOG_FILE), { recursive: true });
      fs.appendFileSync(OA_MANUAL_LOG_FILE, JSON.stringify({
        source:   'manual-broadcast',
        segment,
        message,
        targets:  targets.length,
        ok:       result.ok,
        fail:     result.fail,
        sentAt:   new Date().toISOString()
      }) + '\n', 'utf8');
    } catch (_) {}

    res.json({
      ok: true,
      total: targets.length,
      sent:   result.ok,
      failed: result.fail,
      results: (result.results || []).slice(0, 50)   // 前 50 筆做失敗排查；避免回太大
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

// 預覽將要發送給幾位（不實際送）
// ?segment=all|enabled
app.get('/api/manual-broadcast/preview', requireAdmin, (req, res) => {
  try {
    const segment = String(req.query.segment || 'enabled').trim();
    const contacts = readJson(CONTACTS_FILE, []);
    const count = contacts
      .filter(c => c && c.userId)
      .filter(c => segment === 'all' ? true : (c.enabled !== false))
      .length;
    res.json({ ok: true, segment, count });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message) });
  }
});

const PORT = process.env.DASHBOARD_PORT || 3977;
// 預設只綁 127.0.0.1（桌面 App 用）。
// 若需要讓同網段的 iPhone 存取，啟動前 export DASHBOARD_HOST=0.0.0.0
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  const os = require('os');
  const localIp = Object.values(os.networkInterfaces())
    .flat().find(i => i.family === 'IPv4' && !i.internal)?.address || '(查不到IP)';
  console.log(`Dashboard running: http://127.0.0.1:${PORT}  (bind: ${HOST})`);
  if (HOST === '0.0.0.0') {
    console.log(`📱 iPhone 存取網址: http://${localIp}:${PORT}  ⚠️ 服務已對外開放，注意網路安全`);
  } else {
    console.log(`📱 需要 iPhone 同 WiFi 存取？啟動前加  DASHBOARD_HOST=0.0.0.0`);
  }
  console.log(`Admin token file: ${ADMIN_TOKEN_FILE}`);
});
