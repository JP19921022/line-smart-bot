const fs = require('fs');
const path = require('path');
require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const line = require('@line/bot-sdk');
const memoryStore = require('./memoryStore');
const proactivePush = require('./proactivePush');
const crmIntegration = require('./crmIntegration');
const { getLatestFundEntries } = require('./fundFetcher');
const { ensureFile: ensureAbEventStore, markLatestUnrepliedAsReplied } = require('./ab_event_store');
const contactsBuffer = require('./contactsBuffer');
contactsBuffer.schedule();
const approvalQueue = require('./approvalQueue');
const policyBinding = require('./policyBinding');
const supabasePolicies = require('./supabasePolicies');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = (config.channelAccessToken && config.channelSecret)
  ? new line.Client(config)
  : null;
if (!client) {
  console.warn('[BOOT] LINE client disabled: missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET');
}
const MAIN_RICH_MENU_ID = process.env.RICH_MENU_MAIN_ID || 'richmenu-8dfa2dccdecfe4f113e7c69b2c8dab0e';
const MORE_RICH_MENU_ID = process.env.RICH_MENU_MORE_ID || 'richmenu-46dab9e7e61f792f505d857ab01b02d8';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.5-flash';
const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
// 模型分層：
//   複雜訊息（情緒 / 長文 / 推理） → Sonnet 4.6（深度＋情緒價值）
//   簡單訊息（短句 / 問候 / 一般詢問） → Haiku 4.5（性價比甜蜜點，比 Gemini Flash 更有人味）
//   Vision / PDF（圖片解讀）         → Gemini Flash（多模態便宜）
const CLAUDE_MODEL       = 'claude-sonnet-4-6';
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5';
const KNOWLEDGE_PATH = path.resolve(__dirname, 'knowledge', 'entries.json');
const USER_LOG_PATH = path.resolve(__dirname, 'logs', 'user_ids.log');
const GLOBAL_MANUAL_FILE = path.resolve(__dirname, 'status', 'global_manual.json');
const DEBUG_USER_LOG_TOKEN = process.env.DEBUG_USER_LOG_TOKEN || '';
const AB_REPLY_WINDOW_HOURS = Math.max(1, Number(process.env.AB_REPLY_WINDOW_HOURS || 72));
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
ensureAbEventStore();

// ── 對話上下文由 memoryStore（Supabase）統一管理 ─────────────

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

if (config.channelSecret) {
  app.post('/webhook', line.middleware(config), async (req, res) => {
    if (!client) return res.status(503).send('LINE client not configured');
    try {
      await Promise.all(req.body.events.map(handleEvent));
      res.sendStatus(200);
    } catch (err) {
      console.error('處理事件時出錯：', err);
      res.sendStatus(500);
    }
  });
} else {
  app.post('/webhook', (req, res) => res.status(503).send('LINE webhook not configured'));
}

// ── 將 ReadableStream 轉為 Buffer ──
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ── 圖片訊息處理（Gemini Vision + Claude Vision fallback）──
async function handleImageMessage(event) {
  const userId = event?.source?.userId;
  const displayName = await fetchDisplayName(event?.source);
  await showTypingIndicator(event.source);
  try {
    const stream = await client.getMessageContent(event.message.id);
    const imgBuf = await streamToBuffer(stream);
    const base64Image = imgBuf.toString('base64');
    const mimeType = 'image/jpeg';

    let reply = null;
    const imagePrompt = '請用繁體中文描述這張圖片。如果是保險文件、保單條款或財務相關內容，請特別幫我整理重點條款、保障項目與注意事項，用白話解讀給客戶聽。';

    // 優先用 Gemini Vision（支援圖片）
    if (genAI) {
      try {
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: personaInstruction });
        const result = await model.generateContent([
          { inlineData: { data: base64Image, mimeType } },
          imagePrompt,
        ]);
        reply = result?.response?.text()?.trim() || null;
      } catch (e) { console.error('[圖片] Gemini 失敗:', e.message); }
    }
    // Fallback：Claude Vision
    if (!reply && anthropicClient) {
      try {
        const response = await anthropicClient.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 2048,
          system: personaInstruction,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
            { type: 'text', text: imagePrompt },
          ]}],
        });
        reply = response?.content?.[0]?.text?.trim() || null;
      } catch (e) { console.error('[圖片] Claude 失敗:', e.message); }
    }
    if (reply) {
      await memoryStore.saveSessionMessage(userId, 'user', '[傳送了一張圖片]');
      await memoryStore.saveSessionMessage(userId, 'assistant', reply);
      crmIntegration.trackAndMaybeSummarize(userId, displayName, anthropicClient, memoryStore).catch(console.error);
      return client.replyMessage(event.replyToken, buildResponseMessage(reply));
    }
  } catch (e) {
    console.error('[圖片處理] 下載失敗:', e.message);
  }
  return client.replyMessage(event.replyToken, buildResponseMessage(
    '收到你的圖片了！不過我現在解讀圖片遇到一點問題，可以用文字告訴我你想了解什麼嗎？😊'
  ));
}

