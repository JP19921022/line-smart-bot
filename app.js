require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const line = require('@line/bot-sdk');
const memoryStore = require('./memoryStore');
const { getLatestFundEntries } = require('./fundFetcher');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
const KNOWLEDGE_PATH = path.resolve(__dirname, 'knowledge', 'entries.json');
const USER_LOG_PATH = path.resolve(__dirname, 'logs', 'user_ids.log');
const DEBUG_USER_LOG_TOKEN = process.env.DEBUG_USER_LOG_TOKEN || '';
let knowledgeCache = { entries: [], mtimeMs: 0 };

memoryStore.initMemoryStore();


app.get('/', (req, res) => {
  res.send('LINE Smart Bot is running');
});

app.get('/status', (req, res) => {
  res.json({
    service: 'line-smart-bot',
    geminiReady: Boolean(genAI),
    model: GEMINI_MODEL,
  });
});

app.get('/debug/user-ids', (req, res) => {
  try {
    if (DEBUG_USER_LOG_TOKEN) {
      const provided = req.query.token || req.get('x-debug-token');
      if (provided !== DEBUG_USER_LOG_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    if (!fs.existsSync(USER_LOG_PATH)) {
      return res.status(404).json({ error: 'log file not found', path: USER_LOG_PATH });
    }

    const raw = fs.readFileSync(USER_LOG_PATH, 'utf8');
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const slice = lines.slice(-limit).reverse();
    const entries = slice.map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { raw: line, parseError: true };
      }
    });

    res.json({
      count: entries.length,
      limit,
      path: USER_LOG_PATH,
      entries,
    });
  } catch (error) {
    console.error('Unable to serve user id logs:', error);
    res.status(500).json({ error: 'Unable to read user id logs' });
  }
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('處理事件時出錯：', err);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  logUserSource(event);
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = (event.message.text || '').trim();
  maybeStoreMemory(event, userText);
  const structured = await handleStructuredIntent(userText);
  if (structured) {
    return client.replyMessage(event.replyToken, structured);
  }

  await showTypingIndicator(event.source);
  const replyText = await getAssistantReply(event, userText);
  return client.replyMessage(event.replyToken, buildResponseMessage(replyText));
}

async function getAssistantReply(event, rawText) {
  if (!genAI) {
    return buildReply(rawText);
  }

  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: personaInstruction,
    });

    const prompt = buildPrompt(rawText, event);
    const result = await model.generateContent(prompt);
    const textResponse = result?.response?.text()?.trim();

    if (textResponse) {
      return textResponse;
    }
  } catch (error) {
    console.error('Gemini 回應失敗：', error);
  }

  return buildReply(rawText);
}

