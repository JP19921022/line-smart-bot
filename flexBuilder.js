'use strict';

// ══════════════════════════════════════════════════════════
// 好險有您 品牌色系
// ══════════════════════════════════════════════════════════
const BRAND = {
  primary:   '#5B4FCF',   // 品牌紫
  secondary: '#7B6FE0',
  accent:    '#00B8D4',   // 青色
  light:     '#F5F3FF',
  text:      '#2D2D2D',
  subtext:   '#777777',
  white:     '#FFFFFF',
};

// ══════════════════════════════════════════════════════════
// 通用：品牌主動關懷卡片（手術/生日/轉介紹 等）
// ══════════════════════════════════════════════════════════
function buildProactiveFlex({ iconEmoji, title, message, ctaLabel, ctaText }) {
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'horizontal',
        backgroundColor: BRAND.primary,
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: `${iconEmoji}  好險有您`,
            color: BRAND.white,
            weight: 'bold',
            size: 'md',
            flex: 1,
          },
          {
            type: 'text',
            text: title,
            color: '#D4CFFF',
            size: 'xs',
            align: 'end',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        spacing: 'md',
        backgroundColor: BRAND.light,
        contents: [
          {
            type: 'text',
            text: message,
            wrap: true,
            size: 'sm',
            color: BRAND.text,
            lineSpacing: '6px',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        backgroundColor: BRAND.white,
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: BRAND.primary,
            height: 'sm',
            action: {
              type: 'message',
              label: ctaLabel,
              text: ctaText,
            },
          },
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════
// 節慶推送卡片（有主視覺圖）
// ══════════════════════════════════════════════════════════
const SEASONAL_CONFIG = {
  seasonal_qingming: {
    image: 'https://images.unsplash.com/photo-1520637836862-4d197d17c93a?auto=format&fit=crop&w=1200&q=80',
    title: '🌸 清明保單健診時間到了',
    subtitle: '每年更新受益人和保障缺口，是給家人最好的禮物。',
    cta: '預約免費保單健診',
  },
  seasonal_mothers_day: {
    image: 'https://images.unsplash.com/photo-1518199266791-5375a83190b7?auto=format&fit=crop&w=1200&q=80',
    title: '💐 母親節快樂！',
    subtitle: '最好的母親節禮物，是讓媽媽的未來更有保障。',
    cta: '幫媽媽做保障檢視',
  },
  seasonal_fathers_day: {
    image: 'https://images.unsplash.com/photo-1530062845289-9109b2c9c868?auto=format&fit=crop&w=1200&q=80',
    title: '👔 父親節快樂！',
    subtitle: '爸爸打拚最辛苦，讓保障守護他最需要的時刻。',
    cta: '幫爸爸做保障檢視',
  },
  seasonal_yearend: {
    image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=1200&q=80',
    title: '🎯 年底節稅規劃提醒',
    subtitle: '保費最高可列舉扣除，今年還有機會省下一筆！',
    cta: '試算我的節稅空間',
  },
};

function buildSeasonalFlex(triggerType, aiMessage) {
  const cfg = SEASONAL_CONFIG[triggerType];
  if (!cfg) return buildProactiveFlex({
    iconEmoji: '🗓',
    title: '節慶關懷',
    message: aiMessage,
    ctaLabel: '回覆小平',
    ctaText: '我想了解更多',
  });

  return {
    type: 'flex',
    altText: cfg.title,
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: cfg.image,
        size: 'full',
        aspectRatio: '20:11',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: cfg.title, weight: 'bold', size: 'lg', color: BRAND.text, wrap: true },
          { type: 'text', text: cfg.subtitle, size: 'sm', color: BRAND.subtext, wrap: true, margin: 'sm' },
          { type: 'separator', margin: 'lg' },
          {
            type: 'text',
            text: aiMessage,
            size: 'sm',
            color: BRAND.text,
            wrap: true,
            margin: 'lg',
            lineSpacing: '5px',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: BRAND.primary,
            action: { type: 'message', label: cfg.cta, text: cfg.cta },
          },
          {
            type: 'button',
            style: 'link',
            action: {
              type: 'uri',
              label: '🌐 官方網站',
              uri: 'https://jp-file-sync-web.onrender.com/#marquee',
            },
          },
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════
// 手術關懷卡片
// ══════════════════════════════════════════════════════════
function buildSurgeryFollowupFlex(aiMessage) {
  return buildProactiveFlex({
    iconEmoji: '💙',
    title: '術後關懷',
    message: aiMessage,
    ctaLabel: '回傳文件給小平',
    ctaText: '我要傳理賠文件',
  });
}

// ══════════════════════════════════════════════════════════
// 生日祝福卡片
// ══════════════════════════════════════════════════════════
function buildBirthdayFlex(aiMessage) {
  return buildProactiveFlex({
    iconEmoji: '🎂',
    title: '生日祝福',
    message: aiMessage,
    ctaLabel: '預約保單健診',
    ctaText: '我要預約免費保單健診',
  });
}

// ══════════════════════════════════════════════════════════
// 轉介紹引導卡片
// ══════════════════════════════════════════════════════════
function buildReferralFlex(aiMessage) {
  return buildProactiveFlex({
    iconEmoji: '🤝',
    title: '好友轉介紹',
    message: aiMessage,
    ctaLabel: '介紹朋友來聊聊',
    ctaText: '我有朋友想了解保險',
  });
}

// ══════════════════════════════════════════════════════════
// 根據 trigger_type 自動選擇卡片
// ══════════════════════════════════════════════════════════
function buildFlexByTriggerType(triggerType, aiMessage) {
  switch (triggerType) {
    case 'surgery_followup':   return buildSurgeryFollowupFlex(aiMessage);
    case 'birthday_followup':  return buildBirthdayFlex(aiMessage);
    case 'referral_followup':  return buildReferralFlex(aiMessage);
    case 'seasonal_qingming':
    case 'seasonal_mothers_day':
    case 'seasonal_fathers_day':
    case 'seasonal_yearend':   return buildSeasonalFlex(triggerType, aiMessage);
    default:
      return buildProactiveFlex({
        iconEmoji: '🏠',
        title: '小平關懷',
        message: aiMessage,
        ctaLabel: '回覆小平',
        ctaText: '我想了解更多',
      });
  }
}

module.exports = { buildFlexByTriggerType, buildProactiveFlex, buildSeasonalFlex };
