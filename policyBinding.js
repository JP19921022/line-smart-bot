/**
 * policyBinding.js
 * 客戶 LINE 帳號綁定保單流程
 *
 * 流程：
 *   1. 觸發「查詢我的保單」→ 檢查是否已綁定
 *   2. 未綁定 → 詢問姓名
 *   3. 姓名輸入 → 模糊比對 customer_profiles，列出候選
 *   4. 選擇確認（postback）→ 更新 line_user_id
 *   5. 綁定成功 → 顯示保單 Carousel（每張一張卡）
 *
 * postback 格式：
 *   policy_bind:confirm:<profileId>   — 確認綁定
 *   policy_bind:cancel                — 取消查詢
 *   policy_page:<page>                — 翻頁（page = 0-indexed）
 */

const supabasePolicies = require('./supabasePolicies');

// ── 常數對照表 ────────────────────────────────────────────────
const TYPE_MAP      = { T: '傳統', S: '儲蓄', I: '投資型', P: '產險' };
const TYPE_COLOR    = { T: '#3D5AFE', S: '#00897B', I: '#E65100', P: '#6A1B9A' };
const FREQ_MAP      = { 0: '彈性繳', 1: '月繳', 2: '季繳', 3: '年繳', 4: '半年繳' };
const DEDUCT_MAP    = { 1: '轉帳', 2: '信用卡' };

const CARDS_PER_PAGE = 9; // LINE carousel 上限 10，留 1 給「查看更多」

// ── 狀態機（in-memory）────────────────────────────────────────
// key: userId  value: { step, candidates?, policies?, clientName?, ts }
const bindingState = new Map();
const BINDING_TIMEOUT_MS = 10 * 60 * 1000; // 10 分鐘

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

// ── 取消綁定入口（不需要 state，直接查 Supabase）─────────────────
async function startUnbindFlow(userId) {
  const profile = await supabasePolicies.getProfileByLineId(userId);
  if (!profile) {
    return { type: 'text', text: '您目前尚未綁定任何帳號。' };
  }
  setState(userId, { step: 'waiting_unbind_confirm', clientName: profile.client_name });
  return buildUnbindConfirmFlex(profile.client_name);
}

// ── 入口：檢查是否已綁定，決定直接顯示或開始綁定 ───────────────
async function startPolicyQuery(userId) {
  const profile = await supabasePolicies.getProfileByLineId(userId);
  if (profile) {
    const policies = await supabasePolicies.getPoliciesByCustomerId(profile.id);
    // 快取保單供翻頁用
    setState(userId, { step: 'browsing', policies, clientName: profile.client_name });
    return buildPoliciesCarousel(profile.client_name, policies, 0);
  }

  // 未綁定 → 開始綁定流程
  setState(userId, { step: 'waiting_name' });
  return buildAskNameMessage();
}

