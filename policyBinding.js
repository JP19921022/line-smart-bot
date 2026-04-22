/**
 * policyBinding.js
 * 客戶 LINE 帳號綁定保單流程
 *
 * 流程：
 *   1. 觸發「查詢我的保單」→ 檢查是否已綁定
 *   2. 未綁定 → 詢問姓名
 *   3. 姓名輸入 → 模糊比對 customer_profiles，列出候選
 *   4. 選擇確認（postback）→ 更新 line_user_id
 *   5. 綁定成功 → 顯示保單摘要 Flex
 */

const supabasePolicies = require('./supabasePolicies');

// ── 狀態機（in-memory，保存期間即可） ─────────────────────────
// key: userId  value: { step: 'waiting_name'|'waiting_confirm', candidates: [...] }
const bindingState = new Map();

const BINDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 分鐘逾時自動清除

function setState(userId, state) {
  bindingState.set(userId, { ...state, ts: Date.now() });
}

function getState(userId) {
  const s = bindingState.get(userId);
  if (!s) return null;
  if (Date.now() - s.ts > BINDING_TIMEOUT_MS) {
    bindingState.delete(userId);
    return null;
  }
  return s;
}

function clearState(userId) {
  bindingState.delete(userId);
}

// ── 入口：檢查是否已綁定，決定直接顯示或開始綁定 ───────────────
async function startPolicyQuery(userId) {
  // 1. 已綁定 → 直接查詢並回傳保單摘要
  const profile = await supabasePolicies.getProfileByLineId(userId);
  if (profile) {
    const policies = await supabasePolicies.getPoliciesByCustomerId(profile.id);
    return buildPolicySummaryFlex(profile.client_name, policies);
  }

  // 2. 未綁定 → 開始綁定流程
  setState(userId, { step: 'waiting_name' });
  return buildAskNameMessage();
}

// ── 處理文字輸入（從 handleEvent 攔截） ─────────────────────────
async function handleBindingText(userId, text) {
  const state = getState(userId);
  if (!state) return null; // 不在綁定流程中

  // Step: 等待姓名輸入
  if (state.step === 'waiting_name') {
    const name = text.trim();
    if (!name) {
      return { type: 'text', text: '請輸入您的姓名 😊' };
    }

    const candidates = await supabasePolicies.searchProfilesByName(name);

    if (!candidates || candidates.length === 0) {
      clearState(userId);
      return {
        type: 'text',
        text: `找不到「${name}」的保單資料。\n\n請確認姓名是否正確，或聯繫業務員協助。`,
      };
    }

    // 找到候選 → 讓用戶確認
    setState(userId, { step: 'waiting_confirm', candidates, inputName: name });
    return buildConfirmCandidatesFlex(candidates, name);
  }

  // 如果在等確認期間輸入文字 → 提示用請點選按鈕
  if (state.step === 'waiting_confirm') {
    return {
      type: 'text',
      text: '請點選上方的按鈕確認您的身份 ☝️\n\n或輸入「取消」重新查詢。',
    };
  }

  return null;
}

// ── 處理 postback（從 handlePostbackEvent 攔截） ──────────────
async function handleBindingPostback(userId, data) {
  // data 格式: policy_bind:confirm:<profileId>  或  policy_bind:cancel
  if (!data.startsWith('policy_bind:')) return null;

  if (data === 'policy_bind:cancel') {
    clearState(userId);
    return { type: 'text', text: '已取消查詢。如需再次查詢，請點選主選單「查詢我的保單」。' };
  }

  const parts = data.split(':');
  if (parts[1] === 'confirm' && parts[2]) {
    const profileId = parts[2];

    // 更新 line_user_id
    const ok = await supabasePolicies.bindLineUser(profileId, userId);
    clearState(userId);

    if (!ok) {
      return { type: 'text', text: '綁定失敗，請稍後再試或聯繫業務員。' };
    }

    // 查詢保單並顯示摘要
    const profile = await supabasePolicies.getProfileById(profileId);
    const policies = await supabasePolicies.getPoliciesByCustomerId(profileId);
    return buildBindingSuccessFlex(profile?.client_name || '您', policies);
  }

  return null;
}

// ── Flex Message 建構 ─────────────────────────────────────────

function buildAskNameMessage() {
  return {
    type: 'text',
    text: '📋 查詢保單\n\n請輸入您的姓名，我來幫您找保單資料 😊\n（例如：林小明）',
  };
}

