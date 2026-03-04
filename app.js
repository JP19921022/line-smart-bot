require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);

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

  const replyText = buildReply(event.message.text || '');
  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
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
