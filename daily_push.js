require('dotenv').config();
const { runJob } = require('./scripts/alert');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TO_USERS = [
  'U8643feceed0d8f102b31110b55a2a9d1'
  // 之後可加更多 userId
];

const SOURCE = 'https://www.moneydj.com/kmdj/common/listnewarticles.aspx?svc=NW&a=X0400000';
const KEYWORDS = ['總體經濟','國際股市','外匯','債券','國內外財經','台股','產業','商品原物料','報告','基金','期權'];

function twNow() {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date());
}

function stripHtml(s='') {
  return s.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
}

async function buildSummary() {
  try {
    const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();

    const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const rows = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1] || '';
      const title = stripHtml(m[2] || '');
      if (!title || title.length < 6) continue;
      if (!KEYWORDS.some(k => title.includes(k))) continue;
      const url = href.startsWith('http') ? href : `https://www.moneydj.com${href.startsWith('/') ? '' : '/'}${href}`;
      rows.push({ title, url });
      if (rows.length >= 3) break;
    }

    const impact = rows.map((x,i)=>`- ${i+1}. ${x.title}`).join('\n') || '- 今日無明確關鍵分類新聞';
    const refs = rows.map((x,i)=>`${i+1}) ${x.title}\n${x.url}`).join('\n\n') || SOURCE;

    return [
      `📊 市場監測摘要（${twNow()}）`,
      '',
      '1) 今日盤勢：市場訊號偏觀望，建議先控管部位與風險。',
      '',
      '2) 關鍵影響：',
      impact,
      '',
      '3) 建議動作：',
      '- 先檢視股債配置與現金水位',
      '- 分批布局，不追高',
      '',
      '📎 來源（MoneyDJ）：',
      refs,
      '',
      '⚠️ 本內容為資訊整理，非投資建議。'
    ].join('\n');

  } catch (e) {
    return `📊 市場監測摘要\n目前來源抓取失敗，請稍後再試。\n來源：${SOURCE}`;
  }
}

async function pushText(to, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text }]
    })
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, body: t };
}

runJob('daily_push', async () => {
  if (!TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN missing');
  const text = await buildSummary();
  const fails = [];
  for (const uid of TO_USERS) {
    const rs = await pushText(uid, text);
    console.log(`[${uid}]`, rs.status, rs.body);
    if (!rs.ok) fails.push(`${uid} status=${rs.status}`);
  }
  if (fails.length === TO_USERS.length && TO_USERS.length > 0) {
    throw new Error(`daily_push: all pushes failed -> ${fails.join(' ; ')}`);
  }
});