// ── 檔案訊息處理（PDF 優先用 Gemini PDF 原生支援）──
async function handleFileMessage(event) {
  const userId = event?.source?.userId;
  const displayName = await fetchDisplayName(event?.source);
  const fileName = event.message.fileName || '未知檔案';
  const fileSize = event.message.fileSize || 0;
  await showTypingIndicator(event.source);

  const isPDF = fileName.toLowerCase().endsWith('.pdf');
  if (isPDF) {
    try {
      const stream = await client.getMessageContent(event.message.id);
      const fileBuf = await streamToBuffer(stream);
      const base64PDF = fileBuf.toString('base64');
      const pdfPrompt = `用戶傳來了一份保險相關 PDF（${fileName}）。請用繁體中文幫我解讀：1) 這份文件的主要內容 2) 重要保障項目 3) 注意事項或限制條款 4) 用白話整理給客戶。`;

      let reply = null;
      // Gemini 原生支援 PDF inline（< 20MB）
      if (genAI && fileSize < 20 * 1024 * 1024) {
        try {
          const model = genAI.getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: personaInstruction });
          const result = await model.generateContent([
            { inlineData: { data: base64PDF, mimeType: 'application/pdf' } },
            pdfPrompt,
          ]);
          reply = result?.response?.text()?.trim() || null;
        } catch (e) { console.error('[PDF] Gemini 失敗:', e.message); }
      }
      // Fallback：嘗試提取純文字後丟給 Claude
      if (!reply && anthropicClient) {
        try {
          const rawText = fileBuf.toString('latin1').replace(/[^\x20-\x7E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
          if (rawText.trim().length > 50) {
            const textPrompt = `用戶傳來了一份 PDF（${fileName}），以下是提取的文字：\n\n${rawText}\n\n請用繁體中文解讀重點。`;
            reply = await _replyWithClaude(textPrompt, [{ role: 'user', content: textPrompt }]);
          }
        } catch (e) { console.error('[PDF] 文字提取失敗:', e.message); }
      }
      if (reply) {
        await memoryStore.saveSessionMessage(userId, 'user', `[傳送了PDF: ${fileName}]`);
        await memoryStore.saveSessionMessage(userId, 'assistant', reply);
        crmIntegration.trackAndMaybeSummarize(userId, displayName, anthropicClient, memoryStore).catch(console.error);
        return client.replyMessage(event.replyToken, buildResponseMessage(reply));
      }
    } catch (e) {
      console.error('[PDF處理] 下載失敗:', e.message);
    }
    return client.replyMessage(event.replyToken, buildResponseMessage(
      `收到你的 PDF《${fileName}》了！你可以把想了解的頁面截圖或拍照傳給我，我來幫你用白話解讀 📄`
    ));
  }

  // 非 PDF 檔案
  return client.replyMessage(event.replyToken, buildResponseMessage(
    `收到你的檔案《${fileName}》了！如果是保單或合約類文件，可以截圖或拍照傳給我，我幫你解讀重點 😊`
  ));
}