async function showTypingIndicator(source, durationSeconds = 15) {
  if (!source || source.type !== 'user' || !source.userId) {
    return;
  }

  const roundedSeconds = Math.min(60, Math.max(5, Math.round(durationSeconds / 5) * 5));
  const payload = {
    chatId: source.userId,
    loadingSeconds: roundedSeconds
  };

  try {
    await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.channelAccessToken}`
      },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('無法顯示輸入中動畫：', error);
  }
}

function logUserSource(event) {
  try {
    const userId = event?.source?.userId;
    if (!userId) {
      return;
    }
    const payload = {
      at: new Date().toISOString(),
      userId,
      sourceType: event.source.type,
    };
    const dir = path.dirname(USER_LOG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(USER_LOG_PATH, JSON.stringify(payload) + '\n', 'utf8');
  } catch (error) {
    console.error('記錄 userId 失敗：', error);
  }
}

function buildResponseMessage(text, quickReply = buildQuickReplyPayload()) {
  return quickReply ? { type: 'text', text, quickReply } : { type: 'text', text };
}

function buildQuickReplyPayload() {
  const items = [
    { label: '基金摘要', text: '基金摘要' },
    { label: '保險新聞', text: '保險新聞' },
    { label: '保單健檢', text: '保單健檢' },
    { label: '主管輔導', text: '主管輔導提點' }
  ];
  return {
    items: items.map((item) => ({
      type: 'action',
      action: { type: 'message', label: item.label, text: item.text }
    }))
  };
}

async function handleStructuredIntent(text) {
  if (!text) {
    return null;
  }

  const schedulePrompt = buildScheduleQuickReply(text);
  if (schedulePrompt) {
    return schedulePrompt;
  }

  const scheduleTimesFlex = buildScheduleTimeFlex(text);
  if (scheduleTimesFlex) {
    return scheduleTimesFlex;
  }

  const scheduleAck = buildScheduleAcknowledgement(text);
  if (scheduleAck) {
    return buildResponseMessage(scheduleAck);
  }

  const normalized = text.toLowerCase();

  if (isWeatherIntent(normalized)) {
    const weather = await buildWeatherSummary();
    return buildResponseMessage(weather);
  }

  if (isTimeIntent(normalized)) {
    const clock = buildTimeSummary();
    return buildResponseMessage(clock);
  }

  if (isPlanIntent(normalized)) {
    const planText = buildPlanSuggestion();
    return { type: 'text', text: planText, quickReply: buildPlanQuickReply() };
  }

  const fundSnapshot = await buildFundSnapshot(text);
  if (fundSnapshot) {
    return buildResponseMessage(fundSnapshot);
  }

  const insuranceNews = await buildInsuranceNewsDigest(text);
  if (insuranceNews) {
    return buildResponseMessage(insuranceNews);
  }

  return null;
}

function isWeatherIntent(text) {
  return ['天氣', '下雨', '氣溫', '冷嗎', '熱嗎', '穿什麼'].some((kw) => text.includes(kw));
}

function isTimeIntent(text) {
  if (!text) return false;
  if (text.includes('約時間') || text.includes('預約')) {
    return false;
  }
  const trimmed = text.trim();
  return (
    trimmed === '現在時間' ||
    trimmed === '現在幾點' ||
    trimmed.endsWith('幾點') ||
    trimmed.includes('現在時間') ||
    trimmed.includes('現在幾點')
  );
}

function isPlanIntent(text) {
  return ['安排', '行程', '放空', '無聊', '休息', '充電', '提振'].some((kw) => text.includes(kw));
}

async function buildWeatherSummary() {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=25.05&longitude=121.53&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('weather fetch failed');
    const data = await res.json();
    const current = data?.current;
    if (!current) throw new Error('no weather payload');
    const temp = Math.round(current.temperature_2m);
    const feelsLike = Math.round(current.apparent_temperature);
    const humidity = current.relative_humidity_2m;
    const wind = current.wind_speed_10m;
    const description = describeWeatherCode(current.weather_code);
    return `台北現在 ${temp}°C，體感 ${feelsLike}°C，${description}，濕度 ${humidity}% 、風速 ${wind} m/s，記得照顧好自己。`;
  } catch (error) {
    console.error('取得天氣失敗：', error);
    return '天氣資料暫時抓不到，我會再補上最新的資訊。';
  }
}

function describeWeatherCode(code) {
  const mapping = {
    0: '天空晴朗',
    1: '大多晴朗',
    2: '有些雲',
    3: '陰天',
    45: '有霧',
    48: '凍霧',
    51: '飄著細雨',
    61: '有小雨',
    63: '有陣雨',
    65: '雨勢較大',
    80: '陣雨可能隨時來訪',
    95: '可能有雷陣雨'
  };
  return mapping[code] || '天氣變化大';
}

function buildTimeSummary() {
  const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric'
  });
  const now = new Date();
  const formatted = formatter.format(now);
  return `現在是台北時間 ${formatted}，需要我幫忙的直接說。`;
}

function buildPlanSuggestion() {
  return [
    '這樣安排如何？',
    '',
    '30 分鐘：找個舒服的角落，深呼吸 + 白噪音，先把腦袋清乾淨。',
    '60 分鐘：挑一個對自己好的行動（伸展 / 走動 / 喝溫熱飲），讓身體醒來。',
    '120 分鐘：把今天想完成的事寫成三個小任務，完成就打 ✔️，動力會回來。'
  ].join('\n');
}

function buildPlanQuickReply() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: '30 分鐘放空', text: '幫我安排 30 分鐘放空' } },
      { type: 'action', action: { type: 'message', label: '寫工作行程', text: '幫我排工作節奏' } },
      { type: 'action', action: { type: 'message', label: '基金摘要', text: '基金摘要' } },
      { type: 'action', action: { type: 'message', label: '保險新聞', text: '保險新聞' } }
    ]
  };
}

function buildScheduleQuickReply(text) {
  if (!text) {
    return null;
  }
  if (/^預約時段[:：]/.test(text) || /^預約時間[:：]/.test(text)) {
    return null;
  }
  if (!(text.includes('約時間') || text.includes('預約'))) {
    return null;
  }
  const quickItems = ['上午', '中午', '下午', '晚上'].map((label) => ({
    type: 'action',
    action: {
      type: 'message',
      label,
      text: `預約時段:${label}`
    }
  }));
  return {
    type: 'text',
    text: '收到！你想約哪個時段？先選一個方便的時段，我再提供細部時間。',
    quickReply: { items: quickItems }
  };
}


function buildScheduleTimeFlex(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/^預約時段[:：]\s*(.+)$/);
  if (!match) {
    return null;
  }
  const period = match[1].trim();
  const slotMap = {
    上午: [9, 10, 11, 12],
    中午: [13, 14, 15, 16],
    下午: [17, 18, 19, 20],
    晚上: [21, 22, 23, 24]
  };
  const normalized = period.replace(/\s+/g, '');
  const key = Object.keys(slotMap).find((slot) => normalized.includes(slot)) || normalized;
  const hours = slotMap[key] || slotMap.上午;
  const labels = hours.map((hour) => `${String(hour).padStart(2, '0')}:00`);
  const bubble = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: `${key}｜請選擇時間`,
          weight: 'bold',
          size: 'md'
        },
        ...labels.map((time) => ({
          type: 'button',
          action: {
            type: 'message',
            label: time,
            text: `預約時間:${time} (${key})`
          },
          style: 'secondary',
          height: 'sm'
        }))
      ]
    }
  };
  return {
    type: 'flex',
    altText: `請選擇${key}的預約時間`,
    contents: bubble
  };
}

function buildScheduleAcknowledgement(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/^預約時間[:：]\s*(\d{1,2}:\d{2})(?:\s*\((.+)\))?/);
  if (!match) {
    return null;
  }
  const time = match[1];
  const period = match[2];
  const periodLabel = period ? `${period} ` : '';
  return `收到！先幫你暫留 ${periodLabel}${time}。再告訴我想聊的主題或備註，我一起記下。`;
}

function chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

async function buildFundSnapshot(text) {
  const normalized = text.toLowerCase();
  const keywords = ['基金', '基金摘要', '基金快照', '基金資訊'];
  const idHints = ['accp', 'albt', 'jfzn', 'acti'];
  const shouldTrigger = keywords.some((kw) => normalized.includes(kw)) || idHints.some((hint) => normalized.includes(hint));
  if (!shouldTrigger) {
    return null;
  }

  let entries = [];
  try {
    entries = await getLatestFundEntries();
  } catch (error) {
    console.error('無法即時抓取基金資訊：', error.message);
  }

  if (!entries.length) {
    entries = loadKnowledgeEntries();
  }

  if (!entries.length) {
    return '基金資料庫暫時沒開啟，我會再補上最新快照。';
  }

  const upperText = text.toUpperCase();
  const filtered = entries.filter((entry) => {
    const parts = entry.id.split('-');
    const code = (parts[1] || '').toUpperCase();
    return code && upperText.includes(code);
  });

  const list = (filtered.length ? filtered : entries).slice(0, 3);
  const timestampLabel = formatFundTimestamp(list[0]?.fetchedAt);
  const lines = list.map((entry, index) => {
    const bullets = [
      entry.data?.navValue && `•最新淨值：${entry.data.navValue}`,
      entry.data?.type && `•基金類型：${entry.data.type}`,
      entry.data?.risk && `•風險報酬等級：${entry.data.risk}`
    ].filter(Boolean).join('\n');
    return `【${index + 1}】${entry.title}${bullets ? `\n${bullets}` : ''}`;
  });
  const headerLines = timestampLabel
    ? ['最新基金快照', `（更新：${timestampLabel}）`, '—————————']
    : ['最新基金快照', '—————————'];
  const headerBlock = headerLines.join('\n');
  const entriesBlock = lines.join('\n\n');
  const body = [headerBlock, entriesBlock].filter(Boolean).join('\n\n');
  return body;
}

async function buildInsuranceNewsDigest(text) {
  const normalized = text.toLowerCase();
  const keywords = ['保險新聞', '保險日報', '保險快訊'];
  if (!keywords.some((kw) => normalized.includes(kw))) {
    return null;
  }

  const previewPath = path.resolve(__dirname, 'knowledge', 'insurance_news_preview.txt');
  if (fs.existsSync(previewPath)) {
    try {
      const content = fs.readFileSync(previewPath, 'utf-8').trim();
      if (content) {
        return content;
      }
    } catch (error) {
      console.error('載入保險新聞預覽檔失敗：', error.message);
    }
  }

  return '保險新聞摘要正在整理中，稍後會補上最新的保險日報與連結。';
}

function loadKnowledgeEntries() {
  try {
    const stats = fs.statSync(KNOWLEDGE_PATH);
    if (stats.mtimeMs !== knowledgeCache.mtimeMs) {
      const raw = fs.readFileSync(KNOWLEDGE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      knowledgeCache = {
        entries: parsed.entries || [],
        mtimeMs: stats.mtimeMs
      };
    }
  } catch (error) {
    if (knowledgeCache.entries.length === 0) {
      console.error('無法載入 knowledge entries：', error.message);
    }
  }
  return knowledgeCache.entries;
}

function formatFundTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

const personaInstruction = `你是「小平」，溫暖又專業的保險 / 基金顧問兼管理學教練。
- 語氣：像和家人講電話，先接住情緒，再輕聲給方向。
- 內容：只有在使用者主動提到基金/投資時才聊那段，其他時候就陪伴他當下的心情。
- 互動：資訊不足時先確認情境或下一步，讓對方覺得被理解。
- 篇幅：最多 2 段、每段 1 句且不超過 40 字，避免長篇說教。
- 自然感：引用使用者用詞，可加入貼圖感的語句或 emoji，但不要固定開頭/結尾。
- 限制：使用繁體中文，不保證報酬、不觸犯金管會規範，沒有資料時坦白說明並給替代方案。`

const fewShotExamples = `客戶：我最近壓力很大，基金都在跌。
小平：先抱一下，把錢分成「必要 / 可調整」，盯住美元和美股的節奏就不會那麼慌。

客戶：團隊裡有個射手座業務，很有想法但不愛回報。
小平：給他清楚的目標＋截止日，再留一點迴旋空間，他就會乖乖回報了。`;

function buildPrompt(userText, event) {
  const topicHint = buildTopicHint(userText);
  const sourceInfo = event?.source?.type === 'user' ? '個人客戶' : '群組';
  const userId = event?.source?.type === 'user' ? event.source.userId : '';
  const previousMemories = userId ? memoryStore.getRecentMemories(userId, topicHint, 3) : [];
  const memoryContext = previousMemories.length ? `使用者之前提過：
${previousMemories.join('\n')}
---
` : '';

  return `${fewShotExamples}
---
${memoryContext}使用者類型：${sourceInfo}
可能主題：${topicHint}
使用者輸入：${userText || '（無內容）'}
請以上述 personaInstruction 的口吻回覆，必要時先共感再給建議。`;
}

function buildTopicHint(text) {
  if (!text) return '未知';
  if (text.includes('保單') || text.includes('健檢')) return '保單健檢';
  if (text.includes('基金') || text.includes('投資')) return '基金資訊';
  if (text.includes('主管') || text.includes('輔導') || text.toLowerCase().includes('coach')) return '主管輔導';
  return '一般諮詢';
}

const MEMORY_KEYWORDS = ['保單', '基金', '投資', '主管', '提醒', '紀錄', '記得', '家人', '醫院', '生日', '缺口', '保費', '加碼', '贖回', '壓力'];

function maybeStoreMemory(event, text) {
  if (!text || !event?.source || event.source.type !== 'user') {
    return;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!shouldStoreMemory(normalized)) {
    return;
  }
  const topic = buildTopicHint(normalized);
  const summary = summarizeMemory(normalized);
  memoryStore.saveMemory({ userId: event.source.userId, topic, summary });
}

function shouldStoreMemory(text) {
  if (!text || text.length < 8) return false;
  if (/[0-9]{2,}/.test(text) && /(保費|萬|元|%)/.test(text)) return true;
  return MEMORY_KEYWORDS.some((kw) => text.includes(kw));
}

function summarizeMemory(text) {
  if (text.length <= 60) {
    return text;
  }
  return `${text.slice(0, 57)}...`;
}

function buildReply(rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return '我在線上，想先處理什麼？可以聊保單、基金、主管輔導，或只是說說近況。';
  }

  if (/^(hi|hello|hey|嗨|你好)/i.test(text)) {
    return '嗨，我是小平，可以聊保單、基金、主管輔導，或先聊聊最近的心情。';
  }

  if (text.includes('約時間') || text.includes('預約')) {
    return '好的，想約哪一天、哪個主題？把大致的時段和重點貼給我，我幫你排。';
  }

  if (text.includes('保單') || text.includes('健檢')) {
    return '收到保單需求，請把想檢視的重點（險種、保額、保費）貼給我，我會整理缺口與建議。';
  }

  if (text.includes('基金') || text.includes('投資')) {
    return '基金資訊我會整合 KGI 指定四檔＋國際市場，想調整部位或加碼/贖回也可以直接說。';
  }

  if (text.includes('主管') || text.includes('輔導') || lower.includes('coaching')) {
    return '我這邊有管理學教練的工具，請描述成員狀況與目標，我會給出實際操作步驟。';
  }

  return '我先記下這件事，整理一下就再回覆你。';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器運行在 http://localhost:${PORT}`);
});
