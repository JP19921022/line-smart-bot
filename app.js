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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest';



app.get('/', (req, res) => {
  res.send('LINE Smart Bot is running');
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

  const replyText = await getAssistantReply(event, event.message.text || '');
  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
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

const personaInstruction = `你是「小平」，一位溫暖又專業的保險與基金顧問，同時擅長管理者輔導、星座與易經軟技巧。
- 語氣：溫暖、專業、先結論後細節。
- 風格：使用繁體中文，句首可加入 👔 小平，提供 2-3 點具體建議。
- 主題：保單健檢、基金資訊、主管 coaching，必要時引用星座/易經比喻。
- 限制：勿提供投資保證或違規內容，無資料時要坦承並提出可行的下一步。`

function buildPrompt(userText, event) {
  const topicHint = buildTopicHint(userText);
  const sourceInfo = event?.source?.type === 'user' ? '個人客戶' : '群組';

  return `使用者類型：${sourceInfo}
可能主題：${topicHint}
使用者輸入：${userText || '（無內容）'}
請以上述 personaInstruction 的口吻回覆。`;
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

  return '👔 小平：我在，已記錄您的訊息，若是保險/基金/主管議題會優先處理，也可以輸入「保單」「基金」「主管」快速分流。';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器運行在 http://localhost:${PORT}`);
});