async function handleEvent(event) {
  logUserSource(event);
  // 自動補綁：每次收到事件時，若用戶沒有綁定選單（或舊選單已刪），自動綁到最新主選單
  const _autoLinkUserId = event?.source?.userId;
  if (_autoLinkUserId && client && event.type === 'message') {
    client.linkRichMenuToUser(_autoLinkUserId, MAIN_RICH_MENU_ID).catch(() => {});
  }
  if (event.type === 'postback') {
    const response = await handlePostbackEvent(event);
    if (!response) {
      return Promise.resolve(null);
    }
    return client.replyMessage(event.replyToken, response);
  }
  if (event.type !== 'message') {
    return Promise.resolve(null);
  }
  // 圖片訊息
  if (event.message.type === 'image') {
    return handleImageMessage(event);
  }
  // 檔案訊息（PDF 等）
  if (event.message.type === 'file') {
    return handleFileMessage(event);
  }
  // 貼圖 / 其他非文字訊息 → 忽略
  if (event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = (event.message.text || '').trim();
  upsertContactFromEvent(event);
  try {
    markLatestUnrepliedAsReplied(event?.source?.userId, AB_REPLY_WINDOW_HOURS);
  } catch (error) {
    console.error('AB reply mark failed:', error);
  }

  // 手動聊天模式切換（每位用戶獨立）
  if (userText === '使用手動聊天') {
    setManualMode(event?.source?.userId, true);
    return client.replyMessage(event.replyToken, buildResponseMessage('已切換為手動聊天模式：系統暫停自動回覆。'));
  }
  if (userText === '結束手動聊天') {
    setManualMode(event?.source?.userId, false);
    return client.replyMessage(event.replyToken, buildResponseMessage('已結束手動聊天：系統恢復自動回覆。'));
  }

  // 全域緊急停回覆
  if (isGlobalManualMode()) {
    return Promise.resolve(null);
  }

  if (isManualMode(event?.source?.userId)) {
    return Promise.resolve(null);
  }

  // ── 保單查詢 / 綁定流程 ───────────────────────────────────────
  const userId = event?.source?.userId;

  // 觸發關鍵字 → 啟動查詢保單流程
  if (userText === '查詢我的保單' || userText === '我的保單' || userText === '保單查詢' || userText === '查看更多保單') {
    const bindMsg = await policyBinding.startPolicyQuery(userId);
    return client.replyMessage(event.replyToken, bindMsg);
  }

  // ── 解除綁定：第二步確認（必須在 regex 之前，避免被攔截）──────
  if (userText === '確認解除綁定') {
    const profile = await supabasePolicies.getProfileByLineId(userId);
    if (!profile) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '您目前尚未綁定任何帳號。' });
    }
    const ok = await supabasePolicies.unbindLineUser(userId);
    policyBinding.clearStatePublic(userId);
    if (!ok) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 解除綁定失敗，請稍後再試或聯繫業務員。' });
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '✅ 已成功解除綁定！\n\n您的 LINE 帳號已與保單資料解除連結。\n如需重新查詢保單，請輸入「我的保單」重新驗證身份。',
    });
  }

  // ── 解除綁定：第一步觸發（顯示確認卡片）──────────────────────
  if (/取消綁定|解除綁定|解綁|取消帳號/.test(userText)) {
    const unbindResult = await policyBinding.startUnbindFlow(userId);
    return client.replyMessage(event.replyToken, unbindResult);
  }

  // 綁定狀態中的文字輸入（姓名、取消）
  if (policyBinding.getState(userId)) {
    // 允許用戶輸入「取消」退出流程
    if (userText === '取消') {
      const { handleBindingPostback } = require('./policyBinding');
      const cancelMsg = await handleBindingPostback(userId, 'policy_bind:cancel');
      return client.replyMessage(event.replyToken, cancelMsg);
    }
    const bindResult = await policyBinding.handleBindingText(userId, userText);
    if (bindResult) {
      return client.replyMessage(event.replyToken, bindResult);
    }
  }

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

  // Tier-2 #6：敏感詞（理賠 / 退保 / 客訴 / 投訴 …）進審核佇列，
  // 不直接送 AI 草稿，改回一則安全的佔位訊息，管理員到 dashboard 審核後再 push。
  try {
    const displayName = await fetchDisplayName(event?.source).catch(() => '');
    const held = await approvalQueue.maybeHold({
      event,
      userText,
      draftReply: replyText,
      displayName
    });
    if (held && held.held) {
      return client.replyMessage(
        event.replyToken,
        buildResponseMessage('您的訊息我們已收到，會由專員儘快親自回覆您，謝謝。')
      );
    }
  } catch (e) {
    console.error('[approvalQueue] maybeHold failed, fall through to normal reply:', e && e.message);
  }

  return client.replyMessage(event.replyToken, buildResponseMessage(replyText));
}

