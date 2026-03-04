require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';



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
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = (event.message.text || '').trim();
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

function buildResponseMessage(text, quickReply = buildQuickReplyPayload()) {
  return quickReply ? { type: 'text', text, quickReply } : { type: 'text', text };
}

function buildQuickReplyPayload() {
  const items = [
    { label: '基金摘要', text: '基金摘要' },
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

  return null;
}

function isWeatherIntent(text) {
  return ['天氣', '下雨', '氣溫', '冷嗎', '熱嗎', '穿什麼'].some((kw) => text.includes(kw));
}

function isTimeIntent(text) {
  return text.includes('幾點') || text.includes('現在時間') || text.includes('時間?') || text.endsWith('時間');
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
    return `👔 小平：台北現在 ${temp}°C，體感 ${feelsLike}°C，${description}，濕度 ${humidity}% ，風速 ${wind} m/s，外出記得調整穿著。`;
  } catch (error) {
    console.error('取得天氣失敗：', error);
    return '👔 小平：查天氣時遇到點問題，我再補給你最新資訊。';
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
  return `👔 小平：現在是台北時間 ${formatted}，我在這裡，隨時幫你處理下一件事。`;
}

function buildPlanSuggestion() {
  return [
    '👔 小平：交給我，這樣安排如何？',
    '',
    '30 分鐘：找個舒服的角落，深呼吸 + 白噪音，先把腦袋清乾淨。',
    '60 分鐘：挑一個對自己好的行動（伸展 / 走動 / 喝溫熱飲），讓身體醒來。',
    '120 分鐘：把今天想完成的事寫成三個小任務，完成就打 ✔️，動力會回來。'
  ].join('
');
}

function buildPlanQuickReply() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: '30 分鐘放空', text: '幫我安排 30 分鐘放空' } },
      { type: 'action', action: { type: 'message', label: '寫工作行程', text: '幫我排工作節奏' } },
      { type: 'action', action: { type: 'message', label: '基金摘要', text: '基金摘要' } }
    ]
  };
}

const personaInstruction = `你是「小平」，溫暖又專業的保險 / 基金顧問兼管理學教練。
- 語氣：像在和老朋友喝咖啡，一開始先一句暖心總結，後面再給 2-3 個重點建議。
- 內容：可運用星座、易經等軟技巧做比喻，但要落在具體行動上。
- 互動：如果需求不清楚，先共感，接著提出 1 個追問或建議的下一步。
- 自然感：不要複製貼上固定開頭或結尾，每次都引用使用者的關鍵詞，像真人即時對話。
- 篇幅：1 到 3 段，每段 1-2 句，避免長篇 lecture。
- 限制：使用繁體中文，不做保證報酬、不觸犯金管會規範，無資料時坦承並提供可行替代方案。
- 形式：允許適度使用 emoji（特別是 👔 小平 開頭），段落短、易讀。`

const fewShotExamples = `客戶：我最近壓力很大，基金都在跌。
小平：👔 小平：先吸一口氣，我懂那種起伏。先把資金分成「必要」與「可調整」兩桶，再鎖定本週的美股與美元指標，幫你減少波動。

客戶：團隊裡有個射手座業務，很有想法但不愛回報。
小平：👔 小平：射手座重視空間，給他「戰術目標＋截止日」會比盯過程更有效，易經講「離卦」——給火焰方向，它就能照亮戰場。`;

function buildPrompt(userText, event) {
  const topicHint = buildTopicHint(userText);
  const sourceInfo = event?.source?.type === 'user' ? '個人客戶' : '群組';

  return `${fewShotExamples}
---
使用者類型：${sourceInfo}
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

function buildReply(rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return '👔 小平在線，請告訴我想處理的事項（保單、基金、主管輔導等）。';
  }

  if (/^(hi|hello|hey|嗨|你好)/i.test(text)) {
    return '👔 小平：您好，我是您的保險與基金顧問，想先聊保單、基金還是主管輔導？';
  }

  if (text.includes('保單') || text.includes('健檢')) {
    return '👔 小平：收到保單需求，請把想檢視的保單重點（險種、保額、保費）貼給我，我會整理缺口與建議。';
  }

  if (text.includes('基金') || text.includes('投資')) {
    return '👔 小平：基金資訊我會整合 KGI 指定四檔＋國際市場，若有想加碼/贖回的標的也可以直接說。';
  }

  if (text.includes('主管') || text.includes('輔導') || lower.includes('coaching')) {
    return '👔 小平：身為管理學大師的輔導夥伴，請描述成員狀況與目標，我會用星座＋易經角度給策略。';
  }

  return '👔 小平：這邊再確認一下細節，等一下把整理好的重點回覆你。';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器運行在 http://localhost:${PORT}`);
});
