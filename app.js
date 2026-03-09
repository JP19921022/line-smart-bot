require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const line = require('@line/bot-sdk');
const memoryStore = require('./memoryStore');
const { getLatestFundEntries } = require('./fundFetcher');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);
const MAIN_RICH_MENU_ID = process.env.RICH_MENU_MAIN_ID || 'richmenu-b2bfa6561bf8e564570f7c99becf2540';
const MORE_RICH_MENU_ID = process.env.RICH_MENU_MORE_ID || 'richmenu-a02a99359e74ad97a7a8336335e7a916';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined
    })
  : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';
const KNOWLEDGE_PATH = path.resolve(__dirname, 'knowledge', 'entries.json');
const USER_LOG_PATH = path.resolve(__dirname, 'logs', 'user_ids.log');
const DEBUG_USER_LOG_TOKEN = process.env.DEBUG_USER_LOG_TOKEN || '';
let knowledgeCache = { entries: [], mtimeMs: 0 };

const BRAVE_CREDENTIALS_PATH = path.resolve(__dirname, 'config', 'brave_credentials.json');
let BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';
const CURRENT_COMMIT = process.env.RENDER_GIT_COMMIT || '';
if (!BRAVE_API_KEY && fs.existsSync(BRAVE_CREDENTIALS_PATH)) {
  try {
    const braveRaw = fs.readFileSync(BRAVE_CREDENTIALS_PATH, 'utf-8');
    const braveJson = JSON.parse(braveRaw);
    BRAVE_API_KEY = braveJson.api_key || '';
  } catch (error) {
    console.error('無法載入 Brave API 金鑰：', error);
  }
}

memoryStore.initMemoryStore();


app.get('/', (req, res) => {
  res.send('LINE Smart Bot is running');
});

