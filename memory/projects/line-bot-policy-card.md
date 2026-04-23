# 保單卡片設定（黃金版本 v1.0）

> 確認日期：2026-04-24
> 狀態：✅ 已確認正確、用戶滿意，此為還原基準版本

---

## 常數對照表

```javascript
const TYPE_MAP   = { T: '傳統', S: '儲蓄', I: '投資型', P: '產險' };
const TYPE_COLOR = { T: '#3D5AFE', S: '#00897B', I: '#E65100', P: '#6A1B9A' };
const FREQ_MAP   = { 0: '彈性繳', 1: '月繳', 2: '季繳', 3: '年繳', 4: '半年繳' };
const DEDUCT_MAP = { 1: '轉帳', 2: '信用卡' };
const CARDS_PER_PAGE = 9;
```

---

## 卡片結構（buildPolicyCard）

### Header
- 背景色：TYPE_COLOR[policy_type]
- 左上角：保單類型標籤（傳統/儲蓄/投資型）白字小框
- 右上角：狀態標籤（有效=綠#43A047 / 停效=紅#E53935）
- 主標題：policy_name（白字 sm bold，最多3行）

### Body 基本欄位（6行）
1. 保險公司
2. 保單號碼（遮蔽：`****` + 末6碼）
3. 生效日期（民國年格式）
4. 繳費（freqText / deductText，例：年繳 / 信用卡）
5. 要保人
6. 被保人

### Body 投保商品區塊（separator 後）
- **主約** `[商品代號]` 商品名稱
  - 年期 + 保額（例：20  保額 200,000 元）
  - 主約保費（元）
- **附約（N項）**（最多顯示6個）
  - 格式：`[CODE] 商品名稱 金額單位`
- 若無 products 資料 → fallback 顯示保障範圍（醫療/意外/重大傷病等）

### Body 總保費合計（separator 後）
- label：「總保費合計」（黑色 bold）
- value：橘色 #E65100 bold，優先用 `rd.total_premium`，fallback = main_premium + rider prems

### Footer
- 按鈕：「詢問業務員」（message action → 「我想了解保單：{policy_name}」）

---

## 翻頁卡片（buildMoreCard）
- 顯示「還有 N 張保單」
- 按鈕觸發 postback `policy_page:{nextPage}`

---

## 驗證流程

1. 輸入姓名 → 模糊搜尋 → 列出候選人
2. 點「是我！」→ postback `policy_bind:confirm:{profileId}`
3. 進入驗證：輸入「手機號碼 身分證字號」（空格分隔）
4. 最多 3 次機會
5. 驗證成功 → 綁定 LINE user_id → 顯示保單卡片

---

## 解除綁定流程

- **觸發關鍵字**（app.js message handler）：`/取消綁定|解除綁定|解綁|取消帳號/`
- 呼叫 `policyBinding.startUnbindFlow(userId)` → 紅色確認 Flex
- 確認按鈕 postback：`policy_unbind:confirm` → 呼叫 `supabasePolicies.unbindLineUser(userId)`
- 取消按鈕 postback：`policy_unbind:cancel` → 維持綁定

---

## Postback 路由（app.js handlePostbackEvent）

```javascript
if (data.startsWith('policy_bind:') ||
    data.startsWith('policy_page:') ||
    data.startsWith('policy_unbind:')) {
  const result = await policyBinding.handleBindingPostback(userId, data);
  if (result) return result;  // 不要在這裡呼叫 client.replyMessage！
}
```

**重要**：handlePostbackEvent 只 return result，由 handleEvent 統一呼叫 replyMessage。

---

## app.js 關鍵字攔截順序（handleEvent 內，在 AI 之前）

```
1. 查詢我的保單 / 我的保單 / 保單查詢 → startPolicyQuery
2. /取消綁定|解除綁定|解綁|取消帳號/ → startUnbindFlow
3. getState(userId) → handleBindingText（進行中的流程）
4. 各功能按鈕關鍵字
5. handleStructuredIntent
6. AI 回覆
```

---

## 資料更新流程（維護用）

用戶上傳新保單檔案後：
1. 執行 `node scrape_gishpher.js`（或指定 `--from-cache`）
2. 資料 upsert 進 Supabase `customer_policies`（key：`fintechgo_uuid`）
3. 確認 `customer_id` 有連結到 `customer_profiles`
4. push 到 GitHub → Render 自動部署（若有程式碼更動）

---

## 顯示篩選規則

- **只顯示**：policy_status = 1（有效、照單中、墊繳）
- **排除**：照會逾期取消、拒保、照會中、停效、繳清、未體檢、撤銷、失效 → policy_status = 0
- **排除保單類型**：P（產險）
- **排序**：effective_date DESC

---

## 已知問題與解法

| 問題 | 解法 |
|------|------|
| is_main 永遠 false | fallback 用 products[0] 當主約 |
| total_premium 永遠 null | fallback 用 main_premium + rider prems 加總 |
| Supabase URL 錯誤（local pm2 crash） | 正常，local 只跑 dashboard；bot 在 Render |
| deduction_method 違反 CHECK 約束 | parseDeductionMethod 只回 1/2/null |