// ── 處理文字輸入 ─────────────────────────────────────────────
async function handleBindingText(userId, text) {
  const state = getState(userId);
  if (!state) return null;

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

    setState(userId, { step: 'waiting_confirm', candidates, inputName: name });
    return buildConfirmCandidatesFlex(candidates, name);
  }

  if (state.step === 'waiting_confirm') {
    return {
      type: 'text',
      text: '請點選上方的按鈕確認您的身份 ☝️\n\n或輸入「取消」重新查詢。',
    };
  }

  // ── 解除綁定文字確認（雙重保險：postback + 文字都能觸發）──────
  if (state.step === 'waiting_unbind_confirm') {
    const t = text.trim();
    if (/^(確認|確認解除|解除|yes|y)$/i.test(t)) {
      const ok = await supabasePolicies.unbindLineUser(userId);
      clearState(userId);
      if (!ok) {
        return { type: 'text', text: '❌ 解除綁定失敗，請稍後再試或聯繫業務員。' };
      }
      return {
        type: 'text',
        text: '✅ 已成功解除綁定\n\n您的 LINE 帳號已與保單資料解除連結。\n如需重新綁定，請點選主選單「查詢我的保單」。',
      };
    }
    if (/^(取消|不|no|n)$/i.test(t)) {
      clearState(userId);
      return { type: 'text', text: '已取消，保持原綁定狀態。' };
    }
    return {
      type: 'text',
      text: `⚠️ 確認解除綁定？\n\n目前綁定帳號：${state.clientName || ''}\n\n請回覆：\n「確認」→ 解除綁定\n「取消」→ 保留綁定`,
    };
  }

  // ── 取消綁定觸發 ────────────────────────────────────────────
  if (/取消綁定|解除綁定|解綁|取消帳號/.test(text.trim())) {
    const profile = await supabasePolicies.getProfileByLineId(userId);
    if (!profile) {
      return { type: 'text', text: '您目前尚未綁定任何帳號。' };
    }
    setState(userId, { step: 'waiting_unbind_confirm' });
    return buildUnbindConfirmFlex(profile.client_name);
  }

  // ── 驗證手機 + 身分證 ─────────────────────────────────────────
  if (state.step === 'waiting_verification') {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      return {
        type: 'text',
        text: '請輸入手機號碼和身分證字號，中間用空格分隔 😊\n\n格式範例：\n0912345678 A123456789',
      };
    }

    const [phone, idNumber] = parts;
    const verified = await supabasePolicies.verifyIdentity(state.profileId, phone, idNumber);

    if (!verified) {
      const attempts = (state.attempts || 0) + 1;
      if (attempts >= 3) {
        clearState(userId);
        return {
          type: 'text',
          text: '❌ 驗證失敗次數過多\n\n請重新點選主選單「查詢我的保單」，或聯繫業務員協助。',
        };
      }
      setState(userId, { ...state, attempts });
      return {
        type: 'text',
        text: `❌ 驗證失敗（第 ${attempts}/3 次）\n手機號碼或身分證字號不符\n\n請再試一次：\n手機號碼 身分證字號`,
      };
    }

    // ✅ 驗證成功 → 綁定 LINE user_id → 顯示保單
    const ok = await supabasePolicies.bindLineUser(state.profileId, userId);
    clearState(userId);
    if (!ok) {
      return { type: 'text', text: '綁定失敗，請稍後再試或聯繫業務員。' };
    }

    const profile = await supabasePolicies.getProfileById(state.profileId);
    const policies = await supabasePolicies.getPoliciesByCustomerId(state.profileId);
    setState(userId, { step: 'browsing', policies, clientName: profile?.client_name });
    return buildPoliciesCarousel(profile?.client_name || '您', policies, 0, true);
  }

  return null;
}

// ── 處理 postback ────────────────────────────────────────────
async function handleBindingPostback(userId, data) {
  // 翻頁
  if (data.startsWith('policy_page:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    const state = getState(userId);
    if (state && state.policies && state.policies.length > 0) {
      return buildPoliciesCarousel(state.clientName, state.policies, page);
    }
    // state 消失（伺服器重啟）→ 重新查詢，回到第 0 頁
    const profile = await supabasePolicies.getProfileByLineId(userId);
    if (profile) {
      const policies = await supabasePolicies.getPoliciesByCustomerId(profile.id);
      if (policies.length > 0) {
        setState(userId, { step: 'browsing', policies, clientName: profile.client_name });
        return buildPoliciesCarousel(profile.client_name, policies, 0);
      }
    }
    return { type: 'text', text: '請重新點選「查詢我的保單」來查看保單列表。' };
  }

  // ── 解除綁定 postback ──────────────────────────────────────
  if (data === 'policy_unbind:confirm') {
    const ok = await supabasePolicies.unbindLineUser(userId);
    clearState(userId);
    if (!ok) {
      return { type: 'text', text: '❌ 解除綁定失敗，請稍後再試或聯繫業務員。' };
    }
    return {
      type: 'text',
      text: '✅ 已成功解除綁定\n\n您的 LINE 帳號已與保單資料解除連結。\n如需重新綁定，請點選主選單「查詢我的保單」。',
    };
  }

  if (data === 'policy_unbind:cancel') {
    clearState(userId);
    return { type: 'text', text: '已取消，保持原綁定狀態。' };
  }

  if (!data.startsWith('policy_bind:')) return null;

  if (data === 'policy_bind:cancel') {
    clearState(userId);
    return { type: 'text', text: '已取消查詢。如需再次查詢，請點選主選單「查詢我的保單」。' };
  }

  const parts = data.split(':');
  if (parts[1] === 'confirm' && parts[2]) {
    const profileId = parts[2];
    // 進入驗證步驟，不立即綁定
    const curState = getState(userId);
    setState(userId, {
      step: 'waiting_verification',
      profileId,
      inputName: curState?.inputName,
      attempts: 0,
    });
    return buildVerificationRequest();
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
// Flex Message 建構
// ══════════════════════════════════════════════════════════════

function buildAskNameMessage() {
  return {
    type: 'text',
    text: '📋 查詢保單\n\n請輸入您的姓名，我來幫您找保單資料 😊\n（例如：林小明）',
  };
}

function buildVerificationRequest() {
  return {
    type: 'flex',
    altText: '🔐 請完成身份驗證',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1A237E',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: '🔐 身份驗證', color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: '為保護您的保單資料安全', color: '#BBDEFB', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'md',
        contents: [
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '📱', size: 'md', flex: 0 },
              { type: 'text', text: '手機號碼', size: 'sm', color: '#333333', weight: 'bold', flex: 1 },
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'text', text: '🪪', size: 'md', flex: 0 },
              { type: 'text', text: '身分證字號', size: 'sm', color: '#333333', weight: 'bold', flex: 1 },
            ],
          },
          { type: 'separator' },
          {
            type: 'text',
            text: '請在下方輸入（空格分隔）：\n0912345678 A123456789',
            size: 'xs',
            color: '#666666',
            wrap: true,
          },
        ],
      },
    },
  };
}