async function handlePostbackEvent(event) {
  upsertContactFromEvent(event);
  const data = event.postback?.data || '';

  // ── 保單綁定流程 postback（包含翻頁 policy_page:） ──────────
  if (data.startsWith('policy_bind:') || data.startsWith('policy_page:') || data.startsWith('policy_unbind:')) {
    const userId = event?.source?.userId;
    const result = await policyBinding.handleBindingPostback(userId, data);
    if (result) return result;
  }

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

// ── 智能模型路由：根據訊息複雜度自動選擇模型 ──────────────
function classifyMessageComplexity(text) {
  if (!text) return 'simple';
  const t = text.trim();

  // 超短訊息 → 簡單
  if (t.length < 10) return 'simple';

  // 複雜情境關鍵字
  const complexPatterns = [
    /理賠|核保|保單|條款|保費|投保|續保|除外|批註/,
    /稅|節稅|遺產|傳承|贈與|申報|扣除額/,
    /退休|年金|長照|失能|養老|規劃|配置/,
    /基金|股票|投資|ETF|債券|宣告利率|內扣/,
    /手術|住院|疾病|確診|體況|三高|糖尿病|高血壓|癌症/,
    /比較|差別|分析|建議|推薦|哪個比較好|值不值得/,
    /擔心|不安|焦慮|難過|壓力|不知道怎麼辦/,  // 情緒
    /如果|假設|萬一|要是|情況下/,              // 假設推理
  ];
  for (const p of complexPatterns) {
    if (p.test(t)) return 'complex';
  }

  // 長訊息（>40字）通常需要深度回應
  if (t.length > 40) return 'complex';

  return 'simple';
}

// ── Prompt Caching helper ──────────────────────────────────
// 把 messages 陣列包成 Anthropic block 格式，並在「倒數第二則」加 cache_control。
// 用意：persona（system）本身會被 cache，再加上 history 前綴也 cache，
//      重複對話命中時 input cost 直接 -90%。最末一則 user 訊息不 cache
//      （它每次都不一樣，留著當 cache key 後段）。
function _withCacheBreakpoint(messages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return messages; // 太短不值得 cache
  }
  // 倒數第二則：加 cache_control。content 從 string 轉成 [{type:'text', text, cache_control}]
  const cloned = messages.map((m, i) => {
    if (i !== messages.length - 2) return m;
    const text = typeof m.content === 'string' ? m.content : null;
    if (text === null) return m; // 已經是 array 形式（圖片等）就跳過
    return {
      role: m.role,
      content: [
        { type: 'text', text, cache_control: { type: 'ephemeral' } }
      ]
    };
  });
  return cloned;
}

// system 也用 array 形式並加 cache_control，persona ~4K tokens 命中率高
// 用 lazy getter 因為 personaInstruction 是在檔尾才定義（透過 IIFE 讀檔）
let _cachedSystemMemo = null;
function _getCachedSystem() {
  if (_cachedSystemMemo) return _cachedSystemMemo;
  _cachedSystemMemo = [
    { type: 'text', text: personaInstruction, cache_control: { type: 'ephemeral' } }
  ];
  return _cachedSystemMemo;
}

async function _replyWithClaude(prompt, messages) {
  if (!anthropicClient) return null;
  const response = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8096,
    system: _getCachedSystem(),
    messages: _withCacheBreakpoint(messages),
  });
  return response?.content?.[0]?.text?.trim() || null;
}

// 簡單訊息走 Haiku — 比 Gemini Flash 更有人味，但 token 成本仍低（約 Sonnet 的 1/3）
async function _replyWithHaiku(prompt, messages) {
  if (!anthropicClient) return null;
  const response = await anthropicClient.messages.create({
    model: CLAUDE_HAIKU_MODEL,
    max_tokens: 4096,
    system: _getCachedSystem(),
    messages: _withCacheBreakpoint(messages),
  });
  return response?.content?.[0]?.text?.trim() || null;
}

async function _replyWithGemini(prompt, messages) {
  if (!genAI) return null;
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: personaInstruction,
  });

  // 若有對話歷史，使用 startChat() 保持記憶（Gemini 需要 user/model 交替格式）
  const historyMsgs = (messages || []).slice(0, -1); // 排除最後一則（當前問題）
  if (historyMsgs.length > 0) {
    // 轉換格式：assistant → model
    const geminiHistory = [];
    let lastRole = null;
    for (const m of historyMsgs) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (role === lastRole) continue; // 跳過連續同角色（Gemini 要求嚴格交替）
      geminiHistory.push({ role, parts: [{ text: m.content }] });
      lastRole = role;
    }
    // 必須以 user 開頭
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }
    if (geminiHistory.length > 0) {
      try {
        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(prompt);
        return result?.response?.text()?.trim() || null;
      } catch (e) {
        console.error('[Gemini] startChat 失敗，fallback generateContent:', e.message);
      }
    }
  }
  // fallback：無歷史或 startChat 失敗
  const result = await model.generateContent(prompt);
  return result?.response?.text()?.trim() || null;
}

