/**
 * scrape_gishpher.js
 * 自動登入詹鋒保險後台，爬取壽險保單查詢，並同步至 Supabase
 *
 * 前置作業：
 *   1. npm install playwright uuid
 *   2. npx playwright install chromium
 *   3. 在 .env 加入：
 *        GISHPHER_USERNAME=你的帳號
 *        GISHPHER_PASSWORD=你的密碼
 *
 * 執行：
 *   node scrape_gishpher.js           → 爬取 + 同步 Supabase
 *   node scrape_gishpher.js --dry-run → 只爬取，印出結果，不寫 Supabase
 */

const { chromium } = require('playwright');
const { v5: uuidv5 } = require('uuid');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ── 設定 ──────────────────────────────────────────────────────
const BASE_URL    = 'https://gishpher.ice.com.tw';
const USERNAME    = process.env.GISHPHER_USERNAME;
const PASSWORD    = process.env.GISHPHER_PASSWORD;
const DRY_RUN     = process.argv.includes('--dry-run');
const HEADLESS    = !process.argv.includes('--visible'); // --visible 顯示瀏覽器
const OUTPUT_FILE = path.join(__dirname, 'data', 'gishpher_raw.json');

// UUID namespace（固定，確保同一保單每次產生相同 UUID）
const NS = '3b6a27bc-b0c4-4c1a-b3e0-9f5d31a0cfb5';

