require('dotenv').config();
const fs = require('fs');
const { runJob } = require('./scripts/alert');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CONTACTS_FILE = './contacts.json';
const MESSAGE_BANK_FILE = './care_messages.json';
const LOG_FILE = './logs/care_check.log';

// 規則
const INACTIVE_DAYS = 30;      // 超過幾天未聯繫才觸發
const CARE_COOLDOWN_DAYS = 14; // 關心後最短間隔
const DAILY_MAX = 5;           // 每天最多發幾位
const QUIET_HOURS_START = 22;  // 22:00 後不發
const QUIET_HOURS_END = 8;     // 08:00 前不發

function nowTs() {
  return new Date().toISOString();
}

function daysBetween(a, b) {
  const d1 = new Date(a).getTime();
  const d2 = new Date(b).getTime();
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function inQuietHours() {
  const hour = new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Taipei' });
  const h = Number(hour);
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END;
}

function readMessageBank() {
  if (!fs.existsSync(MESSAGE_BANK_FILE)) return {};
  return JSON.parse(fs.readFileSync(MESSAGE_BANK_FILE, 'utf8'));
}

function pickTemplate(name = '你', bank = {}) {
  const groups = Object.values(bank).filter(arr => Array.isArray(arr) && arr.length > 0);
  if (!groups.length) return `嗨 ${name}，最近好嗎？想關心你一下，記得照顧自己。`;

  const group = groups[Math.floor(Math.random() * groups.length)];
  const raw = group[Math.floor(Math.random() * group.length)];
  return raw.replaceAll('{name}', name);
}

async function pushText(userId, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text }]
    })
  });

  const body = await r.text();
  return { ok: r.ok, status: r.status, body };
}

function log(line) {
  fs.mkdirSync('./logs', { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}

runJob('care_check', async () => {
  if (!TOKEN) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');
  }

  if (inQuietHours()) {
    log('SKIP quiet hours');
    return;
  }

  if (!fs.existsSync(CONTACTS_FILE)) {
    throw new Error('contacts.json not found');
  }

  const contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
  const messageBank = readMessageBank();
  const now = new Date();
  let sent = 0;

  for (const c of contacts) {
    if (sent >= DAILY_MAX) break;
    if (!c.enabled) continue;

    const lastContact = c.last_contact_at || '1970-01-01T00:00:00Z';
    const lastCare = c.last_care_at || '1970-01-01T00:00:00Z';

    const inactiveDays = daysBetween(lastContact, now);
    const cooldownDays = daysBetween(lastCare, now);

    if (inactiveDays < INACTIVE_DAYS) continue;
    if (cooldownDays < CARE_COOLDOWN_DAYS) continue;

    const msg = pickTemplate(c.name || '你', messageBank);
    const rs = await pushText(c.userId, msg);

    if (rs.ok) {
      c.last_care_at = nowTs();
      sent += 1;
      log(`OK user=${c.userId} name=${c.name || ''} inactive=${inactiveDays}d`);
    } else {
      log(`FAIL user=${c.userId} status=${rs.status} body=${rs.body}`);
    }
  }

  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');
  log(`DONE sent=${sent}`);
});