// ── 候選清單：確認身份 ─────────────────────────────────────────
function buildConfirmCandidatesFlex(candidates, inputName) {
  const bubbles = candidates.slice(0, 5).map((c) => ({
    type: 'bubble',
    size: 'micro',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#3D5AFE',
      paddingAll: '10px',
      contents: [
        { type: 'text', text: '確認身份', size: 'xs', color: '#FFFFFF', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: [
        { type: 'text', text: c.client_name, size: 'lg', weight: 'bold', align: 'center', color: '#1A1A2E' },
        {
          type: 'text',
          text: c.client_id_number ? maskId(c.client_id_number) : '（無編號）',
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

  bubbles.push({
    type: 'bubble',
    size: 'micro',
    body: {
      type: 'box',
      layout: 'vertical',
      justifyContent: 'center',
      height: '100px',
      contents: [
        { type: 'text', text: '都不是\n我', size: 'md', color: '#888888', align: 'center', wrap: true },
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
    contents: { type: 'carousel', contents: bubbles },
  };
}

// ── 主角：保單 Carousel ────────────────────────────────────────
/**
 * 將保單清單轉成 Flex Carousel
 * page: 0-indexed
 * isFirstTime: 剛綁定時顯示歡迎
 */
function buildPoliciesCarousel(clientName, policies, page = 0, isFirstTime = false) {
  if (!policies || policies.length === 0) {
    return {
      type: 'text',
      text: isFirstTime
        ? `✅ 綁定成功！歡迎 ${clientName} 😊\n\n目前查無有效保單，請聯繫業務員。`
        : `${clientName} 目前查無有效保單，請聯繫業務員。`,
    };
  }

  const start = page * CARDS_PER_PAGE;
  const pageItems = policies.slice(start, start + CARDS_PER_PAGE);
  const hasMore = policies.length > start + CARDS_PER_PAGE;
  const remaining = policies.length - start - pageItems.length;

  const bubbles = pageItems.map((p) => buildPolicyCard(p));

  if (hasMore) {
    bubbles.push(buildMoreCard(page + 1, remaining));
  }

  // 防呆：若翻頁超界（bubbles 為空），從第 0 頁重新顯示
  if (bubbles.length === 0) {
    return buildPoliciesCarousel(clientName, policies, 0, false);
  }

  const altText = isFirstTime
    ? `✅ 綁定成功！${clientName} 共 ${policies.length} 張保單`
    : `${clientName} 的保單（${policies.length} 張）`;

  return {
    type: 'flex',
    altText,
    contents: { type: 'carousel', contents: bubbles },
  };
}

/** 建立單張保單卡片 */
function buildPolicyCard(p) {
  const typeName  = TYPE_MAP[p.policy_type]  || p.policy_type || '其他';
  const typeColor = TYPE_COLOR[p.policy_type] || '#3D5AFE';
  const isActive  = p.policy_status === 1;
  const statusText = isActive ? '有效' : '停效';

  const policyName  = p.policy_name || p.policy_category || '（未填保單名稱）';
  const effectDate  = formatROCDate(p.effective_date);
  const ownerName   = p.owner_name   || p.client_name || '—';
  const insuredName = p.insured_name || p.client_name || '—';
  const company     = p.insurance_company || '—';

  // ── raw_data（爬蟲詳細資料）────────────────────────────────
  const rd = (typeof p.raw_data === 'object' && p.raw_data !== null) ? p.raw_data : {};
  const products = Array.isArray(rd.products) ? rd.products : [];
  const mainProd = products.find(pp => pp.is_main) || products[0] || null;
  const riderProds = mainProd ? products.filter(pp => pp !== mainProd) : products.slice(1);

  // 繳別 / 繳費方式
  const freqText   = FREQ_MAP[p.payment_frequency]  ?? rd.payment_freq_text   ?? '—';
  const deductText = DEDUCT_MAP[p.deduction_method]  ?? rd.payment_method_text ?? '—';
  const paymentStr = [freqText, deductText].filter(s => s && s !== '—').join(' / ') || '—';

  // 年期
  const termStr = rd.main_product_term || mainProd?.term || '';
  const payYears = termStr === '終身' ? '終身' : (termStr ? termStr : (p.payment_years === 99 ? '終身' : (p.payment_years ? `${p.payment_years}年期` : '—')));

  // 商品代號
  const mainCode = rd.main_product_code || mainProd?.product_code || '';

  // 保額
  const rawAmt = p.policy_amount || (mainProd?.insured_amount ? parseFloat(String(mainProd.insured_amount).replace(/,/g, '')) : null);
  const amtUnit = p.policy_unit || mainProd?.insured_amount_unit || '元';
  const policyAmtStr = rawAmt ? `${numberWithCommas(Math.round(rawAmt))} ${amtUnit}` : '—';

  // 主約原始保費
  const origPremStr = rd.main_original_premium || mainProd?.original_premium || '';

  // 總保費合計
  const totalPremRaw = rd.total_premium;
  const calcTotal = (p.main_premium || 0) + (p.lifetime_rider_prem || 0) + (p.term_rider_prem || 0) + (p.waiver_prem || 0);
  const totalPremStr = totalPremRaw
    ? `${totalPremRaw} 元`
    : (calcTotal > 0 ? `${numberWithCommas(Math.round(calcTotal))} 元` : '—');

  // ── 基本欄位列表 ─────────────────────────────────────
  const infoRows = [
    { label: '保險公司', value: company },
    { label: '保單號碼', value: maskPolicyNumber(p.policy_number) },
    { label: '生效日期', value: effectDate },
    { label: '繳費',     value: paymentStr },
    { label: '要保人',   value: ownerName },
    { label: '被保人',   value: insuredName },
  ];

  const bodyContents = infoRows.map((row) => ({
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: row.label, size: 'xs', color: '#777777', flex: 3, wrap: false },
      { type: 'text', text: String(row.value), size: 'xs', color: '#111111', flex: 5, align: 'end', wrap: true },
    ],
  }));

  // ── 投保商品區塊 ──────────────────────────────────────
  bodyContents.push({ type: 'separator', margin: 'md' });

  // 主約
  if (mainProd) {
    const mainLabel = mainCode ? `主約 [${mainCode}]` : '主約';
    const mainName  = mainProd.product_name || policyName;
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: mainLabel, size: 'xs', color: '#3D5AFE', flex: 3, wrap: false, weight: 'bold' },
        { type: 'text', text: mainName,  size: 'xs', color: '#111111', flex: 5, align: 'end', wrap: true },
      ],
    });
    // 年期 / 保額
    const termAmt = [payYears !== '—' ? payYears : null, policyAmtStr !== '—' ? `保額 ${policyAmtStr}` : null].filter(Boolean).join('  ');
    if (termAmt) {
      bodyContents.push({
        type: 'text', text: termAmt, size: 'xxs', color: '#555555', margin: 'xs', align: 'end', wrap: true,
      });
    }
    // 原始保費
    if (origPremStr) {
      bodyContents.push({
        type: 'box', layout: 'horizontal', margin: 'xs',
        contents: [
          { type: 'text', text: '主約保費', size: 'xxs', color: '#888888', flex: 3 },
          { type: 'text', text: `${origPremStr} 元`, size: 'xxs', color: '#444444', flex: 5, align: 'end' },
        ],
      });
    }
  } else {
    // 沒有 products 資料，顯示舊式保額欄
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: '保額',   size: 'xs', color: '#777777', flex: 3 },
        { type: 'text', text: policyAmtStr, size: 'xs', color: '#111111', flex: 5, align: 'end' },
      ],
    });
    bodyContents.push({
      type: 'box', layout: 'horizontal', margin: 'sm',
      contents: [
        { type: 'text', text: '年期',   size: 'xs', color: '#777777', flex: 3 },
        { type: 'text', text: payYears, size: 'xs', color: '#111111', flex: 5, align: 'end' },
      ],
    });
  }

  // 附約列表
  if (riderProds.length > 0) {
    const riderNames = riderProds.slice(0, 6).map(r => {
      const code = r.product_code ? `[${r.product_code}]` : '';
      const amt  = r.insured_amount ? ` ${r.insured_amount}${r.insured_amount_unit || ''}` : '';
      return `${code} ${r.product_name || ''}${amt}`.trim();
    }).filter(Boolean);

    bodyContents.push({
      type: 'text', text: `附約（${riderProds.length}項）`,
      size: 'xxs', color: '#888888', margin: 'sm', weight: 'bold',
    });
    bodyContents.push({
      type: 'text', text: riderNames.join('\n'),
      size: 'xxs', color: '#444444', margin: 'xs', wrap: true,
    });
  } else {
    // fallback: 顯示保障範圍
    bodyContents.push(...buildCoverageSection(p));
  }

  // 總保費合計
  bodyContents.push({ type: 'separator', margin: 'md' });
  bodyContents.push({
    type: 'box', layout: 'horizontal', margin: 'sm',
    contents: [
      { type: 'text', text: '總保費合計', size: 'xs', color: '#333333', flex: 3, weight: 'bold' },
      { type: 'text', text: totalPremStr, size: 'xs', color: '#E65100', flex: 5, align: 'end', weight: 'bold' },
    ],
  });

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: typeColor,
      paddingAll: '12px',
      paddingBottom: '10px',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'box', layout: 'vertical',
              backgroundColor: '#FFFFFF40', cornerRadius: '4px',
              paddingStart: '6px', paddingEnd: '6px', paddingTop: '2px', paddingBottom: '2px',
              contents: [{ type: 'text', text: typeName, size: 'xxs', color: '#FFFFFF', weight: 'bold' }],
            },
            { type: 'filler' },
            {
              type: 'box', layout: 'vertical',
              backgroundColor: isActive ? '#43A047' : '#E53935', cornerRadius: '4px',
              paddingStart: '6px', paddingEnd: '6px', paddingTop: '2px', paddingBottom: '2px',
              contents: [{ type: 'text', text: statusText, size: 'xxs', color: '#FFFFFF', weight: 'bold' }],
            },
          ],
        },
        {
          type: 'text', text: policyName,
          size: 'sm', color: '#FFFFFF', weight: 'bold', wrap: true, margin: 'sm', maxLines: 3,
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      spacing: 'none',
      contents: bodyContents,
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '8px',
      paddingTop: '6px',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'message',
            label: '詢問業務員',
            text: `我想了解保單：${p.policy_name || p.policy_number || policyName}`,
          },
        },
      ],
    },
  };
}