async function getAssistantReply(event, rawText) {
  const displayName = await fetchDisplayName(event?.source);
  const userId = event?.source?.type === 'user' ? event.source.userId : null;
  const prompt = await buildPrompt(rawText, event, displayName);

  // 從 Supabase 載入對話歷史（最多 SESSION_MAX_TURNS*2 = 40 則）
  const fullHistory = await memoryStore.loadSessionHistory(userId);

  // 智能路由：判斷訊息複雜度
  //   複雜（情緒 / 長文 / 推理） → Sonnet 4.6  → Haiku 4.5  → Gemini Flash
  //   簡單（短句 / 一般詢問）    → Haiku 4.5  → Sonnet 4.6 → Gemini Flash
  // Gemini 留在最末是降級保險（萬一 Anthropic 餘額/額度出狀況，bot 還能講話）
  const complexity = classifyMessageComplexity(rawText);
  const isComplex = complexity === 'complex';

  // 簡單路徑只帶最近 10 turns（20 則訊息）的歷史 — 進一步省 token
  // 複雜路徑帶完整 20 turns（40 則）— 情緒/推理需要更多 context
  const SIMPLE_HISTORY_MESSAGES = 20;
  const trimmedHistory = isComplex
    ? fullHistory
    : fullHistory.slice(-SIMPLE_HISTORY_MESSAGES);
  const messages = [...trimmedHistory, { role: 'user', content: prompt }];

  console.log(`[路由] ${isComplex ? '🧠 複雜 → Sonnet' : '⚡ 簡單 → Haiku'} | history=${trimmedHistory.length}則 | "${rawText?.slice(0, 30)}"`);

  let textResponse = null;

  if (isComplex) {
    // 複雜：Sonnet → Haiku → Gemini
    try { textResponse = await _replyWithClaude(prompt, messages); }
    catch (e) { console.error('Sonnet 失敗，切換 Haiku：', e.message); }
    if (!textResponse) {
      try { textResponse = await _replyWithHaiku(prompt, messages); }
      catch (e) { console.error('Haiku fallback 失敗，切換 Gemini：', e.message); }
    }
    if (!textResponse) {
      try { textResponse = await _replyWithGemini(prompt, messages); }
      catch (e) { console.error('Gemini fallback 失敗：', e.message); }
    }
  } else {
    // 簡單：Haiku → Sonnet → Gemini
    try { textResponse = await _replyWithHaiku(prompt, messages); }
    catch (e) { console.error('Haiku 失敗，切換 Sonnet：', e.message); }
    if (!textResponse) {
      try { textResponse = await _replyWithClaude(prompt, messages); }
      catch (e) { console.error('Sonnet fallback 失敗，切換 Gemini：', e.message); }
    }
    if (!textResponse) {
      try { textResponse = await _replyWithGemini(prompt, messages); }
      catch (e) { console.error('Gemini fallback 失敗：', e.message); }
    }
  }

  if (textResponse) {
    await memoryStore.saveSessionMessage(userId, 'user', prompt);
    await memoryStore.saveSessionMessage(userId, 'assistant', textResponse);
    // 非同步：主動推送偵測 + CRM 摘要追蹤
    proactivePush.detectAndStoreTrigger(userId, rawText, textResponse).catch(console.error);
    crmIntegration.trackAndMaybeSummarize(userId, displayName, anthropicClient, memoryStore).catch(console.error);
    return textResponse;
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
  const messageItems = [
    { label: '基金摘要', text: '基金摘要' },
    { label: '保戶溫暖版', text: '保戶溫暖版' },
    { label: '專業理財版', text: '專業理財版' },
    { label: '焦點新聞', text: '焦點新聞' },
    { label: '保單健檢', text: '保單健檢' },
    { label: '主管輔導', text: '主管輔導提點' }
  ];
  const messageButtons = messageItems.map((item) => ({
    type: 'action',
    action: { type: 'message', label: item.label, text: item.text }
  }));
  const uriButtons = [
    {
      type: 'action',
      action: { type: 'uri', label: '🌐 官方網站', uri: 'https://jp-file-sync-web.onrender.com/#marquee' }
    }
  ];
  return { items: [...messageButtons, ...uriButtons] };
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
  const keywords = ['基金摘要', '基金快照', '基金資訊'];
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

// 從 persona.md 讀取小平的人設（方便直接編輯該檔案新增技能，不需動 app.js）
const personaInstruction = (() => {
  try {
    return fs.readFileSync(path.resolve(__dirname, 'persona.md'), 'utf8');
  } catch (e) {
    console.warn('找不到 persona.md，使用預設人設');
    return '你是「小平」，一位親切專業的保險與基金顧問助手，使用繁體中文回覆。';
  }
})();

const fewShotExamples = `客戶：我最近壓力很大，基金都在跌。
小平：先抱一下啦，把錢分成「必要 / 可調整」，盯住美元和美股的節奏就不會那麼慌。

客戶：團隊裡有個射手座業務，很有想法但不愛回報。
小平：給他清楚的目標＋截止日，語氣軟一點，他就知道你是在幫他，不是在盯。

客戶：高雄今天到底會不會下雨？
小平：我查一下天氣，現在高雄 28°C、體感 30°C，微微東北風，出門帶頂帽子比較保險。

客戶：今天台股行情怎樣？
小平：我幫你搜一下最新時事，等一下快速整理三則焦點給你。`;

async function buildPrompt(userText, event, displayName) {
  const topicHint = buildTopicHint(userText);
  const sourceInfo = event?.source?.type === 'user' ? '個人客戶' : '群組';
  const userId = event?.source?.type === 'user' ? event.source.userId : '';
  const previousMemories = userId ? await memoryStore.getRecentMemories(userId, topicHint, 3) : [];
  const memoryContext = previousMemories.length ? `使用者之前提過：
${previousMemories.join('\n')}
---
` : '';
  const nameHint = displayName ? `使用者 LINE 名稱：${displayName}（稱呼對方時請直接叫「${displayName}」，不要用「大哥/大姐/老闆」等泛稱）\n` : '';

  return `${fewShotExamples}
---
${memoryContext}${nameHint}使用者類型：${sourceInfo}
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

async function maybeStoreMemory(event, text) {
  if (!text || !event?.source || event.source.type !== 'user') {
    return;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!shouldStoreMemory(normalized)) {
    return;
  }
  const topic = buildTopicHint(normalized);
  const summary = summarizeMemory(normalized);
  await memoryStore.saveMemory({ userId: event.source.userId, topic, summary });
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
const CONTACTS_FILE = path.join(__dirname, 'contacts.json');
const SURVEY_RESPONSES_FILE = path.join(__dirname, 'survey_responses.json');
const SURVEY_PAGE_FILE = path.join(__dirname, 'dashboard', 'public', 'survey-track.html');

app.get('/survey-track.html', (req, res) => {
  if (fs.existsSync(SURVEY_PAGE_FILE)) return res.sendFile(SURVEY_PAGE_FILE);
  return res.type('html').send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>保險需求小問卷</title><style>body{font-family:'Noto Sans TC',sans-serif;background:#f3f4f6;margin:0;padding:16px}.box{max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 8px 24px rgba(15,23,42,.08)}h1{font-size:1.35rem;margin-bottom:8px}.desc{color:#4b5563;line-height:1.6}.opt{margin:6px 0}label{display:block;margin:16px 0 8px;font-weight:600}button{width:100%;margin-top:24px;padding:14px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700}.consent{font-size:.85rem;color:#6b7280;margin-top:16px;line-height:1.4}#msg{margin-top:12px;color:#2563eb;font-weight:600}</style></head><body><div class="box"><h1>保險需求小問卷（約 1 分鐘）</h1><p class="desc">健平想聽聽你的想法，這份問卷只要 1 分鐘。回覆後我會依照你的需求，提供個人化的建議與最新保單整理資訊。</p><form id="f"><label>1. 你是否已經和健平購買過保險？</label><div class="opt"><input type="radio" name="q1" value="yes" required> 是</div><div class="opt"><input type="radio" name="q1" value="no"> 否</div><label>2. 你對自己的保險了解程度如何？</label><div class="opt"><input type="radio" name="q2" value="clear" required> 很清楚（完全掌握）</div><div class="opt"><input type="radio" name="q2" value="mid"> 一般（概略知道）</div><div class="opt"><input type="radio" name="q2" value="unclear"> 不太清楚（需要協助）</div><label>3. 你是否希望健平協助更新 / 整理你的保單資訊？</label><div class="opt"><input type="radio" name="q3" value="yes_now" required> 非常願意，我需要協助</div><div class="opt"><input type="radio" name="q3" value="maybe"> 可以看看情況</div><div class="opt"><input type="radio" name="q3" value="no_need"> 我自己很了解，暫時不用</div><button type="submit">送出問卷</button><div class="consent">我了解並同意：這份問卷僅用於提供保險建議與服務優化。若不希望後續收到健平的連繫，可隨時回覆「停止」或通知客服。</div><div id="msg"></div></form></div><script>const uid=new URLSearchParams(location.search).get('uid')||'';document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();if(!uid){document.getElementById('msg').textContent='缺少 uid，請從原始訊息連結開啟。';return;}const fd=new FormData(e.target);const payload={userId:uid,uid,surveyId:'survey_reengage_v2',answers:{q1:fd.get('q1'),q2:fd.get('q2'),q3:fd.get('q3')}};const r=await fetch('/api/survey-track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();document.getElementById('msg').textContent=(r.ok&&j.ok)?'感謝你的回覆！我會依照答案整理建議，稍後與你聯繫。':'送出失敗，請稍後再試。';if(r.ok&&j.ok)e.target.reset();});</script></body></html>`);
});

