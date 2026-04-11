'use strict';
const supabase = require('./supabaseClient');

// ──────────────────────────────────────────────
// 觸發類型對應的延遲天數與訊息生成提示
// ──────────────────────────────────────────────
const TRIGGER_CONFIG = {
  surgery_followup: {
    delayDays: 3,
    prompt: '這位客戶3天前提到要手術或住院。現在以小平身份主動關心他的狀況，並溫柔提醒理賠文件要準備好。語氣溫暖簡短，不超過80字。',
  },
  birthday_followup: {
    delayDays: 0,
    prompt: '這位客戶提到生日相關話題。送上溫暖祝福，並自然帶入一句「保單健診也是送給自己的禮物」的邀約。不超過80字。',
  },
  referral_followup: {
    delayDays: 7,
    prompt: '這位客戶上次服務後一週，主動關心近況，並用輕鬆語氣帶出轉介紹邀請。不超過80字。',
  },
  seasonal_qingming: {
    prompt: '清明節前，主動提醒保單健診與受益人更新，語氣溫暖，不說教。不超過80字。',
  },
  seasonal_mothers_day: {
    prompt: '母親節到了，關心客戶的家人保障，自然帶入長輩安養規劃話題。不超過80字。',
  },
  seasonal_fathers_day: {
    prompt: '父親節到了，關心客戶的親子保障，自然帶入兒童保險話題。不超過80字。',
  },
  seasonal_yearend: {
    prompt: '年底了，提醒保費列舉扣除額與節稅規劃，語氣輕鬆不強迫。不超過80字。',
  },
};

// 節慶觸發日曆（月份從1開始）
const SEASONAL_CALENDAR = [
  { month: 3, day: 20, type: 'seasonal_qingming' },   // 清明前
  { month: 5,  day: 1,  type: 'seasonal_mothers_day' }, // 母親節月份
  { month: 8,  day: 1,  type: 'seasonal_fathers_day' }, // 父親節月份
  { month: 11, day: 15, type: 'seasonal_yearend' },     // 年底節稅提醒
];

// ──────────────────────────────────────────────
// 對話後偵測觸發事件，存入 Supabase
// ──────────────────────────────────────────────
async function detectAndStoreTrigger(userId, userMessage, assistantReply) {
  if (!supabase || !userId) return;
  const combined = (userMessage + ' ' + assistantReply);

  // 手術 / 住院 → 3天後主動關懷
  if (/手術|住院|開刀|動手術/.test(combined)) {
    await _storeTrigger(userId, 'surgery_followup', _daysFromNow(3), '客戶提到手術或住院');
  }

  // 生日 → 隔天主動祝福
  if (/生日|慶生|歲了/.test(combined)) {
    await _storeTrigger(userId, 'birthday_followup', _daysFromNow(1), '客戶提到生日');
  }

  // 正向感謝 → 7天後轉介紹引導
  if (/謝謝|感謝|好險有你|幫大忙|太感謝/.test(combined)) {
    await _storeTrigger(userId, 'referral_followup', _daysFromNow(7), '客戶表達感謝');
  }
}

// ──────────────────────────────────────────────
// 每日節慶觸發檢查（在排程器中呼叫）
// ──────────────────────────────────────────────
async function checkSeasonalTriggers(allUserIds) {
  if (!supabase || !allUserIds || allUserIds.length === 0) return;
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  for (const cal of SEASONAL_CALENDAR) {
    if (cal.month === month && cal.day === day) {
      for (const userId of allUserIds) {
        await _storeTrigger(userId, cal.type, now, `節慶觸發：${cal.type}`);
      }
    }
  }
}

// ──────────────────────────────────────────────
// 排程器：每小時掃描待發訊息，呼叫 LINE push
// ──────────────────────────────────────────────
async function sendPendingMessages(lineClient, anthropicClient, personaInstruction) {
  if (!supabase || !lineClient) return;

  const now = new Date().toISOString();
  const { data: triggers, error } = await supabase
    .from('proactive_triggers')
    .select('*')
    .eq('sent', false)
    .lte('trigger_date', now);

  if (error) { console.error('proactivePush 查詢失敗：', error.message); return; }
  if (!triggers || triggers.length === 0) return;

  console.log(`📤 找到 ${triggers.length} 筆待發主動訊息`);

  for (const trigger of triggers) {
    try {
      const message = await _generateMessage(trigger, anthropicClient, personaInstruction);
      await lineClient.pushMessage({ to: trigger.user_id, messages: [{ type: 'text', text: message }] });
      await supabase.from('proactive_triggers').update({ sent: true }).eq('id', trigger.id);
      console.log(`✅ 主動訊息已送出 → ${trigger.user_id} [${trigger.trigger_type}]`);
    } catch (err) {
      console.error(`❌ 主動訊息失敗 → ${trigger.user_id}：`, err.message);
    }
  }
}

// ──────────────────────────────────────────────
// 取得所有有對話記錄的 userId（給節慶廣播用）
// ──────────────────────────────────────────────
async function getAllActiveUserIds() {
  if (!supabase) return [];
  const { data } = await supabase
    .from('conversation_history')
    .select('user_id')
    .order('created_at', { ascending: false });
  if (!data) return [];
  return [...new Set(data.map(r => r.user_id))];
}

// ──────────────────────────────────────────────
// 內部工具函式
// ──────────────────────────────────────────────
async function _storeTrigger(userId, triggerType, triggerDate, context) {
  // 避免重複寫入
  const { data } = await supabase
    .from('proactive_triggers')
    .select('id')
    .eq('user_id', userId)
    .eq('trigger_type', triggerType)
    .eq('sent', false)
    .gte('trigger_date', new Date().toISOString())
    .limit(1);

  if (data && data.length > 0) return;

  await supabase.from('proactive_triggers').insert({
    user_id: userId,
    trigger_type: triggerType,
    trigger_date: triggerDate instanceof Date ? triggerDate.toISOString() : triggerDate,
    context,
  });
}

function _daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

async function _generateMessage(trigger, anthropicClient, personaInstruction) {
  const config = TRIGGER_CONFIG[trigger.trigger_type];
  const prompt = config
    ? `[系統指令] 請以小平身份主動發出一則訊息：${config.prompt}`
    : `[系統指令] 請以小平身份主動關心客戶（情境：${trigger.context}），語氣溫暖，不超過80字。`;

  if (anthropicClient) {
    try {
      const response = await anthropicClient.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 300,
        system: personaInstruction,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.content[0].text.trim();
    } catch (e) {
      console.error('主動訊息生成失敗：', e.message);
    }
  }
  return '嗨！小平這邊主動關心一下，最近一切都好嗎？有任何問題隨時找我喔！🤝';
}

module.exports = { detectAndStoreTrigger, checkSeasonalTriggers, sendPendingMessages, getAllActiveUserIds };