/** 若有附約資料或保單名稱含保障關鍵字，補充一個保障區塊 */
function buildCoverageSection(p) {
  const riders = [];

  // 優先取 JSONB 附約資料
  if (hasData(p.medical_coverage))    riders.push('醫療');
  if (hasData(p.accident_coverage))   riders.push('意外');
  if (hasData(p.critical_coverage))   riders.push('重大傷病');
  if (hasData(p.disability_coverage)) riders.push('失能');
  if (hasData(p.ltc_coverage))        riders.push('長照');
  if (hasData(p.cancer_coverage))     riders.push('癌症');

  // 若 JSONB 無資料，從保單名稱關鍵字推斷保障類型
  if (riders.length === 0) {
    const name = (p.policy_name || '') + (p.policy_category || '');
    if (/重大傷病|重疾/.test(name))              riders.push('重大傷病');
    if (/癌症|防癌/.test(name))                  riders.push('癌症');
    if (/醫療|住院|實支/.test(name))             riders.push('醫療');
    if (/意外|傷害/.test(name))                  riders.push('意外');
    if (/失能|殘廢/.test(name))                  riders.push('失能');
    if (/長照|長期照護/.test(name))              riders.push('長照');
    if (/壽險|終身壽|定期壽/.test(name))         riders.push('壽險');
    if (/年金/.test(name))                        riders.push('年金');
    if (/儲蓄|利率變動|增額/.test(name))         riders.push('儲蓄');
  }

  if (riders.length === 0) return [];

  return [
    { type: 'separator', margin: 'md' },
    {
      type: 'text',
      text: '保障範圍',
      size: 'xxs',
      color: '#888888',
      margin: 'md',
      weight: 'bold',
    },
    {
      type: 'text',
      text: riders.join('・'),
      size: 'xxs',
      color: '#444444',
      margin: 'xs',
      wrap: true,
    },
  ];
}

