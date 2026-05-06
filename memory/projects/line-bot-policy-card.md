# 保單卡片設定（黃金版本 v2.0）

> 確認日期：2026-04-24
> 狀態：✅ 全流程測試通過（綁定 / 查詢 / 解除綁定 / 重新驗證），此為還原基準版本

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

## 解除綁定流程（✅ 已測試通過 v2.0）

### 設計原則：Stateless（不依賴 in-memory state）
Render 每次重部署會清空 bindingState Map，所以解綁流程完全不依賴 state。

### 流程
1. 用戶輸入「解綁／解除綁定／取消綁定／取消帳號」
2. app.js regex 攔截 → 呼叫 `policyBinding.startUnbindFlow(userId)` → 回傳紅色確認 Flex
3. Flex 卡片上「確認解除」按鈕：**message action**，傳送文字「確認解除綁定」
4. app.js 收到文字「確認解除綁定」→ **精確比對（在 regex 之前）** → 查 Supabase → 清除 line_user_id → 回覆成功訊息
5. 用戶再輸入「我的保單」→ `getProfileByLineId` 查不到 → 進入驗證流程（姓名輸入）

### app.js 關鍵字攔截順序（⚠️ 順序不能錯）
```
1. 查詢我的保單 / 我的保單 / 保單查詢 → startPolicyQuery
2. 「確認解除綁定」精確比對（===）→ 直接解綁   ← 必須在 regex 之前！
3. /取消綁定|解除綁定|解綁|取消帳號/ regex → startUnbindFlow（顯示確認卡）
4. getState(userId) → handleBindingText（進行中的流程）
5. 各功能按鈕關鍵字
6. AI 回覆
```

### ⚠️ 若「確認解除綁定」放在 regex 之後，會無限輪迴出卡片（已修復）

### 按鈕設計
- 確認解除：`type: 'message', text: '確認解除綁定'`（不用 postback，避免 state 消失問題）
- 取消：`type: 'message', text: '取消'`

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
| 解綁無聲無回應（v1 bug）| `unbindLineUser` 漏加到 `supabasePolicies.js` 的 module.exports，導致呼叫時拋 TypeError。已修復（commit 58ce9f1）|
| 解綁後無限輪迴卡片（v1 bug）| 「確認解除綁定」文字命中 regex `/解除綁定/` 再次觸發卡片。修復：精確比對放在 regex 之前 |

---

## 架構備忘

- **LINE Bot**：跑在 Render.com（cloud），`git push` → 自動部署（1~2 分鐘）
- **本地 pm2**：只跑 `dashboard/server.js`（管理面板 port 3977），與 LINE bot 無關
- **in-memory state**（bindingState Map）：Render 重部署會清空 → 解綁流程必須 stateless
- **supabasePolicies.js 每次新增函式後記得加到 module.exports！**