function buildConfirmCandidatesFlex(candidates, inputName) {
  // 最多顯示 5 筆候選
  const bubbles = candidates.slice(0, 5).map((c) => ({
    type: 'bubble',
    size: 'micro',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '確認身份', size: 'xs', color: '#aaaaaa', align: 'center' },
      ],
      paddingBottom: '4px',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        {
          type: 'text',
          text: c.client_name,
          size: 'lg',
          weight: 'bold',
          align: 'center',
          color: '#1A1A2E',
        },
        {
          type: 'text',
          text: c.client_id_number ? `編號：${maskId(c.client_id_number)}` : '（無編號）',
          size: 'xxs',
          color: '#888888',
          align: 'center',
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#3D5AFE',
          height: 'sm',
          action: {
            type: 'postback',
            label: '是我！',
            data: `policy_bind:confirm:${c.id}`,
            displayText: `確認：${c.client_name}`,
          },
        },
      ],
    },
  }));

  // 加入「都不是我」取消按鈕
  bubbles.push({
    type: 'bubble',
    size: 'micro',
    body: {
      type: 'box',
      layout: 'vertical',
      justifyContent: 'center',
      height: '100px',
      contents: [
        {
          type: 'text',
          text: '都不是\n我',
          size: 'md',
          color: '#888888',
          align: 'center',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'postback',
            label: '取消',
            data: 'policy_bind:cancel',
            displayText: '取消查詢',
          },
        },
      ],
    },
  });

  return {
    type: 'flex',
    altText: `找到 ${candidates.length} 筆資料，請確認您的身份`,
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

function buildBindingSuccessFlex(clientName, policies) {
  const activePolicies = policies.filter((p) => p.policy_status === 1);
  return buildPolicySummaryFlex(clientName, activePolicies, true);
}

function buildPolicySummaryFlex(clientName, policies, isFirstTime = false) {
  if (!policies || policies.length === 0) {
    return {
      type: 'text',
      text: isFirstTime
        ? `✅ 綁定成功！歡迎 ${clientName} 😊\n\n目前查無有效保單，請聯繫業務員。`
        : `${clientName} 目前查無有效保單，請聯繫業務員。`,
    };
  }

  // 統計
  const typeMap = { T: '傳統保單', S: '儲蓄保單', I: '投資型', P: '產險' };
  const byCurrency = {};
  for (const p of policies) {
    const currency = p.currency_text || '台幣';
    const prem = (p.main_premium || 0)
      + (p.lifetime_rider_prem || 0)
      + (p.term_rider_prem || 0)
      + (p.waiver_prem || 0);
    byCurrency[currency] = (byCurrency[currency] || 0) + prem;
  }

  const premiumLines = Object.entries(byCurrency)
    .map(([cur, total]) => `  ${cur}：${numberWithCommas(Math.round(total))} 元`)
    .join('\n');

  // 分組
  const grouped = {};
  for (const p of policies) {
    const label = typeMap[p.policy_type] || p.policy_type;
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(p);
  }

  const bodyContents = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: '保單總數', size: 'sm', color: '#555555', flex: 0 },
        { type: 'text', text: `${policies.length} 張`, size: 'sm', weight: 'bold', align: 'end', color: '#111111' },
      ],
    },
    { type: 'separator', margin: 'sm' },
  ];

  // 各類型明細
  for (const [label, list] of Object.entries(grouped)) {
    bodyContents.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'sm',
      contents: [
        { type: 'text', text: label, size: 'xs', color: '#888888', flex: 0 },
        { type: 'text', text: `${list.length} 張`, size: 'xs', align: 'end', color: '#444444' },
      ],
    });
  }

  bodyContents.push({ type: 'separator', margin: 'md' });
  bodyContents.push({
    type: 'text',
    text: '年繳保費合計',
    size: 'xs',
    color: '#888888',
    margin: 'md',
  });

  for (const [cur, total] of Object.entries(byCurrency)) {
    bodyContents.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'xs',
      contents: [
        { type: 'text', text: cur, size: 'sm', color: '#555555', flex: 0 },
        {
          type: 'text',
          text: `${numberWithCommas(Math.round(total))} 元`,
          size: 'sm',
          weight: 'bold',
          align: 'end',
          color: '#3D5AFE',
        },
      ],
    });
  }

  const headerText = isFirstTime
    ? `✅ 綁定成功！歡迎 ${clientName}`
    : `📋 ${clientName} 的保單摘要`;

  return {
    type: 'flex',
    altText: `${clientName} 的保單摘要（${policies.length} 張）`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#3D5AFE',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: headerText,
            size: 'sm',
            color: '#FFFFFF',
            weight: 'bold',
            wrap: true,
          },
          {
            type: 'text',
            text: '有效保單',
            size: 'xxs',
            color: '#C5CAE9',
            margin: 'xs',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingAll: '16px',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#3D5AFE',
            height: 'sm',
            action: {
              type: 'message',
              label: '詢問業務員',
              text: '我想了解我的保單詳情',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: '理賠流程查詢',
              text: '請問理賠需要準備哪些資料？',
            },
          },
        ],
      },
    },
  };
}

// ── 工具函式 ──────────────────────────────────────────────────

function maskId(idNumber) {
  if (!idNumber) return '';
  if (idNumber.length <= 4) return idNumber;
  // 只顯示首1碼和末4碼
  return idNumber[0] + '******' + idNumber.slice(-4);
}

function numberWithCommas(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = {
  startPolicyQuery,
  handleBindingText,
  handleBindingPostback,
  getState,
};
