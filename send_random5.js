require('dotenv').config();
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const BANK_FILE = path.join(__dirname, 'care_messages.json');
const RULES_FILE = path.join(__dirname, 'rules.json');
const AB_TEST_FILE = path.join(__dirname, 'ab_test.json');
const LOG_FILE = path.join(__dirname, 'logs', 'send_random5.log');
const { appendEvent, hashText, previewText, ensureFile: ensureAbFile, DEFAULT_EVENT_FILE } = require('./ab_event_store');

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
  variantB: { name: 'B', weight: 50 }
};

function loadRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) return DEFAULT_RULES;
    const userRules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return { ...DEFAULT_RULES, ...userRules };
  } catch {
    return DEFAULT_RULES;
  }
}

function log(msg) {
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
}

function loadAbTest() {
  try {
    if (!fs.existsSync(AB_TEST_FILE)) return DEFAULT_AB_TEST;
    const raw = JSON.parse(fs.readFileSync(AB_TEST_FILE, 'utf8'));
    return {
      ...DEFAULT_AB_TEST,
      ...raw,
      variantA: { ...DEFAULT_AB_TEST.variantA, ...(raw.variantA || {}) },
      variantB: { ...DEFAULT_AB_TEST.variantB, ...(raw.variantB || {}) }
    };
  } catch {
    return DEFAULT_AB_TEST;
  }
}

function stableBucket(userId = '') {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) % 100000;
  }
  return h % 100;
}

function pickVariant(userId, ab) {
  if (!ab?.enabled) return 'A';
  const wA = Math.max(0, Math.min(100, Number(ab?.variantA?.weight ?? 50)));
  return stableBucket(userId) < wA ? 'A' : 'B';
}

function msgKey(msg='') {
  return msg.trim().toLowerCase();
}

function todayTW() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function dateOnlyTW(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / 3600000;
}