app.post('/api/survey-track', express.json(), (req, res) => {
  try {
    const userId = String(req.body?.userId || req.body?.uid || '').trim();
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const payload = {
      userId,
      score: Number(req.body?.score ?? NaN),
      note: String(req.body?.note || '').trim(),
      answers: req.body?.answers || req.body?.data || null,
      submittedAt: new Date().toISOString()
    };

    const responses = fs.existsSync(SURVEY_RESPONSES_FILE)
      ? JSON.parse(fs.readFileSync(SURVEY_RESPONSES_FILE, 'utf8') || '[]')
      : [];
    responses.push(payload);
    fs.writeFileSync(SURVEY_RESPONSES_FILE, JSON.stringify(responses, null, 2), 'utf8');

    const contacts = fs.existsSync(CONTACTS_FILE)
      ? JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8') || '[]')
      : [];
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
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2), 'utf8');

    return res.json({ ok: true, userId, submittedAt: payload.submittedAt });
  } catch (err) {
    console.error('survey-track error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.get('/admin/contacts/export', async (req, res) => {
  try {
    const token = req.query.token;
    const expected = process.env.ADMIN_EXPORT_TOKEN;

    if (!expected) return res.status(500).json({ error: 'ADMIN_EXPORT_TOKEN not set' });
    if (!token || token !== expected) return res.status(401).json({ error: 'unauthorized' });

    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'contacts.json');

    // 本機 contacts.json（當前 session 記憶體來源）
    let contacts = [];
    if (fs.existsSync(file)) {
      try { contacts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!Array.isArray(contacts)) contacts = [];
    }

    // ── Supabase 歷史聯絡人補全（Render 重啟後 contacts.json 為空，但 Supabase 有全記錄）──
    try {
      const sb = require('./supabaseClient');
      if (sb) {
        const { data } = await sb
          .from('interaction_logs')
          .select('user_id, display_name, created_at')
          .order('created_at', { ascending: false })
          .limit(500);
        if (data && data.length > 0) {
          const existingIds = new Set(contacts.map(c => c.userId));
          const supabaseMap = new Map();
          for (const row of data) {
            if (row.user_id && !supabaseMap.has(row.user_id)) {
              supabaseMap.set(row.user_id, row.display_name || '新客戶');
            }
          }
          for (const [userId, name] of supabaseMap) {
            if (!existingIds.has(userId)) {
              contacts.push({ userId, name, enabled: true, last_contact_at: null });
            }
          }
          console.log(`[contacts/export] 本機 ${existingIds.size} + Supabase 補 ${contacts.length - existingIds.size} = 共 ${contacts.length} 筆`);
        }
      }
    } catch (e) {
      console.error('[contacts/export] Supabase fallback 失敗：', e.message);
    }

    return res.json(contacts);
  } catch (err) {
    console.error('export contacts error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/admin/global-manual', (req, res) => {
  try {
    const token = req.query.token;
    const expected = process.env.ADMIN_EXPORT_TOKEN;
    if (!expected) return res.status(500).json({ error: 'ADMIN_EXPORT_TOKEN not set' });
    if (!token || token !== expected) return res.status(401).json({ error: 'unauthorized' });
    return res.json({ enabled: isGlobalManualMode() });
  } catch (err) {
    console.error('global-manual get error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/admin/global-manual', express.json(), (req, res) => {
  try {
    const token = req.query.token || req.headers['x-admin-token'];
    const expected = process.env.ADMIN_EXPORT_TOKEN;
    if (!expected) return res.status(500).json({ error: 'ADMIN_EXPORT_TOKEN not set' });
    if (!token || token !== expected) return res.status(401).json({ error: 'unauthorized' });
    setGlobalManualMode(Boolean(req.body?.enabled));
    return res.json({ ok: true, enabled: isGlobalManualMode() });
  } catch (err) {
    console.error('global-manual post error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── /admin/line-summaries：供本機 dashboard 拉取對話摘要（不需本機 SUPABASE）──

// ── 診斷：確認 conversation_history 資料表 ─────────
app.get('/admin/check-memory', async (req, res) => {
  const token = req.query.token;
  const expected = process.env.ADMIN_EXPORT_TOKEN;
  if (!expected || token !== expected) return res.status(401).json({ error: 'unauthorized' });
  const sb = require('./supabaseClient');
  if (!sb) return res.json({ ok: false, note: 'supabase not configured' });

  try {
    // 檢查 conversation_history 最新 5 筆
    const { data: hist, error: e1 } = await sb
      .from('conversation_history')
      .select('user_id, role, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    // 檢查 user_memories 最新 5 筆
    const { data: mems, error: e2 } = await sb
      .from('user_memories')
      .select('user_id, topic, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    return res.json({
      ok: true,
      conversation_history: {
        error: e1?.message || null,
        count: hist?.length || 0,
        latest: hist || [],
      },
      user_memories: {
        error: e2?.message || null,
        count: mems?.length || 0,
        latest: mems || [],
      }
    });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/admin/line-summaries', async (req, res) => {
  try {
    const token    = req.query.token;
    const expected = process.env.ADMIN_EXPORT_TOKEN;
    if (!expected) return res.status(500).json({ error: 'ADMIN_EXPORT_TOKEN not set' });
    if (!token || token !== expected) return res.status(401).json({ error: 'unauthorized' });

    const sb = require('./supabaseClient');
    if (!sb) return res.json({ ok: true, summaries: [], note: 'supabase not configured on render' });

    const { data, error } = await sb
      .from('interaction_logs')
      .select('id, client_id, user_id, display_name, type, content, created_at')
      .eq('type', '💬 LINE')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ ok: false, error: error.message });

    return res.json({ ok: true, summaries: data || [] });
  } catch (err) {
    console.error('/admin/line-summaries error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`伺服器運行在 http://localhost:${PORT}`);

  // ── 主動推送排程器 ─────────────────────────────────────
  // 每60分鐘掃描一次待發主動訊息
  const PUSH_INTERVAL_MS = 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await proactivePush.sendPendingMessages(client, anthropicClient, personaInstruction);
    } catch (err) {
      console.error('主動推送排程錯誤：', err.message);
    }
  }, PUSH_INTERVAL_MS);

  // 每24小時檢查節慶觸發（台灣時間早上9點附近執行）
  const SEASONAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const allUsers = await proactivePush.getAllActiveUserIds();
      await proactivePush.checkSeasonalTriggers(allUsers);
    } catch (err) {
      console.error('節慶觸發檢查錯誤：', err.message);
    }
  }, SEASONAL_INTERVAL_MS);

  console.log('✅ 主動推送排程器已啟動（每60分鐘掃描）');
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

function isManualMode(userId) {
  try {
    if (!userId) return false;
    const file = path.join(__dirname, 'contacts.json');
    if (!fs.existsSync(file)) return false;
    const contacts = JSON.parse(fs.readFileSync(file, 'utf8'));
    const found = Array.isArray(contacts) ? contacts.find(c => c.userId === userId) : null;
    return Boolean(found?.manual_mode);
  } catch {
    return false;
  }
}

function setManualMode(userId, enabled) {
  try {
    if (!userId) return;
    const file = path.join(__dirname, 'contacts.json');
    let contacts = [];
    if (fs.existsSync(file)) {
      contacts = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(contacts)) contacts = [];
    }
    const now = new Date().toISOString();
    const idx = contacts.findIndex(c => c.userId === userId);
    if (idx >= 0) {
      contacts[idx].manual_mode = enabled;
      contacts[idx].manual_mode_updated_at = now;
    } else {
      contacts.push({
        userId,
        name: '新客戶',
        last_contact_at: now,
        last_care_at: null,
        enabled: true,
        manual_mode: enabled,
        manual_mode_updated_at: now
      });
    }
    fs.writeFileSync(file, JSON.stringify(contacts, null, 2), 'utf8');
  } catch (e) {
    console.error('setManualMode error:', e);
  }
}


function isGlobalManualMode() {
  try {
    const file = path.join(__dirname, 'status', 'global_manual.json');
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(data?.enabled);
  } catch {
    return false;
  }
}

function setGlobalManualMode(enabled) {
  try {
    const dir = path.join(__dirname, 'status');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'global_manual.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: Boolean(enabled), updated_at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    console.error('setGlobalManualMode error:', e);
  }
}

function isManualMode(userId) {
  try {
    if (!userId) return false;
    const file = path.join(__dirname, 'contacts.json');
    if (!fs.existsSync(file)) return false;
    const contacts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(contacts)) return false;
    const c = contacts.find(x => x.userId === userId);
    return Boolean(c?.manual_mode);
  } catch {
    return false;
  }
}

function setManualMode(userId, enabled) {
  try {
    if (!userId) return;
    const file = path.join(__dirname, 'contacts.json');
    let contacts = [];
    if (fs.existsSync(file)) {
      contacts = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(contacts)) contacts = [];
    }
    const idx = contacts.findIndex(c => c.userId === userId);
    if (idx >= 0) {
      contacts[idx].manual_mode = Boolean(enabled);
      contacts[idx].manual_updated_at = new Date().toISOString();
    } else {
      contacts.push({
        userId,
        name: '新客戶',
        last_contact_at: new Date().toISOString(),
        last_care_at: null,
        enabled: true,
        manual_mode: Boolean(enabled),
        manual_updated_at: new Date().toISOString()
      });
    }
    fs.writeFileSync(file, JSON.stringify(contacts, null, 2), 'utf8');
  } catch (e) {
    console.error('setManualMode error:', e);
  }
}

function upsertContactFromEvent(event) {
  // ❗ 改走 contactsBuffer：把「userId=X 剛互動」這件事記在記憶體，
  // 背景 30s 或滿 100 筆才 flush 到 contacts.json。
  // 舊版每則訊息同步 writeFileSync 會阻塞 event loop，也容易互相蓋欄位。
  try {
    contactsBuffer.upsertEvent(event);
  } catch (e) {
    console.error('upsertContactFromEvent error:', e);
  }
}
