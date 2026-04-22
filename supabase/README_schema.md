# 保單資料庫 Schema 說明

## 資料表架構

```
customer_profiles          ← 客戶總表（LINE user_id 綁定在這裡）
      ↓ 1:N
customer_policies          ← 保單主表（全部保單都在這張表）
```

## customer_profiles（客戶總表）

| 欄位 | 說明 |
|------|------|
| client_name | 客戶姓名（FintechGo 保單客戶姓名） |
| client_id_number | 身分證/統編 |
| **line_user_id** | LINE userId，Bot 查詢靠這個 |
| phone / email | 聯絡資訊（選填） |

## customer_policies（保單主表）

| 分類 | 欄位 |
|------|------|
| 識別 | fintechgo_uuid, policy_type (T/S/I/P) |
| 基本 | policy_number, policy_name, policy_status, insurance_company |
| 當事人 | owner_name, insured_name, beneficiary_name |
| 日期 | effective_date, receipt_date, application_date |
| 保費 | main_premium, lifetime_rider_prem, term_rider_prem, waiver_prem |
| 繳費 | payment_years, payment_frequency, deduction_method |
| 壽險 | life_whole_amount, life_term_amount |
| 保障明細 | medical_coverage, accident_coverage, critical_coverage, disability_coverage, ltc_coverage, cancer_coverage（JSONB） |
| 帳戶價值 | account_value（JSONB：age_60～age_100） |

## JSONB 格式範例

```json
// medical_coverage
[
  {"type": "住院日額(終身)", "amount": 1000},
  {"type": "住院日額(定期)", "amount": 2000, "max_renewal_age": 75, "receipt": 0}
]

// account_value
{"age_60": 120000, "age_65": 180000, "age_70": 250000}
```

## Views

| View | 用途 |
|------|------|
| v_line_user_policies | 透過 LINE user_id 查所有保單（Bot 主要用這個） |
| v_client_premium_summary | 依客戶/險種彙總保費 |

## 使用步驟

### 1. 在 Supabase 執行 Schema
到 Supabase → SQL Editor，貼上 `schema_customer_policies.sql` 執行。

### 2. 匯入 XLS 資料
```bash
cd line-bot
pip install requests pandas python-dotenv openpyxl --break-system-packages
python3 supabase/import_policies.py fintechgo-policy.xls
```

### 3. 綁定 LINE user_id
當客戶傳訊息給 Bot 時，後端可讓客戶輸入姓名，然後更新 customer_profiles：
```sql
UPDATE customer_profiles
SET line_user_id = 'Uxxxxxxxxxxxxxxxx'
WHERE client_name = '林沛利';
```

### 4. Bot 查詢範例
```javascript
// app.js 中查詢客戶保單
const { data } = await supabase
  .from('v_line_user_policies')
  .select('*')
  .eq('line_user_id', userId)
  .eq('policy_status', 1);
```