function pickRandom(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function pickMessage(bank, name='你', forcedTemplate='') {
  if (forcedTemplate && Array.isArray(bank[forcedTemplate]) && bank[forcedTemplate].length > 0) {
    const g = bank[forcedTemplate];
    const m = g[Math.floor(Math.random() * g.length)];
    return m.replaceAll('{name}', name);
  }
  const groups = Object.values(bank).filter(x => Array.isArray(x) && x.length > 0);
  if (!groups.length) return `嗨 ${name}，最近好嗎？只是想關心你一下 😊`;
  const g = groups[Math.floor(Math.random() * groups.length)];
  const m = g[Math.floor(Math.random() * g.length)];
  return m.replaceAll('{name}', name);
}

function countTodaySentFromLog(today) {
  try {
    if (!fs.existsSync(LOG_FILE)) return 0;
    const txt = fs.readFileSync(LOG_FILE, 'utf8');
    let n = 0;
    for (const line of txt.split('\n')) {
      const m = line.match(/^\[(.*?)\]\s+OK\s+/);
      if (!m) continue;
      if (dateOnlyTW(m[1]) === today) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

async function pushText(to, text, mediaUrl = '', mediaType = '', flexJson = '') {
  let messages = [{ type: 'text', text }];
  if (flexJson) {
    try { messages = [JSON.parse(flexJson)]; } catch {}
  } else if (mediaUrl && mediaType === 'image') {
    messages.push({ type: 'image', originalContentUrl: mediaUrl, previewImageUrl: mediaUrl });
  } else if (mediaUrl && mediaType) {
    messages[0].text = `${text}\n${mediaUrl}`;
  }

  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ to, messages })
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body };
}

(async () => {
  if (!TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');
  if (!fs.existsSync(CONTACTS_FILE)) throw new Error('contacts.json not found');
  if (!fs.existsSync(BANK_FILE)) throw new Error('care_messages.json not found');

  const rules = loadRules();
  const abTest = loadAbTest();
  ensureAbFile(DEFAULT_EVENT_FILE);
  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const bank = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
  const forcedTemplate = (process.env.CARE_TEMPLATE || process.argv[2] || '').trim();
  const fixedMessage = process.env.CARE_FIXED_MESSAGE_B64
    ? Buffer.from(process.env.CARE_FIXED_MESSAGE_B64, 'base64').toString('utf8')
    : (process.env.CARE_FIXED_MESSAGE || '').trim();
  const mediaUrl = process.env.CARE_MEDIA_URL_B64
    ? Buffer.from(process.env.CARE_MEDIA_URL_B64, 'base64').toString('utf8')
    : (process.env.CARE_MEDIA_URL || '').trim();
  const mediaType = (process.env.CARE_MEDIA_TYPE || '').trim();
  const flexJson = process.env.CARE_FLEX_B64
    ? Buffer.from(process.env.CARE_FLEX_B64, 'base64').toString('utf8')
    : (process.env.CARE_FLEX_JSON || '').trim();
  const surveyBase = (process.env.SURVEY_BASE_URL || process.env.RENDER_BASE_URL || 'https://line-smart-bot-sg.onrender.com').replace(/\/+$/,'');
  const today = todayTW();

  const candidates = contacts.filter(c => {
    if (!c.userId) return false;
    if (rules.requireEnabled && !c.enabled) return false;

    const lastCareDay = dateOnlyTW(c.last_care_at);
    if (rules.dailyLimitPerUser <= 1 && lastCareDay === today) return false;

    if (hoursSince(c.last_care_at) < Number(rules.minHoursBetweenCare || 0)) return false;

    return true;
  });

  const pickCount = Number(rules.pickCount || 5);
  const cap = Math.max(1, Number(rules.emergencyDailyLimitCap || 200));
  const sentToday = countTodaySentFromLog(today);
  const remainingCap = Math.max(0, cap - sentToday);
  const picked = pickRandom(candidates, Math.min(pickCount, candidates.length, remainingCap));
  if (remainingCap <= 0) {
    log(`SKIP emergency cap reached today=${today} cap=${cap}`);
    console.log(`⏸️ emergency cap reached: today=${today}, cap=${cap}`);
  }

  let ok = 0, fail = 0;
  for (const c of picked) {
    let msg = fixedMessage || pickMessage(bank, c.name || '你', forcedTemplate);
    msg = msg.replaceAll('{uid}', c.userId || '');

    const todayMark = todayTW();
    if (!Array.isArray(c.sent_today_messages)) c.sent_today_messages = [];
    if (c.sent_today_date !== todayMark) {
      c.sent_today_date = todayMark;
      c.sent_today_messages = [];
    }

    const allMsgs = Object.values(bank).flat().map(x => (x || '').trim()).filter(Boolean);
    let guard = 0;
    while (c.sent_today_messages.includes(msgKey(msg)) && guard < 20) {
      msg = allMsgs[Math.floor(Math.random() * allMsgs.length)] || msg;
      guard++;
    }

    if (!msg.includes('survey-track.html?uid=')) {
      const surveyUrl = `${surveyBase}/survey-track.html?uid=${encodeURIComponent(c.userId)}`;
      msg = `${msg}\n\n📝 回饋問卷：${surveyUrl}`;
    }

    let flexJsonForUser = flexJson;
    if (flexJsonForUser && flexJsonForUser.includes('{uid}')) {
      flexJsonForUser = flexJsonForUser.replaceAll('{uid}', encodeURIComponent(c.userId || ''));
    }

    const variant = pickVariant(c.userId, abTest);
    const rs = await pushText(c.userId, msg, mediaUrl, mediaType, flexJsonForUser);

    if (rs.ok) {
      ok++;
      const sentAt = new Date().toISOString();
      c.last_care_at = sentAt;
      c.sent_today_messages = c.sent_today_messages || [];
      c.sent_today_messages.push(msgKey(msg));

      appendEvent({
        campaign_id: abTest?.experimentName || 'care-message-variant',
        userId: c.userId,
        variant,
        sent_at: sentAt,
        message_text_hash: hashText(msg),
        message_preview: previewText(msg),
        delivered_status: 'sent',
        replied: false
      });

      log(`OK ${c.userId} ${c.name || ''} variant=${variant} msg=${msg.slice(0,20)}`);
    } else {
      fail++;
      log(`FAIL ${c.userId} variant=${variant} status=${rs.status} body=${rs.body}`);
    }
  }

  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  log(`DONE today=${today} ok=${ok} fail=${fail} candidates=${candidates.length} pickCount=${pickCount} cap=${cap} sentToday=${sentToday}`);
  if (ok === 0 && fail > 0) {
    console.error(`❌ done-with-fail: today=${today}, ok=${ok}, fail=${fail}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ done: today=${today}, ok=${ok}, fail=${fail}, candidates=${candidates.length}, pickCount=${pickCount}, cap=${cap}, sentToday=${sentToday}`);
  }
})();