function hasData(jsonbArr) {
  if (!jsonbArr) return false;
  if (Array.isArray(jsonbArr)) return jsonbArr.length > 0;
  return false;
}

/** 查看更多卡片 */
function buildMoreCard(nextPage, remaining) {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      justifyContent: 'center',
      paddingAll: '20px',
      contents: [
        {
          type: 'text',
          text: '📄',
          size: 'xxl',
          align: 'center',
        },
        {
          type: 'text',
          text: `還有 ${remaining} 張保單`,
          size: 'md',
          weight: 'bold',
          color: '#333333',
          align: 'center',
          margin: 'md',
        },
        {
          type: 'button',
          style: 'primary',
          color: '#3D5AFE',
          margin: 'lg',
          action: {
            type: 'postback',
            label: '查看更多',
            data: `policy_page:${nextPage}`,
            displayText: '查看更多保單',
          },
        },
      ],
    },
  };
}

// ══════════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════════

/** 遮蔽身分證號：只顯示首1碼+末4碼 */
function maskId(idNumber) {
  if (!idNumber || idNumber.length <= 4) return idNumber || '';
  return idNumber[0] + '******' + idNumber.slice(-4);
}

/** 遮蔽保單號碼：顯示後6碼，前面用 * */
function maskPolicyNumber(num) {
  if (!num) return '—';
  const s = String(num);
  if (s.length <= 6) return s;
  return '****' + s.slice(-6);
}