// ── 日期轉換（民國年 115/04/09 → 2026-04-09）──────────────────
function parseROCDate(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  // 格式：YYY/MM/DD 或 YYY-MM-DD
  const m = s.match(/^(\d{2,3})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const y = parseInt(m[1]) + 1911;
  const mo = m[2].padStart(2, '0');
  const d  = m[3].padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// ── 保單狀況轉數字 ────────────────────────────────────────────
function parseStatus(statusText) {
  const s = (statusText || '').trim();
  if (s === '有效')   return 1;
  if (s === '照單中') return 1; // 受理中，視為有效
  if (s === '失效' || s === '停效') return 0;
  return 1; // 預設有效
}

// ── 繳別轉頻率代碼 ────────────────────────────────────────────
function parseFreq(freqText) {
  const s = (freqText || '').trim();
  if (s === '年' || s === '年繳') return 3;
  if (s === '半' || s === '半年') return 4;
  if (s === '季' || s === '季繳') return 2;
  if (s === '月' || s === '月繳') return 1;
  if (s === '躉' || s === '躉繳') return 0;
  return 3;
}

// ── 扣款方式轉代碼（smallint）────────────────────────────────
function parseDeductionMethod(str) {
  const s = (str || '').trim();
  if (s === '轉帳' || s === '銀行轉帳') return 1;
  if (s === '信用卡') return 2;
  if (s === '支票') return 3;
  if (s === 'ATM') return 4;
  if (s === '現金') return 5;
  if (s === '自動扣款') return 1;
  if (!s || s === '-') return null;
  return null; // 未知的不寫入，避免型別錯誤
}

// ── 金額解析 ─────────────────────────────────────────────────
function parseAmount(str) {
  if (!str || str.trim() === '' || str.trim() === '-') return null;
  const n = parseFloat(str.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ── 從附約名稱推斷保障類別 ────────────────────────────────────
function buildCoverageArrays(policyName, riderLines) {
  const allNames = [policyName || '', ...(riderLines || [])].join(' ');

  function matches(keywords) {
    return keywords.some(kw => allNames.includes(kw));
  }

  // 每個 coverage 欄存附約名稱陣列（若有）；無附約則存空陣列
  const riders = riderLines || [];

  const medicalRiders    = riders.filter(r => /醫療|醫卡|住院|手術|實支|醫靠/.test(r));
  const accidentRiders   = riders.filter(r => /意外|傷害/.test(r));
  const criticalRiders   = riders.filter(r => /重大傷病|重大疾病|重疾|特定/.test(r));
  const disabilityRiders = riders.filter(r => /失能|殘廢/.test(r));
  const ltcRiders        = riders.filter(r => /長照|長期看護|長期照顧/.test(r));
  const cancerRiders     = riders.filter(r => /癌症|惡性腫瘤/.test(r));

  // 若主約本身就是醫療/意外等類型，也標記
  const pn = policyName || '';
  if (/醫療|醫靠|醫卡|住院/.test(pn) && medicalRiders.length === 0)    medicalRiders.push(pn);
  if (/意外|傷害/.test(pn)           && accidentRiders.length === 0)   accidentRiders.push(pn);
  if (/重大傷病|重大疾病/.test(pn)   && criticalRiders.length === 0)   criticalRiders.push(pn);
  if (/失能|殘廢/.test(pn)           && disabilityRiders.length === 0) disabilityRiders.push(pn);
  if (/長照|長期照顧/.test(pn)       && ltcRiders.length === 0)        ltcRiders.push(pn);
  if (/癌症|惡性腫瘤/.test(pn)       && cancerRiders.length === 0)     cancerRiders.push(pn);

  return {
    medical_coverage:     medicalRiders,
    accident_coverage:    accidentRiders,
    critical_coverage:    criticalRiders,
    disability_coverage:  disabilityRiders,
    ltc_coverage:         ltcRiders,
    cancer_coverage:      cancerRiders,
  };
}

// ── 保單類型推斷（T=傳統, S=儲蓄, I=投資型）─────────────────
// 注意：DB check constraint 只允許 T/S/I/P，不可使用其他值
function inferPolicyType(policyName) {
  const n = policyName || '';
  if (/變額|投資型|投連/.test(n))               return 'I';
  if (/年金|儲蓄|增值|利率變動|萬能壽/.test(n))  return 'S';
  return 'T'; // 定期/傳統/醫療/意外 等都歸 T
}

// ── 建立 Supabase 行 ──────────────────────────────────────────
function buildRow(raw) {
  const uuid = uuidv5(`${raw.insurance_company}|${raw.policy_number}`, NS);
  const coverage = buildCoverageArrays(raw.policy_name, raw.rider_lines);
  return {
    fintechgo_uuid:       uuid,
    policy_type:          inferPolicyType(raw.policy_name),
    client_name:          raw.owner_name,
    client_id_number:     raw.owner_id,
    policy_number:        raw.policy_number,
    policy_name:          raw.policy_name || null,
    policy_status:        parseStatus(raw.policy_status),
    insurance_company:    raw.insurance_company,
    owner_name:           raw.owner_name,
    owner_id_number:      raw.owner_id,
    insured_name:         raw.insured_name,
    insured_id_number:    raw.insured_id,
    effective_date:       parseROCDate(raw.effective_date),
    receipt_date:         parseROCDate(raw.receipt_date),
    application_date:     parseROCDate(raw.application_date),
    currency:             1,
    main_premium:         parseAmount(raw.main_premium),
    payment_frequency:    parseFreq(raw.payment_freq),
    deduction_method:     parseDeductionMethod(raw.payment_method),
    term_rider_prem:      parseAmount(raw.rider_premium),
    ...coverage,
    account_value:        {},
  };
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('❌ 請先在 .env 設定 GISHPHER_USERNAME 和 GISHPHER_PASSWORD');
    process.exit(1);
  }

  console.log(`🚀 啟動瀏覽器（headless: ${HEADLESS}）...`);
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 50 : 50,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled', // 避免被偵測為 bot
      '--disable-dev-shm-usage',
    ],
  });
  const ctx  = await browser.newContext({
    locale: 'zh-TW',
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  // ── Step 1: 登入 ────────────────────────────────────────────
  console.log('🔐 登入中...');
  await page.goto(`${BASE_URL}/Login`, { waitUntil: 'networkidle' });
  // 確保頁面完全渲染（headless 下可能需要額外等待）
  await page.waitForTimeout(1500);

  // 嘗試多種 selector 找帳號欄
  const usernameSelectors = ['input[name="username"]', 'input[name="account"]', 'input[name="UserName"]',
                              'input[type="text"]', 'input[placeholder*="帳號"]', 'input[placeholder*="Account"]'];
  const passwordSelectors = ['input[name="password"]', 'input[name="Password"]', 'input[type="password"]'];

  let filled = false;
  for (const sel of usernameSelectors) {
    try {
      await page.fill(sel, USERNAME, { timeout: 2000 });
      filled = true;
      console.log(`  帳號欄：${sel}`);
      break;
    } catch {}
  }
  if (!filled) { console.error('❌ 找不到帳號輸入欄'); await browser.close(); process.exit(1); }

  for (const sel of passwordSelectors) {
    try {
      await page.fill(sel, PASSWORD, { timeout: 2000 });
      console.log(`  密碼欄：${sel}`);
      break;
    } catch {}
  }

  // 送出登入
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
    page.keyboard.press('Enter'),
  ]);

  // 確認登入成功
  const url = page.url();
  if (url.includes('Login') || url.includes('login')) {
    console.error('❌ 登入失敗，請確認帳號密碼');
    await browser.close();
    process.exit(1);
  }
  console.log('✅ 登入成功');

  // ── Step 2: 進入壽險保單查詢 ─────────────────────────────────
  console.log('📋 導航至壽險保單查詢...');
  try {
    await page.click('text=壽險保單查詢', { timeout: 8000 });
    await page.waitForSelector('table', { timeout: 10000 });
  } catch {
    // 也許需要先展開選單
    try {
      await page.click('text=壽險專區', { timeout: 5000 });
      await page.click('text=壽險保單查詢', { timeout: 5000 });
      await page.waitForSelector('table', { timeout: 10000 });
    } catch (e) {
      console.error('❌ 找不到壽險保單查詢頁面:', e.message);
      await browser.close();
      process.exit(1);
    }
  }
  console.log('✅ 已進入壽險保單查詢');

  // ── Step 3: 嘗試調整每頁筆數為最大 ───────────────────────────
  // DevExpress Blazor 不用 <select>，改用自定義組件
  // 先試 native select，再試點擊 dxbl 組件
  const pageSizeChanged = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('select')];
    for (const sel of selects) {
      const opts = [...sel.options].map(o => o.value.trim()).filter(v => /^\d+$/.test(v));
      if (opts.length > 0) {
        const maxVal = Math.max(...opts.map(Number));
        if (maxVal > 15) {
          sel.value = String(maxVal);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return maxVal;
        }
      }
    }
    return 0;
  });
  if (pageSizeChanged) {
    console.log(`📄 每頁筆數設為 ${pageSizeChanged}，等待重新載入...`);
    await page.waitForTimeout(2000);
  } else {
    // 嘗試用 DevExpress Blazor page size 下拉（dxbl-select 或 combobox）
    try {
      const pageSizeInput = page.locator('dxbl-pager input, dxbl-select input, [aria-label*="Page size"], [aria-label*="per page"]').first();
      if (await pageSizeInput.isVisible({ timeout: 2000 })) {
        await pageSizeInput.selectOption?.({ label: '50' }).catch(() => {});
      }
    } catch {}
  }

  // ── 取得總頁數（支援 DevExpress Blazor dxbl-pager）──────────────
  const totalPages = await page.evaluate(() => {
    // DevExpress Blazor：在 dxbl-pager 內找頁碼輸入框的 aria-label "Page X of Y"
    const pager = document.querySelector('dxbl-pager');
    if (pager) {
      // 找 input 的 aria-label
      const input = pager.querySelector('input');
      if (input) {
        const lbl = input.getAttribute('aria-label') || '';
        const m = lbl.match(/of\s+(\d+)/i);
        if (m) return parseInt(m[1]);
      }
      // 找 "Page X of Y" 文字節點
      const text = pager.innerText || '';
      const m2 = text.match(/of\s+(\d+)/i);
      if (m2) return parseInt(m2[1]);
    }
    // Fallback：body 文字
    const allText = document.body.innerText;
    const m = allText.match(/of\s+(\d+)/);
    if (m) return parseInt(m[1]);
    // Fallback：找頁碼按鈕
    const btns = [...document.querySelectorAll('button[aria-label]')];
    const pageNums = btns
      .map(b => b.getAttribute('aria-label') || '')
      .map(l => { const m = l.match(/^Page (\d+)$/); return m ? parseInt(m[1]) : 0; })
      .filter(n => n > 0);
    if (pageNums.length) return Math.max(...pageNums);
    // 最後 fallback：找所有數字按鈕
    const allBtns = [...document.querySelectorAll('button, a, span')];
    const nums = allBtns.map(el => parseInt(el.textContent.trim())).filter(n => !isNaN(n) && n > 0 && n < 9999);
    return nums.length ? Math.max(...nums) : 1;
  });
  console.log(`📋 總頁數：${totalPages}`);

  // ── Step 4: 爬取所有頁面 ─────────────────────────────────────
  const NO_EXPAND  = process.argv.includes('--no-expand');
  const DBG_EXPAND = process.argv.includes('--debug-expand');
  const allRaw = [];
  let pageNum = 1;

  while (true) {
    await page.waitForTimeout(800);
    console.log(`  爬取第 ${pageNum} / ${totalPages} 頁...`);

    // ── 取得本頁所有主列基本資料（不展開，過濾巢狀 tr）──────────
    // 關鍵：用 .closest() 排除 detail cell 內的巢狀 table 的 tr
    const initialRows = await page.evaluate(() =>
      [...document.querySelectorAll('table tbody tr')]
        .filter(tr => {
          if (tr.closest('td.dxbl-grid-detail-cell')) return false; // 排除巢狀 tr
          if (tr.className.includes('empty-row') || tr.className.includes('footer')) return false;
          if (tr.querySelector('td.dxbl-grid-detail-cell')) return false; // detail row 本身
          return tr.querySelectorAll('td').length >= 5;
        })
        .map(tr => {
          const tds = [...tr.querySelectorAll('td')];
          const texts = tds.map(td => (td.innerText || '').trim());
          const offset = !!tds[0]?.querySelector('button') ? 1 : 0;
          return { hasExpandBtn: !!tds[0]?.querySelector('button'), texts, offset };
        })
    );

    // ── 逐列展開（DevExpress 是單列展開模式，批次點擊只留最後一列）
    const pageRows = [];
    let nameCount = 0;
    for (const info of initialRows) {
      const { texts, offset, hasExpandBtn } = info;
      const policyNumber = texts[2 + offset] || '';

      const row = {
        application_date:  texts[0 + offset] || '',
        insurance_company: texts[1 + offset] || '',
        policy_number:     policyNumber,
        owner_name:        texts[3 + offset] || '',
        owner_id:          texts[4 + offset] || '',
        insured_name:      texts[5 + offset] || '',
        insured_id:        texts[6 + offset] || '',
        policy_status:     texts[7 + offset] || '',
        effective_date:    texts[8 + offset] || '',
        issue_date:        texts[9 + offset] || '',
        receipt_date:      texts[10 + offset] || '',
        payment_freq:      texts[11 + offset] || '',
        payment_method:    texts[12 + offset] || '',
        main_premium:      texts[13 + offset] || '',
        rider_premium:     texts[14 + offset] || '',
        policy_name:       null,
        rider_lines:       [],
      };

      if (!NO_EXPAND && hasExpandBtn && policyNumber) {
        // 點擊本列展開按鈕（依保單號碼精確定位，不受 DevExpress 重排影響）
        await page.evaluate((polNum) => {
          const trs = [...document.querySelectorAll('table tbody tr')]
            .filter(tr => !tr.closest('td.dxbl-grid-detail-cell'));
          for (const tr of trs) {
            const tds = [...tr.querySelectorAll('td')];
            if (tds.length < 5) continue;
            const texts = tds.map(td => td.innerText.trim());
            const off = !!tds[0]?.querySelector('button') ? 1 : 0;
            if (texts[2 + off] === polNum) {
              const btn = tds[0]?.querySelector('button');
              if (btn) { btn.click(); break; }
            }
          }
        }, policyNumber);

        // 等 Blazor 渲染 detail row（~500–700ms）
        await page.waitForTimeout(650);

        // 取該列下方的 detail cell 文字
        const detailText = await page.evaluate((polNum) => {
          const trs = [...document.querySelectorAll('table tbody tr')]
            .filter(tr => !tr.closest('td.dxbl-grid-detail-cell'));
          for (let i = 0; i < trs.length; i++) {
            const tds = [...trs[i].querySelectorAll('td')];
            if (tds.length < 5) continue;
            const texts = tds.map(td => td.innerText.trim());
            const off = !!tds[0]?.querySelector('button') ? 1 : 0;
            if (texts[2 + off] !== polNum) continue;
            const next = trs[i + 1];
            const cell = next?.querySelector('td.dxbl-grid-detail-cell, td[aria-label="Cell with details"]');
            return cell?.innerText || null;
          }
          return null;
        }, policyNumber);

        if (detailText) {
          const productIdx = detailText.indexOf('投保商品');
          if (productIdx >= 0) {
            const productText = detailText.slice(productIdx);
            // 主約商品名稱：大寫英數商品代號 → 中文名稱 → 年期數字
            const mainIdx = productText.indexOf('主約');
            if (mainIdx >= 0) {
              const nameMatch = productText.slice(mainIdx).match(
                /[A-Z][A-Z0-9]{1,6}\s+([\u4e00-\u9fff（）()A-Za-z\s·－\-]+?)\s+\d{1,3}\s+[\d,\-]/
              );
              if (nameMatch) { row.policy_name = nameMatch[1].trim(); nameCount++; }
            }
            // 附約名稱
            const riderIdx = productText.indexOf('附約');
            if (riderIdx >= 0) {
              const riderMatches = [...productText.slice(riderIdx + 2).matchAll(
                /[A-Z][A-Z0-9]{1,6}\s+([\u4e00-\u9fff（）()A-Za-z\s·－\-]+?)\s+\d{1,3}\s+[\d,\-]/g
              )];
              row.rider_lines = riderMatches.map(m => m[1].trim()).filter(Boolean);
            }
          }
        }
      }

      pageRows.push(row);
    }

    allRaw.push(...pageRows);
    console.log(`    本頁 ${pageRows.length} 筆（含保單名稱：${nameCount} 筆）`);

    // 已爬完所有頁？
    if (pageNum >= totalPages) break;

    // ── DEBUG: 印出翻頁區域 HTML（只在第 1 頁做一次）────────────────
    if (pageNum === 1 && process.argv.includes('--debug-pager')) {
      const pagerHtml = await page.evaluate(() => {
        const candidates = [
          document.querySelector('dxbl-pager'),
          document.querySelector('[class*="pager"]'),
          document.querySelector('[class*="pagination"]'),
          document.querySelector('nav'),
        ].filter(Boolean);
        return candidates.map(el => ({
          tag: el.tagName,
          class: el.className,
          html: el.outerHTML.slice(0, 3000),
        }));
      });
      console.log('\n🔍 翻頁區域 HTML：');
      pagerHtml.forEach((h, i) => console.log(`\n[候選 ${i + 1}] ${h.tag}.${h.class}:\n${h.html}`));
      // 也印出所有 aria-label 含 "page" 的按鈕
      const ariaButtons = await page.evaluate(() =>
        [...document.querySelectorAll('button[aria-label]')]
          .map(b => ({ label: b.getAttribute('aria-label'), disabled: b.disabled, class: b.className }))
      );
      console.log('\n🔍 所有 aria-label 按鈕：', JSON.stringify(ariaButtons, null, 2));
      process.exit(0);
    }

    // ── 翻到下一頁：DevExpress Blazor 用 aria-label="Next page" ──
    // 策略 1：aria-label（DevExpress Blazor 標準）
    const nextBtnLocator = page.locator('button[aria-label="Next page"]');
    const nextBtnCount = await nextBtnLocator.count();

    if (nextBtnCount > 0) {
      const isDisabled = await nextBtnLocator.evaluate(el =>
        el.disabled || el.classList.contains('dxbl-disabled')
      ).catch(() => true);

      if (isDisabled) {
        console.log('  ✅ 已到最後一頁（Next page 按鈕已 disabled）');
        break;
      }
      await nextBtnLocator.click();
      console.log('  (翻頁策略: aria-label)');
    } else {
      // 策略 2：頁碼 input 直接填下一頁（DevExpress 有時有輸入框）
      const pageInput = page.locator('dxbl-pager input, input[aria-label*="Page"]').first();
      if (await pageInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        await pageInput.click({ clickCount: 3 }).catch(async () => {
          await pageInput.click();
          await pageInput.press('Control+A');
        });
        await pageInput.fill(String(pageNum + 1));
        await pageInput.press('Enter');
        console.log('  (翻頁策略: page input)');
      } else {
        // 策略 3：JS 直接找 Next page 按鈕（含 shadow DOM 情況）
        const jsClicked = await page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Next page"]');
          if (btn && !btn.disabled && !btn.classList.contains('dxbl-disabled')) {
            btn.click();
            return true;
          }
          return false;
        });
        if (jsClicked) {
          console.log('  (翻頁策略: JS click aria-label)');
        } else {
          console.log('  ⚠️ 找不到翻頁按鈕，停止');
          break;
        }
      }
    }

    // 等待頁面資料更新（等 table 穩定，DevExpress 用 networkidle）
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    pageNum++;
  }

  await browser.close();

  console.log(`\n✅ 共爬取 ${allRaw.length} 筆原始資料`);

  // ── Step 5: 儲存原始資料 ─────────────────────────────────────
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allRaw, null, 2), 'utf-8');
  console.log(`💾 原始資料已儲存：${OUTPUT_FILE}`);

  if (DRY_RUN) {
    console.log('\n[dry-run] 不寫入 Supabase，以下是前 3 筆原始資料：');
    allRaw.slice(0, 3).forEach((r, i) => {
      console.log(`\n[${i + 1}] ${r.owner_name} / ${r.insurance_company} / ${r.policy_number}`);
      console.log(`  保單名稱: ${r.policy_name || '（未取得）'}`);
      console.log(`  附約行數: ${r.rider_lines?.length || 0}`);
      if (r.rider_lines?.length) console.log('  附約內容:', r.rider_lines.slice(0, 5).join(' | '));
      console.log('  DB row:', JSON.stringify(buildRow(r), null, 2));
    });
    return;
  }

  // ── Step 6: 同步至 Supabase ───────────────────────────────────
  const sb = require('./supabaseClient');
  if (!sb) { console.error('❌ supabaseClient 未設定'); return; }

  console.log('\n📡 同步至 Supabase...');
  const rows = allRaw
    .filter((r) => r.policy_number && r.insurance_company)
    .map(buildRow);

  // 分批 upsert（每批 50 筆）
  const BATCH = 50;
  let inserted = 0, updated = 0, errors = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from('customer_policies')
      .upsert(batch, { onConflict: 'fintechgo_uuid', ignoreDuplicates: false });
    if (error) {
      console.error(`  ❌ 批次 ${i / BATCH + 1} 失敗:`, error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
      process.stdout.write(`  ✅ ${Math.min(i + BATCH, rows.length)} / ${rows.length}\r`);
    }
  }

  // 嘗試補上 customer_id 關聯（透過 RPC，若無則略過）
  console.log('\n🔗 更新 customer_id 關聯...');
  try {
    const { error: rpcErr } = await sb.rpc('link_policies_to_profiles');
    if (rpcErr) {
      console.log('  ⚠️  RPC 不存在，請在 Supabase SQL Editor 手動執行：');
      console.log('     UPDATE customer_policies p SET customer_id = c.id');
      console.log('     FROM customer_profiles c');
      console.log("     WHERE p.client_name = c.client_name AND p.customer_id IS NULL;");
    } else {
      console.log('  ✅ customer_id 關聯更新完成');
    }
  } catch (e) {
    console.log('  ⚠️  RPC 略過（未設定）');
  }

  console.log('\n════════════════════════════════════');
  console.log(`✅ 完成！寫入：${inserted} 筆，錯誤：${errors} 筆`);
  console.log('════════════════════════════════════');
}

main().catch((err) => {
  console.error('❌ 執行失敗:', err.message);
  process.exit(1);
});
