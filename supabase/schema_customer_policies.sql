-- ============================================================
--  FintechGo 保單資料庫 Schema
--  對應 V.POLICY.T.2.0 匯入範本（傳統/儲蓄/投資型/產險）
--  設計日期：2026-04-23
-- ============================================================

-- ─────────────────────────────────────────────────────────────
--  1. 客戶總表  customer_profiles
--     用來將 FintechGo 客戶姓名 / 編號對應到 LINE user_id
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_profiles (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FintechGo 客戶識別
  client_name          TEXT NOT NULL,             -- 保單客戶姓名
  client_id_number     TEXT,                      -- 保單客戶編號（身分證/統編）

  -- LINE 整合
  line_user_id         TEXT UNIQUE,               -- LINE userId（U開頭，用於 bot 查詢）

  -- 聯絡資訊（選填，可後續補上）
  phone                TEXT,
  email                TEXT,
  note                 TEXT,

  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- 唯一鍵：同一客戶姓名+編號只存一筆
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profiles_name_id
  ON customer_profiles (client_name, client_id_number);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_line
  ON customer_profiles (line_user_id);


-- ─────────────────────────────────────────────────────────────
--  2. 保單主表  customer_policies
--     直接對應 FintechGo XLS 108 欄位，coverage 細節壓縮為 JSONB
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_policies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── 來源識別 ──────────────────────────────────────────────
  fintechgo_uuid       TEXT UNIQUE,               -- Col 0：FintechGo 保單代號（UUID）
  policy_type          CHAR(1) NOT NULL            -- 保單類型：T=傳統 S=儲蓄 I=投資型 P=產險
                         CHECK (policy_type IN ('T','S','I','P')),

  -- ── 客戶關聯 ──────────────────────────────────────────────
  customer_id          UUID REFERENCES customer_profiles(id) ON DELETE SET NULL,
  client_name          TEXT NOT NULL,             -- Col 1：保單客戶姓名（冗餘方便查詢）
  client_id_number     TEXT,                      -- Col 2：保單客戶編號

  -- ── 保單基本資料 ────────────────────────────────────────
  policy_number        TEXT,                      -- Col 3：保單號碼
  policy_name          TEXT,                      -- Col 4：主約名稱
  policy_status        SMALLINT DEFAULT 1         -- Col 5：0=停效 1=有效
                         CHECK (policy_status IN (0, 1)),
  insurance_company    TEXT,                      -- Col 6：保險公司名稱
  policy_category      TEXT,                      -- Col 28：保單險種代碼

  -- ── 要保人 / 被保人 / 受益人 ────────────────────────────
  owner_name           TEXT,                      -- Col 7：要保人姓名
  owner_id_number      TEXT,                      -- Col 8：要保人編號
  insured_name         TEXT,                      -- Col 9：被保人姓名
  insured_id_number    TEXT,                      -- Col 10：被保人編號
  beneficiary_name     TEXT,                      -- Col 11：受益人姓名

  -- ── 日期 ─────────────────────────────────────────────────
  effective_date       DATE,                      -- Col 12：生效日
  receipt_date         DATE,                      -- Col 13：簽收日
  application_date     DATE,                      -- Col 29：受理日期

  -- ── 幣別 ─────────────────────────────────────────────────
  currency             SMALLINT DEFAULT 1         -- Col 14：1=台幣 2=美元 3=澳幣 4=南非幣 5=紐幣 6=歐元 7=人民幣
                         CHECK (currency BETWEEN 1 AND 7),
  currency_text        TEXT GENERATED ALWAYS AS (
    CASE currency
      WHEN 1 THEN '台幣' WHEN 2 THEN '美元' WHEN 3 THEN '澳幣'
      WHEN 4 THEN '南非幣' WHEN 5 THEN '紐幣' WHEN 6 THEN '歐元'
      WHEN 7 THEN '人民幣' END
  ) STORED,

  -- ── 保費 ─────────────────────────────────────────────────
  main_premium         NUMERIC(14,2),             -- Col 15：主約保費（元）
  lifetime_rider_prem  NUMERIC(14,2),             -- Col 16：終身附約保費
  term_rider_prem      NUMERIC(14,2),             -- Col 17：定期附約保費
  waiver_prem          NUMERIC(14,2),             -- Col 18：豁免保費
  prem_fee_rate        NUMERIC(6,2),              -- Col 19：保費費用率（%）
  flexible_prem        NUMERIC(14,2),             -- Col 20：彈性保費
  flexible_prem_rate   NUMERIC(6,2),              -- Col 21：彈性保費費用率（%）

  -- ── 繳費方式 ─────────────────────────────────────────────
  payment_years        NUMERIC(4,1),              -- Col 22：繳費年期（年）
  payment_frequency    SMALLINT                   -- Col 23：0=月繳 1=季繳 2=半年繳 3=年繳 4=躉繳
                         CHECK (payment_frequency BETWEEN 0 AND 4),
  deduction_method     SMALLINT                   -- Col 24：0=信用卡 1=銀行/郵局 2=自行繳費
                         CHECK (deduction_method BETWEEN 0 AND 2),
  bank_name            TEXT,                      -- Col 25：銀行名稱
  account_number       TEXT,                      -- Col 26：卡號/帳號（僅存末4碼較安全）
  card_expiry          TEXT,                      -- Col 27：信用卡到期年月（YYYYMM）

  -- ── 保額 ─────────────────────────────────────────────────
  policy_amount        NUMERIC(18,2),             -- Col 30：保額
  policy_unit          TEXT,                      -- Col 31：單位

  -- ── 違約金（前5年） ──────────────────────────────────────
  penalty_rate_y1      NUMERIC(6,2),              -- Col 32：1年違約金比率(%)
  penalty_rate_y2      NUMERIC(6,2),              -- Col 33
  penalty_rate_y3      NUMERIC(6,2),              -- Col 34
  penalty_rate_y4      NUMERIC(6,2),              -- Col 35
  penalty_rate_y5      NUMERIC(6,2),              -- Col 36

  -- ── 壽險保障 (Col 37-40) ─────────────────────────────────
  life_whole_amount    NUMERIC(14,2),             -- 終身壽險保障金額
  life_term_amount     NUMERIC(14,2),             -- 定期壽險保障金額
  life_term_years      NUMERIC(4,1),              -- 年期(年)
  life_invest_amount   NUMERIC(14,2),             -- 定期壽險（投資型）保障金額

  -- ── 各類保障明細（JSONB，彈性儲存多個附約） ─────────────
  -- 結構範例：[{"type":"住院日額(終身)", "amount": 1000, "max_renewal_age": 75, "receipt": 0}, ...]
  medical_coverage     JSONB DEFAULT '[]'::jsonb, -- 醫療保障 (Col 41-57)
  accident_coverage    JSONB DEFAULT '[]'::jsonb, -- 傷害意外保障 (Col 58-67)
  critical_coverage    JSONB DEFAULT '[]'::jsonb, -- 重疾特傷保障 (Col 68-76)
  disability_coverage  JSONB DEFAULT '[]'::jsonb, -- 殘廢殘扶保障 (Col 77-85)
  ltc_coverage         JSONB DEFAULT '[]'::jsonb, -- 長期看護保障 (Col 86-94)
  cancer_coverage      JSONB DEFAULT '[]'::jsonb, -- 防癌保障 (Col 95-98)

  -- ── 帳戶價值（解約金，投資型為主） (Col 99-107) ──────────
  -- 格式：{"age_60": 120000, "age_65": 180000, ...}
  account_value        JSONB DEFAULT '{}'::jsonb,

  -- ── 系統欄位 ─────────────────────────────────────────────
  raw_data             JSONB,                     -- 原始 XLS row（備查/debug 用）
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_cp_customer       ON customer_policies (customer_id);
CREATE INDEX IF NOT EXISTS idx_cp_client_name    ON customer_policies (client_name);
CREATE INDEX IF NOT EXISTS idx_cp_policy_type    ON customer_policies (policy_type);
CREATE INDEX IF NOT EXISTS idx_cp_status         ON customer_policies (policy_status);
CREATE INDEX IF NOT EXISTS idx_cp_company        ON customer_policies (insurance_company);
CREATE INDEX IF NOT EXISTS idx_cp_effective      ON customer_policies (effective_date);
CREATE INDEX IF NOT EXISTS idx_cp_fintechgo_uuid ON customer_policies (fintechgo_uuid);

-- GIN 索引讓 JSONB 欄位可被快速搜尋
CREATE INDEX IF NOT EXISTS idx_cp_medical_gin    ON customer_policies USING GIN (medical_coverage);
CREATE INDEX IF NOT EXISTS idx_cp_accident_gin   ON customer_policies USING GIN (accident_coverage);


-- ─────────────────────────────────────────────────────────────
--  3. 自動更新 updated_at
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_profiles_updated ON customer_profiles;
CREATE TRIGGER trg_customer_profiles_updated
  BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_customer_policies_updated ON customer_policies;
CREATE TRIGGER trg_customer_policies_updated
  BEFORE UPDATE ON customer_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─────────────────────────────────────────────────────────────
--  4. 方便 Bot 查詢的 View：透過 LINE user_id 找出客戶所有保單
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_line_user_policies AS
SELECT
  cp.line_user_id,
  pol.id                  AS policy_id,
  pol.policy_type,
  pol.client_name,
  pol.policy_number,
  pol.policy_name,
  pol.insurance_company,
  pol.policy_status,
  CASE pol.policy_status WHEN 1 THEN '有效' ELSE '停效' END AS status_text,
  pol.effective_date,
  pol.currency_text       AS currency,
  pol.main_premium,
  pol.payment_years,
  CASE pol.payment_frequency
    WHEN 0 THEN '月繳' WHEN 1 THEN '季繳' WHEN 2 THEN '半年繳'
    WHEN 3 THEN '年繳' WHEN 4 THEN '躉繳' END AS payment_freq_text,
  pol.life_whole_amount,
  pol.life_term_amount,
  pol.medical_coverage,
  pol.accident_coverage,
  pol.critical_coverage,
  pol.disability_coverage,
  pol.ltc_coverage,
  pol.cancer_coverage,
  pol.account_value
FROM customer_profiles cp
JOIN customer_policies pol ON pol.customer_id = cp.id
WHERE cp.line_user_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────
--  5. 保費摘要 View（依客戶彙總）
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_client_premium_summary AS
SELECT
  cp.line_user_id,
  pol.client_name,
  pol.policy_type,
  COUNT(*)                                  AS policy_count,
  SUM(pol.main_premium)                     AS total_main_premium,
  SUM(COALESCE(pol.lifetime_rider_prem,0)
    + COALESCE(pol.term_rider_prem,0)
    + COALESCE(pol.waiver_prem,0)
    + COALESCE(pol.flexible_prem,0))        AS total_rider_premium,
  SUM(pol.main_premium
    + COALESCE(pol.lifetime_rider_prem,0)
    + COALESCE(pol.term_rider_prem,0)
    + COALESCE(pol.waiver_prem,0))          AS total_annual_premium,
  pol.currency_text                         AS currency
FROM customer_policies pol
LEFT JOIN customer_profiles cp ON cp.id = pol.customer_id
WHERE pol.policy_status = 1   -- 只計算有效保單
GROUP BY cp.line_user_id, pol.client_name, pol.policy_type, pol.currency_text;


-- ─────────────────────────────────────────────────────────────
--  使用範例（Bot 查詢）
-- ─────────────────────────────────────────────────────────────
-- 1. 由 LINE user_id 查客戶所有有效保單：
--    SELECT * FROM v_line_user_policies
--    WHERE line_user_id = 'Uxxxxxxxxxxxxxxxx'
--    AND policy_status = 1;

-- 2. 查某客戶總保費：
--    SELECT * FROM v_client_premium_summary
--    WHERE line_user_id = 'Uxxxxxxxxxxxxxxxx';

-- 3. 全文查詢客戶姓名（無 LINE user_id 時）：
--    SELECT * FROM customer_policies
--    WHERE client_name LIKE '%林沛利%' AND policy_status = 1;

-- 4. 查客戶有無壽險保障：
--    SELECT policy_name, life_whole_amount, life_term_amount
--    FROM customer_policies
--    WHERE customer_id = '...'
--    AND (life_whole_amount > 0 OR life_term_amount > 0);