/** 西元日期轉民國年顯示 (YYYY-MM-DD → 民國N年M月D日) */
function formatROCDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const roc = d.getFullYear() - 1911;
    return `${roc}年${d.getMonth() + 1}月${d.getDate()}日`;
  } catch {
    return dateStr;
  }
}

/** 數字加千分位逗號 */
function numberWithCommas(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 解除綁定確認 Flex */
function buildUnbindConfirmFlex(clientName) {
  return {
    type: 'flex',
    altText: '確認解除 LINE 綁定',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#B71C1C',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: '⚠️ 解除綁定', color: '#FFFFFF', weight: 'bold', size: 'md' },
          { type: 'text', text: '確定要解除 LINE 帳號與保單的連結嗎？', color: '#FFCDD2', size: 'xs', margin: 'xs', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: `目前綁定帳號：${clientName}`,
            size: 'sm',
            color: '#333333',
            wrap: true,
          },
          {
            type: 'text',
            text: '解除後將無法查詢保單，如需重新使用需再次驗證身份。',
            size: 'xs',
            color: '#888888',
            wrap: true,
            margin: 'sm',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            flex: 1,
            action: {
              type: 'message',
              label: '取消',
              text: '取消',
            },
          },
          {
            type: 'button',
            style: 'primary',
            color: '#B71C1C',
            height: 'sm',
            flex: 1,
            action: {
              type: 'message',
              label: '確認解除',
              text: '確認',
            },
          },
        ],
      },
    },
  };
}

// ── 向外相容舊呼叫（app.js 可能直接呼叫舊函式名稱）────────────
// buildPolicySummaryFlex 保留別名
function buildPolicySummaryFlex(clientName, policies, isFirstTime = false) {
  return buildPoliciesCarousel(clientName, policies, 0, isFirstTime);
}

function buildBindingSuccessFlex(clientName, policies) {
  return buildPoliciesCarousel(clientName, policies, 0, true);
}

module.exports = {
  startPolicyQuery,
  startUnbindFlow,
  handleBindingText,
  handleBindingPostback,
  getState,
  // 若其他地方有直接引用
  buildPolicySummaryFlex,
};