app.get('/status', (req, res) => {
  res.json({
    service: 'line-smart-bot',
    geminiReady: Boolean(genAI),
    model: GEMINI_MODEL,
    commit: CURRENT_COMMIT ? CURRENT_COMMIT.slice(0, 7) : 'local'
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
  if (event.type === 'postback') {
    const response = await handlePostbackEvent(event);
    if (!response) {
      return Promise.resolve(null);
    }
    return client.replyMessage(event.replyToken, response);
  }
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = (event.message.text || '').trim();

  // 先攔截版本按鈕，直接回傳 Flex（不要走 AI）
  if (userText === '保戶溫暖版') {
    return client.replyMessage(event.replyToken, buildWarmFlexCarousel());
  }
  if (userText === '專業理財版') {
    return client.replyMessage(event.replyToken, buildProFlexCarousel());
  }

  if (userText === '市場監測摘要') {
    const summary = await buildMarketMonitorMessage();
    return client.replyMessage(event.replyToken, buildResponseMessage(summary));
  }
  maybeStoreMemory(event, userText);
  const structured = await handleStructuredIntent(userText, event.source);
  if (structured) {
    if (structured.delegateAI) {
      await showTypingIndicator(event.source);
      const promptText = structured.prompt || userText;
      const aiReply = await getAssistantReply(event, promptText);
      return client.replyMessage(event.replyToken, buildResponseMessage(aiReply));
    }
    return client.replyMessage(event.replyToken, structured);
  }

  await showTypingIndicator(event.source);
  const replyText = await getAssistantReply(event, userText);
  return client.replyMessage(event.replyToken, buildResponseMessage(replyText));
}

async function handlePostbackEvent(event) {
  const data = event.postback?.data || '';
  if (data === 'action=schedule-date') {
    const date = event.postback?.params?.date || '';
    return buildScheduleDateResponse(date);
  }
  if (data === 'action=show-more') {
    await switchRichMenuForUser(event.source, MORE_RICH_MENU_ID);
    return buildResponseMessage('已切換至更多功能選單');
  }
  if (data === 'action=show-main') {
    await switchRichMenuForUser(event.source, MAIN_RICH_MENU_ID);
    return buildResponseMessage('已返回主選單');
  }
  return null;
}

async function switchRichMenuForUser(source, richMenuId) {
  try {
    const userId = source?.userId;
    if (!userId || !richMenuId) {
      return;
    }
    await client.linkRichMenuToUser(userId, richMenuId);
  } catch (error) {
    console.error('無法切換 Rich Menu：', error);
  }
}

async function getAssistantReply(event, rawText) {
  const prompt = buildPrompt(rawText, event);

  if (openaiClient) {
    try {
      const response = await openaiClient.responses.create({
        model: OPENAI_MODEL,
        input: prompt,
        temperature: 0.6
      });
      const textResponse = response?.output_text?.trim();
      if (textResponse) {
        return textResponse;
      }
    } catch (error) {
      console.error('OpenAI 回應失敗：', error);
    }
  }

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: personaInstruction,
      });

      const result = await model.generateContent(prompt);
      const textResponse = result?.response?.text()?.trim();

      if (textResponse) {
        return textResponse;
      }
    } catch (error) {
      console.error('Gemini 回應失敗：', error);
    }
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
    { label: '保戶溫暖版', text: '保戶溫暖版' },
    { label: '專業理財版', text: '專業理財版' },
    { label: '焦點新聞', text: '焦點新聞' },
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

async function fetchDisplayName(source) {
  try {
    const userId = source?.userId;
    if (!userId) {
      return null;
    }
    const profile = await client.getProfile(userId);
    return profile?.displayName || null;
  } catch (error) {
    console.error('取得使用者名稱失敗：', error);
    return null;
  }
}

async function handleStructuredIntent(text, source) {
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

  const searchResponse = await handleSearchIntent(text);
  if (searchResponse) {
    return searchResponse;
  }

  const normalized = text.toLowerCase();
  const claimSlotSelection = parseClaimSlotSelection(text);
  if (claimSlotSelection) {
    return await buildClaimConfirmationResponse(claimSlotSelection, source);
  }
  const claimDateSelection = parseClaimDateSelection(text);
  if (claimDateSelection) {
    return buildClaimTimePrompt(claimDateSelection);
  }
  if (isClaimIntent(normalized, text)) {
    return await buildClaimSchedulingPrompt(source);
  }

  const opportunitySlotSelection = parseOpportunitySlotSelection(text);
  if (opportunitySlotSelection) {
    return await buildOpportunityConfirmationResponse(opportunitySlotSelection, source);
  }
  const opportunityDateSelection = parseOpportunityDateSelection(text);
  if (opportunityDateSelection) {
    return buildOpportunityTimePrompt(opportunityDateSelection);
  }
  if (isOpportunityIntent(normalized, text)) {
    return await buildOpportunitySchedulingPrompt(source);
  }

  if (isFundStatusIntent(text, text)) {
    return await buildFundStatusAck(source);
  }

  if (isCasualChatIntent(text)) {
    return await buildCasualChatDelegate(source);
  }

  if (isCardChangeIntent(normalized)) {
    return await buildCardChangeResponse(source);
  }

  if (isInsuranceQuestionIntent(normalized, text)) {
    return await buildInsuranceQuestionResponse(source);
  }

  if (isWeatherIntent(normalized)) {
    const cityKey = detectCityFromText(text);
    const weather = await buildWeatherSummary(cityKey);
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

function detectCityFromText(text) {
  if (!text) return 'taipei';
  if (text.includes('高雄')) return 'kaohsiung';
  if (text.includes('台中') || text.includes('臺中')) return 'taichung';
  if (text.includes('台南') || text.includes('臺南')) return 'tainan';
  if (text.includes('桃園')) return 'taoyuan';
  if (text.includes('台北') || text.includes('臺北')) return 'taipei';
  return 'taipei';
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
  if (!text) return false;
  const trimmed = text.replace(/\s+/g, '');
  if (trimmed.includes('安排時間') || trimmed.includes('安排會面')) {
    return false;
  }
  return ['安排', '行程', '放空', '無聊', '休息', '充電', '提振'].some((kw) => text.includes(kw));
}

function isCardChangeIntent(text) {
  if (!text) return false;
  const trimmed = text.replace(/\s+/g, '');
  return trimmed.includes('變更信用卡') || trimmed.includes('換信用卡');
}

function isInsuranceQuestionIntent(text, original) {
  if (!text) return false;
  const trimmed = text.replace(/\s+/g, '');
  return trimmed.includes('保險問題') || (original && original.includes('健平！我想詢問一下我的保險問題'));
}

function isClaimIntent(text, original) {
  if (!text) return false;
  const trimmed = text.replace(/\s+/g, '');
  return trimmed.includes('申請理賠') || (original && original.includes('我申請理賠'));
}

function parseClaimDateSelection(text) {
  if (!text) return null;
  const match = text.match(/^理賠日期::(.+)$/);
  return match ? match[1] : null;
}

function parseClaimSlotSelection(text) {
  if (!text) return null;
  const match = text.match(/^理賠時段::(.+?)::(.+)$/);
  if (!match) {
    return null;
  }
  return { dateLabel: match[1], slotLabel: match[2] };
}

function isOpportunityIntent(text, original) {
  if (!text) return false;
  const trimmed = text.replace(/\s+/g, '');
  return trimmed.includes('了解事業機會') || (original && original.includes('我想了解業務工作'));
}

function parseOpportunityDateSelection(text) {
  if (!text) return null;
  const match = text.match(/^面談日期::(.+)$/);
  return match ? match[1] : null;
}

function parseOpportunitySlotSelection(text) {
  if (!text) return null;
  const match = text.match(/^面談時段::(.+?)::(.+)$/);
  if (!match) {
    return null;
  }
  return { dateLabel: match[1], slotLabel: match[2] };
}

function isFundStatusIntent(text, original) {
  if (!text) return false;
  return text.includes('基金現在狀況') || (original && original.includes('基金現在狀況'));
}

function isCasualChatIntent(original) {
  if (!original) return false;
  const trimmed = original.replace(/\s+/g, '');
  return trimmed.includes('想找健平聊天') || trimmed.includes('想聊聊');
}

const CITY_COORDS = {
  taipei: { lat: 25.05, lon: 121.53, label: '台北' },
  kaohsiung: { lat: 22.63, lon: 120.3, label: '高雄' },
  taichung: { lat: 24.15, lon: 120.68, label: '台中' },
  tainan: { lat: 23.0, lon: 120.21, label: '台南' },
  taoyuan: { lat: 24.99, lon: 121.3, label: '桃園' }
};

async function buildWeatherSummary(cityKey = 'taipei') {
  const city = CITY_COORDS[cityKey] || CITY_COORDS.taipei;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`;
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
    return `${city.label}現在 ${temp}°C，體感 ${feelsLike}°C，${description}，濕度 ${humidity}% 、風速 ${wind} m/s，出門記得顧好自己。`;
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
      { type: 'action', action: { type: 'message', label: '焦點新聞', text: '焦點新聞' } }
    ]
  };
}

const INSURER_OPTIONS = ['全球', '富邦', '宏泰', '新光', '元大', '保誠', '凱基', '安達', '遠雄', '台灣人壽', '友邦'];
const CLAIM_DATE_OPTIONS = ['今天', '明天', '後天', '這週末', '下週'];
const CLAIM_TIME_SLOTS = [
  { label: '上午', value: '上午 09:00-12:00' },
  { label: '下午', value: '下午 13:00-17:00' },
  { label: '晚上', value: '晚上 19:00-21:00' },
  { label: '自訂', value: '自訂時間' }
];

async function buildCardChangeResponse(source) {
  const displayName = await fetchDisplayName(source);
  const greeting = displayName ? `哈囉 ${displayName}` : '哈囉';
  return {
    type: 'text',
    text: `${greeting}！你要變更哪一間呢？`,
    quickReply: {
      items: INSURER_OPTIONS.map((company) => ({
        type: 'action',
        action: {
          type: 'message',
          label: company,
          text: `我要變更${company}信用卡`
        }
      }))
    }
  };
}

async function buildInsuranceQuestionResponse(source) {
  const displayName = await fetchDisplayName(source);
  const prefix = displayName ? `${displayName} ` : '';
  return {
    type: 'text',
    text: `${prefix}你想知道哪一間的呢？`,
    quickReply: {
      items: INSURER_OPTIONS.map((company) => ({
        type: 'action',
        action: {
          type: 'message',
          label: company,
          text: `我想詢問${company}的保險`
        }
      }))
    }
  };
}

async function buildClaimSchedulingPrompt(source) {
  const displayName = await fetchDisplayName(source);
  const prefix = displayName ? `${displayName} ` : '';
  return {
    type: 'text',
    text: `${prefix}好喔！我們約個時間！`,
    quickReply: { items: buildClaimDateQuickReplies() }
  };
}

function buildClaimDateQuickReplies() {
  return CLAIM_DATE_OPTIONS.map((label) => ({
    type: 'action',
    action: {
      type: 'message',
      label,
      text: `理賠日期::${label}`
    }
  }));
}

function buildClaimTimePrompt(dateLabel) {
  return {
    type: 'text',
    text: `${dateLabel} 哪個時段方便？`,
    quickReply: {
      items: CLAIM_TIME_SLOTS.map((slot) => ({
        type: 'action',
        action: {
          type: 'message',
          label: slot.label,
          text: `理賠時段::${dateLabel}::${slot.value}`
        }
      }))
    }
  };
}

async function buildClaimConfirmationResponse(selection, source) {
  const displayName = await fetchDisplayName(source);
  const name = displayName || '朋友';
  if (selection.slotLabel === '自訂時間') {
    return {
      type: 'text',
      text: `${name}，${selection.dateLabel} 想約幾點？直接輸入時間或打給我，我幫你安排。`
    };
  }
  return {
    type: 'text',
    text: `${name}，暫定 ${selection.dateLabel} ${selection.slotLabel}，我再幫你確認，若要調整再告訴我。`
  };
}

async function buildOpportunitySchedulingPrompt(source) {
  const displayName = await fetchDisplayName(source);
  const prefix = displayName ? `${displayName} ` : '';
  return {
    type: 'text',
    text: `${prefix}好喔！我們約個時間！`,
    quickReply: { items: buildOpportunityDateQuickReplies() }
  };
}

function buildOpportunityDateQuickReplies() {
  return CLAIM_DATE_OPTIONS.map((label) => ({
    type: 'action',
    action: {
      type: 'message',
      label,
      text: `面談日期::${label}`
    }
  }));
}

function buildOpportunityTimePrompt(dateLabel) {
  return {
    type: 'text',
    text: `${dateLabel} 想約什麼時段？`,
    quickReply: {
      items: CLAIM_TIME_SLOTS.map((slot) => ({
        type: 'action',
        action: {
          type: 'message',
          label: slot.label,
          text: `面談時段::${dateLabel}::${slot.value}`
        }
      }))
    }
  };
}

async function buildOpportunityConfirmationResponse(selection, source) {
  const displayName = await fetchDisplayName(source);
  const name = displayName || '朋友';
  if (selection.slotLabel === '自訂時間') {
    return {
      type: 'text',
      text: `${name}，${selection.dateLabel} 想在哪個時間聊聊？直接輸入時間或打給我。`
    };
  }
  return {
    type: 'text',
    text: `${name}，暫定 ${selection.dateLabel} ${selection.slotLabel}，到時候我再跟你分享事業機會！`
  };
}

async function buildFundStatusAck(source) {
  const displayName = await fetchDisplayName(source);
  const prefix = displayName ? `${displayName} ` : '';
  return {
    type: 'text',
    text: `${prefix}好喔！稍等一下！本人看到訊息後會親自再跟您聯絡！麻煩你稍等嘿～`
  };
}

async function buildCasualChatDelegate(source) {
  const displayName = await fetchDisplayName(source);
  const name = displayName || '朋友';
  return {
    delegateAI: true,
    prompt: `${name} 想跟你聊聊天，請用溫暖、口語的中文、像朋友一樣開啟閒聊，先問候近況再接話。`
  };
}

async function handleSearchIntent(text) {
  if (!isSearchIntent(text)) {
    return null;
  }
  const currencyPair = detectCurrencyPair(text);
  if (currencyPair) {
    const fxMessage = await buildFxResponse(currencyPair);
    if (fxMessage) {
      return fxMessage;
    }
  }
  if (!BRAVE_API_KEY) {
    return { type: 'text', text: '搜尋服務還沒啟用，再給我一點時間設定。' };
  }
  const query = extractSearchQuery(text);
  if (!query) {
    return { type: 'text', text: '想搜尋什麼主題？可以試著說「找新聞＋關鍵字」。' };
  }
  try {
    const metricMode = needsRealtimeQuery(text);
    const resultCount = metricMode ? 2 : 3;
    const results = await searchWeb(query, resultCount);
    if (!results.length) {
      return { type: 'text', text: `我找不到「${query}」的即時資訊，要不要換個關鍵字？` };
    }
    return buildWebSearchMessage(query, results, { omitLinks: metricMode });
  } catch (error) {
    console.error('Brave 搜尋失敗：', error);
    return { type: 'text', text: '目前搜尋服務暫時無法使用，稍後再試看看。' };
  }
}

function isSearchIntent(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (['焦點新聞', '今日焦點新聞'].includes(trimmed)) {
    return true;
  }
  if (text.includes('新聞') && (text.includes('找') || text.includes('搜') || text.includes('查'))) {
    return true;
  }
  return needsRealtimeQuery(text);
}

function needsRealtimeQuery(text) {
  if (!text) return false;
  const realtimeKeywords = ['股市', '台股', '臺股', '美股', '指數', '匯率', '油價', '黃金', '利率', '匯價'];
  const urgencyKeywords = ['現在', '最新', '今日', '今天', '即時', '多少'];
  const hasRealtime = realtimeKeywords.some((kw) => text.includes(kw));
  const hasUrgency = urgencyKeywords.some((kw) => text.includes(kw));
  return hasRealtime && hasUrgency;
}

function extractSearchQuery(text) {
  if (!text) return '';
  const trimmed = text.trim();
  if (['焦點新聞', '今日焦點新聞'].includes(trimmed)) {
    return pickFocusNewsQuery();
  }
  if (needsRealtimeQuery(trimmed)) {
    return trimmed.replace(/[？?]/g, '').trim();
  }
  const pattern = /(?:找|搜|查)(?:一下|一下子|看看|一下呢|一下嗎)?(.+?)(?:新聞|報導|消息|資訊)/;
  const match = text.match(pattern);
  if (match && match[1]) {
    return match[1].replace(/的$/,'').trim();
  }
  return text.replace(/(找|搜|查|新聞|一下|一下子)/g, '').trim();
}

function pickFocusNewsQuery() {
  const seeds = [
    '金融 焦點 新聞',
    '保險 時事 快訊',
    '財經 熱門 議題',
    '投資 市場 焦點'
  ];
  const index = Math.floor(Math.random() * seeds.length);
  return seeds[index];
}

const CURRENCY_KEYWORDS = {
  '美元': 'USD',
  '美金': 'USD',
  '台幣': 'TWD',
  '臺幣': 'TWD',
  '新台幣': 'TWD',
  '日圓': 'JPY',
  '日幣': 'JPY',
  '人民幣': 'CNY',
  '人民元': 'CNY',
  '歐元': 'EUR'
};

async function buildFxResponse(pair) {
  try {
    const res = await fetch('https://tw.rter.info/capi.php');
    if (!res.ok) throw new Error('fx fetch failed');
    const data = await res.json();
    const forwardKey = `${pair.base}${pair.quote}`;
    const reverseKey = `${pair.quote}${pair.base}`;
    let rateObj = data[forwardKey];
    let rate = rateObj?.Exrate;
    if (!rate && data[reverseKey]?.Exrate) {
      rateObj = data[reverseKey];
      rate = 1 / data[reverseKey].Exrate;
    }
    if (!rate) {
      return { type: 'text', text: '我暫時找不到這組匯率，等一下再試。' };
    }
    const formattedRate = rate.toFixed(3);
    const timestamp = rateObj?.UTC ? formatFxTimestamp(rateObj.UTC) : '';
    const baseLabel = currencyCodeToLabel(pair.base);
    const quoteLabel = currencyCodeToLabel(pair.quote);
    const timeText = timestamp ? `（${timestamp}）` : '';
    return {
      type: 'text',
      text: `【${baseLabel}/${quoteLabel}】1 ${baseLabel} ≈ ${formattedRate} ${quoteLabel}${timeText}
資料來源：台灣銀行即時匯率`
    };
  } catch (error) {
    console.error('取得匯率失敗：', error);
    return { type: 'text', text: '即時匯率現在抓不到，我再幫你留意。' };
  }
}

function detectCurrencyPair(text) {
  if (!text) return null;
  if (!(text.includes('匯率') || text.includes('換') || text.includes('/'))) {
    return null;
  }
  const matches = [];
  Object.entries(CURRENCY_KEYWORDS).forEach(([keyword, code]) => {
    const idx = text.indexOf(keyword);
    if (idx !== -1) {
      matches.push({ idx, code });
    }
  });
  if (!matches.length) return null;
  matches.sort((a, b) => a.idx - b.idx);
  const base = matches[0].code;
  const quote = matches[1]?.code || defaultQuoteCurrency(base);
  if (!quote || base === quote) {
    return null;
  }
  return { base, quote };
}

function defaultQuoteCurrency(base) {
  if (base === 'TWD') return 'USD';
  return 'TWD';
}

function currencyCodeToLabel(code) {
  const mapping = {
    USD: '美元',
    TWD: '新台幣',
    JPY: '日圓',
    CNY: '人民幣',
    EUR: '歐元'
  };
  return mapping[code] || code;
}

function formatFxTimestamp(utcString) {
  if (!utcString) return '';
  const date = new Date(`${utcString} UTC`);
  if (Number.isNaN(date.getTime())) return utcString;
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes} UTC`;
}

async function searchWeb(query, limit = 3) {
  const params = new URLSearchParams({ q: query, count: String(limit) });
  const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': BRAVE_API_KEY
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brave search error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const results = data?.web?.results || [];
  return results.map((item) => ({
    title: item.title,
    url: item.url,
    description: item.description || '',
    source: item.profile?.name || extractHostname(item.url)
  }));
}

function extractHostname(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch (error) {
    return url;
  }
}

function buildWebSearchMessage(query, entries, options = {}) {
  const { omitLinks = false } = options;
  const keyword = query || '金融焦點';
  const lines = [`【焦點搜尋｜${keyword}】`];
  const limit = omitLinks ? Math.min(entries.length, 2) : Math.min(entries.length, 1);
  entries.slice(0, limit).forEach((item, index) => {
    const source = item.source || '新聞';
    const title = (item.title || '最新快訊').trim();
    const cleanDescription = (item.description || '').replace(/\s+/g, '');
    const summary = cleanDescription.slice(0, 28);
    const needsEllipsis = cleanDescription.length > summary.length;
    lines.push(`${index + 1}. 【${source}】${title}`);
    if (summary) {
      lines.push(`   - ${summary}${needsEllipsis ? '…' : ''}`);
    }
    if (!omitLinks) {
      lines.push(`   ${item.url}`);
    }
  });
  lines.push(omitLinks ? '資料來源：Brave Search 整理' : '資料來源：Brave Search（即時）');
  return { type: 'text', text: lines.join('\n') };
}

function buildScheduleQuickReply(text) {
  if (!text) {
    return null;
  }
  if (/^預約時段[:：]/.test(text) || /^預約時間[:：]/.test(text)) {
    return null;
  }
  const normalized = text.replace(/\s+/g, '');
  const scheduleKeywords = ['約時間', '預約', '安排時間', '安排會面', '排時間', '排個時間'];
  const shouldTrigger = scheduleKeywords.some((kw) => normalized.includes(kw));
  if (!shouldTrigger) {
    return null;
  }
  const today = new Date();
  const maxDate = new Date(today);
  maxDate.setMonth(maxDate.getMonth() + 2);
  const datePickerItem = {
    type: 'action',
    action: {
      type: 'datetimepicker',
      label: '選日期',
      data: 'action=schedule-date',
      mode: 'date',
      initial: formatDateForPicker(today),
      min: formatDateForPicker(today),
      max: formatDateForPicker(maxDate)
    }
  };
  return {
    type: 'text',
    text: '先選一個想約的日期，我再提供時段選項。',
    quickReply: { items: [datePickerItem] }
  };
}

function buildTimeSlotQuickReply() {
  const slots = ['上午', '中午', '下午', '晚上'];
  return {
    items: slots.map((label) => ({
      type: 'action',
      action: {
        type: 'message',
        label,
        text: `預約時段:${label}`
      }
    }))
  };
}

function buildScheduleDateResponse(dateString) {
  const formatted = formatDisplayDate(dateString);
  return {
    type: 'text',
    text: `收到！你想約 ${formatted}，請選擇時段：`,
    quickReply: buildTimeSlotQuickReply()
  };
}

function formatDateForPicker(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(dateString) {
  if (!dateString) {
    return '該日期';
  }
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  }).format(date);
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
    ? ['最新基金快照', `（更新：${timestampLabel}）`, '---------']
    : ['最新基金快照', '---------'];
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
- 語氣：像南部鄰居聊天，暖暖的、直接一點，必要時穿插台語口吻（例如「好喔」「這樣較讚」），不要太客套。
- 內容：只有在使用者主動提到基金/投資時才聊那段，其他時候就陪伴他當下的心情。
- 互動：資訊不足時先確認情境或下一步，讓對方覺得被理解，也可以主動幫他想到下一步。
- 篇幅：最多 2 段、每段 1 句且不超過 40 字，避免長篇說教。
- 自然感：引用使用者用詞，可加入貼圖感語句或 emoji，稱呼用「你」，語氣像朋友。
- 限制：使用繁體中文，不保證報酬、不觸犯金管會規範，沒有資料時坦白說明並給替代方案。`

const fewShotExamples = `客戶：我最近壓力很大，基金都在跌。
小平：先抱一下啦，把錢分成「必要 / 可調整」，盯住美元和美股的節奏就不會那麼慌。

客戶：團隊裡有個射手座業務，很有想法但不愛回報。
小平：給他清楚的目標＋截止日，語氣軟一點，他就知道你是在幫他，不是在盯。

客戶：高雄今天到底會不會下雨？
小平：我查一下天氣，現在高雄 28°C、體感 30°C，微微東北風，出門帶頂帽子比較保險。

客戶：今天台股行情怎樣？
小平：我幫你搜一下最新時事，等一下快速整理三則焦點給你。`;

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


function buildWarmFlexCarousel() {
  return {
    type: 'flex',
    altText: '保戶溫暖版',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          hero: {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1493238792000-8113da705763?auto=format&fit=crop&w=1200&q=80',
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '🌤 先照顧好你的節奏', weight: 'bold', size: 'lg' },
              { type: 'text', text: '市場有起伏很正常，先穩住步調，比急著追高更重要。', wrap: true, size: 'sm', color: '#555555' }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'button', style: 'primary', action: { type: 'message', label: '我想看簡單建議', text: '請給我本週簡單理財建議' } }
            ]
          }
        },
        {
          type: 'bubble',
          hero: {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=1200&q=80',
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '💛 用小步慢慢累積', weight: 'bold', size: 'lg' },
              { type: 'text', text: '定期定額＋風險分散，讓資產慢慢長大，睡得更安心。', wrap: true, size: 'sm', color: '#555555' }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'button', style: 'secondary', action: { type: 'message', label: '幫我看目前配置', text: '幫我看目前配置是否需要調整' } }
            ]
          }
        },
        {
          type: 'bubble',
          hero: {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=1200&q=80',
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '🤝 有我陪你一起看', weight: 'bold', size: 'lg' },
              { type: 'text', text: '回覆「預約」，我幫你做一份專屬檢視，不急不壓力。', wrap: true, size: 'sm', color: '#555555' }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'button', style: 'primary', action: { type: 'message', label: '我要預約', text: '我要預約一對一金融健檢' } }
            ]
          }
        }
      ]
    }
  };
}

function buildProFlexCarousel() {
  return {
    type: 'flex',
    altText: '專業理財版',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          hero: {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=1200&q=80',
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '📊 市場監測摘要', weight: 'bold', size: 'lg' },
              { type: 'text', text: '短期波動擴大，建議先檢視股債比與現金水位。', wrap: true, size: 'sm', color: '#555555' }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',


            contents: [

{ type: 'button', style: 'primary', action: { type: 'message', label: '市場監測摘要', text: '市場監測摘要' } }
            ]
          }
        },
        {
          type: 'bubble',
          hero: {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?auto=format&fit=crop&w=1200&q=80',
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '🧭 策略建議', weight: 'bold', size: 'lg' },
              { type: 'text', text: '以分批布局與風險平衡為主，先做配置優化，再談加碼時點。', wrap: true, size: 'sm', color: '#555555' }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'button', style: 'secondary', action: { type: 'message', label: '取得配置建議', text: '請提供我的配置調整建議' } }
            ]
          }
        },
        {
          type: 'bubble',
          hero: {
            type: 'image',
            url: 'https://images.unsplash.com/photo-1554224154-26032fced8bd?auto=format&fit=crop&w=1200&q=80',
            size: 'full',
            aspectRatio: '20:13',
            aspectMode: 'cover'
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: '✅ 一對一檢視', weight: 'bold', size: 'lg' },
              { type: 'text', text: '回覆「檢視」，安排專屬理財健檢與執行清單。', wrap: true, size: 'sm', color: '#555555' }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'button', style: 'primary', action: { type: 'message', label: '立即檢視', text: '我要做專屬理財檢視' } }
            ]
          }
        }
      ]
    }
  };
}


const MARKET_SOURCE_URL = 'https://www.moneydj.com/kmdj/common/listnewarticles.aspx?svc=NW&a=X0400000';
const MARKET_KEYWORDS = ['總體經濟','國際股市','外匯','債券','國內外財經','台股','產業','商品原物料','報告','基金','期權'];

function toTaipeiTimeString(date = new Date()) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function stripHtml(s = '') {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function dedupeByTitle(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = (it.title || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function fetchMarketArticles(limit = 25) {
  const res = await fetch(MARKET_SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (line-bot market monitor)' }
  });
  if (!res.ok) throw new Error(`抓取失敗: ${res.status}`);
  const html = await res.text();

  const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const rows = [];
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1] || '';
    const title = stripHtml(m[2] || '');
    if (!title || title.length < 6) continue;
    if (!/moneydj|kmdj|\/x\//i.test(href) && !/\.aspx/i.test(href)) continue;

    const fullUrl = href.startsWith('http')
      ? href
      : `https://www.moneydj.com${href.startsWith('/') ? '' : '/'}${href}`;
    rows.push({ title, url: fullUrl });
  }
  return dedupeByTitle(rows).slice(0, limit);
}

function filterByKeywords(items, keywords = MARKET_KEYWORDS, pick = 5) {
  return items.filter(it => keywords.some(k => it.title.includes(k))).slice(0, pick);
}

function buildMarketSummaryText(filtered) {
  const ts = toTaipeiTimeString();
  const top = filtered.slice(0, 3);
  const impact = top.map((x, i) => `- ${i + 1}. ${x.title}`).join('\n') || '- 今日無明確關鍵分類新聞';
  const refs = filtered.slice(0, 3).map((x, i) => `${i + 1}) ${x.title}\n${x.url}`).join('\n\n');

  return [
    `📊 市場監測摘要（${ts}）`,
    '',
    '1) 今日盤勢：',
    top.length ? '市場訊號偏觀望，建議先控管部位與風險。' : '今日資料偏少，建議保守觀察。',
    '',
    '2) 關鍵影響：',
    impact,
    '',
    '3) 建議動作：',
    '- 先檢視股債配置與現金水位',
    '- 分批布局，不追高',
    '',
    '📎 來源（MoneyDJ）：',
    refs || MARKET_SOURCE_URL,
    '',
    '⚠️ 本內容為資訊整理，非投資建議。'
  ].join('\n');
}

async function buildMarketMonitorMessage() {
  try {
    const raw = await fetchMarketArticles(25);
    const filtered = filterByKeywords(raw, MARKET_KEYWORDS, 5);
    return buildMarketSummaryText(filtered.length ? filtered : raw.slice(0, 5));
  } catch (err) {
    console.error('市場監測抓取失敗:', err);
    return `📊 市場監測摘要\n目前來源抓取失敗，請稍後再試。\n來源：${MARKET_SOURCE_URL}`;
  }
}
