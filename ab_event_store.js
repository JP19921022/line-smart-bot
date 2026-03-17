const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_EVENT_FILE = path.join(__dirname, 'data', 'ab_events.jsonl');

function ensureFile(filePath = DEFAULT_EVENT_FILE) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '', 'utf8');
    }
  } catch (error) {
    console.error('[ab_event_store] ensureFile failed:', error.message || error);
  }
}

function hashText(text = '') {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function previewText(text = '', max = 80) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function safeParseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function loadEvents(filePath = DEFAULT_EVENT_FILE) {
  ensureFile(filePath);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(safeParseLine)
      .filter(Boolean);
  } catch (error) {
    console.error('[ab_event_store] loadEvents failed:', error.message || error);
    return [];
  }
}

function appendEvent(event, filePath = DEFAULT_EVENT_FILE) {
  ensureFile(filePath);
  const row = {
    event_id: event?.event_id || crypto.randomUUID(),
    campaign_id: event?.campaign_id || 'care-message-variant',
    userId: event?.userId || '',
    variant: event?.variant || 'A',
    sent_at: event?.sent_at || new Date().toISOString(),
    message_text_hash: event?.message_text_hash || hashText(event?.message_text || ''),
    message_preview: event?.message_preview || previewText(event?.message_text || ''),
    delivered_status: event?.delivered_status || 'sent',
    replied: Boolean(event?.replied),
    replied_at: event?.replied_at || null
  };

  try {
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  } catch (error) {
    console.error('[ab_event_store] appendEvent failed:', error.message || error);
    return null;
  }
}

function markLatestUnrepliedAsReplied(userId, windowHours = 72, now = new Date(), filePath = DEFAULT_EVENT_FILE) {
  if (!userId) return { updated: false, reason: 'missing_user' };
  const events = loadEvents(filePath);
  if (!events.length) return { updated: false, reason: 'no_events' };

  const nowMs = now.getTime();
  const windowMs = Math.max(1, Number(windowHours || 72)) * 3600000;

  let targetIndex = -1;
  let latestMs = -1;

  for (let i = 0; i < events.length; i++) {
    const e = events[i] || {};
    if (e.userId !== userId) continue;
    if (e.replied) continue;
    const sentMs = new Date(e.sent_at).getTime();
    if (!Number.isFinite(sentMs)) continue;
    if (nowMs - sentMs > windowMs) continue;
    if (sentMs > latestMs) {
      latestMs = sentMs;
      targetIndex = i;
    }
  }

  if (targetIndex < 0) return { updated: false, reason: 'no_unreplied_in_window' };

  events[targetIndex].replied = true;
  events[targetIndex].replied_at = now.toISOString();

  try {
    ensureFile(filePath);
    const body = events.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
    return { updated: true, event: events[targetIndex] };
  } catch (error) {
    console.error('[ab_event_store] mark replied failed:', error.message || error);
    return { updated: false, reason: 'write_failed' };
  }
}

function withinDateRange(iso, fromIso, toIso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  if (fromIso) {
    const f = new Date(fromIso).getTime();
    if (Number.isFinite(f) && t < f) return false;
  }
  if (toIso) {
    const e = new Date(toIso).getTime();
    if (Number.isFinite(e) && t > e) return false;
  }
  return true;
}

function getStatsByVariant({ from, to, campaignId } = {}, filePath = DEFAULT_EVENT_FILE) {
  const base = { A: { sent: 0, replied: 0, reply_rate: 0 }, B: { sent: 0, replied: 0, reply_rate: 0 } };
  const events = loadEvents(filePath);

  for (const e of events) {
    if (campaignId && e.campaign_id !== campaignId) continue;
    if (!withinDateRange(e.sent_at, from, to)) continue;
    const v = e.variant === 'B' ? 'B' : 'A';
    base[v].sent += 1;
    if (e.replied) base[v].replied += 1;
  }

  for (const key of ['A', 'B']) {
    base[key].reply_rate = base[key].sent ? Number((base[key].replied / base[key].sent).toFixed(4)) : 0;
  }

  return base;
}

module.exports = {
  DEFAULT_EVENT_FILE,
  ensureFile,
  hashText,
  previewText,
  appendEvent,
  markLatestUnrepliedAsReplied,
  getStatsByVariant,
  loadEvents
};
