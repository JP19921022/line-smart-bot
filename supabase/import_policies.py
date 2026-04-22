"""
FintechGo XLS → Supabase 保單匯入腳本
用法：python3 import_policies.py <path_to_xls_or_xlsx>

環境變數（從 .env 讀取）：
  SUPABASE_URL
  SUPABASE_KEY
"""

import os
import sys
import json
import subprocess
import pandas as pd
from datetime import datetime, date
from pathlib import Path
from dotenv import load_dotenv
import requests

# ── 設定 ──────────────────────────────────────────────────────
load_dotenv(Path(__file__).parent.parent / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates",  # upsert by unique key
}

SHEET_TYPE_MAP = {
    "傳統保單-T": "T",
    "儲蓄保單-S": "S",
    "投資型保單-I": "I",
    "產險保單-P": "P",
}

CURRENCY_MAP = {1: "台幣", 2: "美元", 3: "澳幣", 4: "南非幣", 5: "紐幣", 6: "歐元", 7: "人民幣"}

# 醫療保障子欄位 (col index → 型態標籤)
# 每組格式：(coverage_col, max_age_col, receipt_col)
MEDICAL_SUBTYPES = [
    ("住院日額(終身)",    41, None, None),
    ("手術費用定額(終身)", 42, None, None),
    ("住院日額(定期)",    43,  44,   45),
    ("每日病房費用(實支)", 46,  47,   48),
    ("病房費轉日額(實支)", 49,  50,   51),
    ("醫療費用(實支)",    52,  53,   54),
    ("手術費用(實支)",    55,  56,   57),
]

ACCIDENT_SUBTYPES = [
    ("意外身故/殘廢",    58,  59, None),
    ("醫療費用(實支)",   60,  61,   62),
    ("住院日額",         63,  64,   65),
    ("重大燒燙傷",       66,  67, None),
]

CRITICAL_SUBTYPES = [
    ("重大疾病(終身)",   68, None, None),
    ("特定傷病(終身)",   69, None, None),
    ("重大傷病(終身)",   70, None, None),
    ("重大疾病(定期)",   71,  72, None),
    ("特定傷病(定期)",   73,  74, None),
    ("重大傷病(定期)",   75,  76, None),
]

DISABILITY_SUBTYPES = [
    ("殘廢一次金(終身)", 77, None, None),
    ("殘扶金月領(終身)", 78, None, None),
    ("殘扶金年領(終身)", 79, None, None),
    ("殘廢一次金(定期)", 80,  81, None),
    ("殘扶金月領(定期)", 82,  83, None),
    ("殘扶金年領(定期)", 84,  85, None),
]

LTC_SUBTYPES = [
    ("長看一次金(終身)", 86, None, None),
    ("長看金月領(終身)", 87, None, None),
    ("長看金年領(終身)", 88, None, None),
    ("長看一次金(定期)", 89,  90, None),
    ("長看金月領(定期)", 91,  92, None),
    ("長看金年領(定期)", 93,  94, None),
]

CANCER_SUBTYPES = [
    ("癌症身故(不含壽險)", 95, None, None),
    ("初次罹患癌症",        96, None, None),
    ("癌症住院(日額)",      97, None, None),
    ("癌症手術(每次)",      98, None, None),
]

ACCOUNT_VALUE_AGES = [
    ("age_60", 99), ("age_65", 100), ("age_70", 101), ("age_75", 102),
    ("age_80", 103), ("age_85", 104), ("age_90", 105), ("age_95", 106),
    ("age_100", 107),
]


# ── 工具函式 ───────────────────────────────────────────────────

def to_date(val):
    if pd.isna(val) or val is None:
        return None
    if isinstance(val, (datetime, date, pd.Timestamp)):
        return pd.Timestamp(val).date().isoformat()
    try:
        return pd.to_datetime(str(val)).date().isoformat()
    except Exception:
        return None


def to_float(val):
    if pd.isna(val) or val is None:
        return None
    try:
        return float(val)
    except Exception:
        return None


def to_int(val):
    if pd.isna(val) or val is None:
        return None
    try:
        return int(val)
    except Exception:
        return None


def safe_str(val):
    if pd.isna(val) or val is None:
        return None
    s = str(val).strip()
    return s if s else None


def build_coverage_list(row, subtypes):
    result = []
    for label, amount_col, max_age_col, receipt_col in subtypes:
        amount = to_float(row.iloc[amount_col])
        if amount and amount > 0:
            entry = {"type": label, "amount": amount}
            if max_age_col:
                age = to_int(row.iloc[max_age_col])
                if age:
                    entry["max_renewal_age"] = age
            if receipt_col:
                receipt = to_int(row.iloc[receipt_col])
                if receipt is not None:
                    entry["receipt"] = receipt  # 0=正本 1=副本
            result.append(entry)
    return result


def build_account_value(row):
    av = {}
    for key, col in ACCOUNT_VALUE_AGES:
        v = to_float(row.iloc[col])
        if v:
            av[key] = v
    return av


def row_to_policy(row, policy_type):
    """Convert a DataFrame row (by position) to a dict for Supabase insert."""
    fintechgo_uuid = safe_str(row.iloc[0])

    return {
        "fintechgo_uuid":       fintechgo_uuid,
        "policy_type":          policy_type,

        # 客戶
        "client_name":          safe_str(row.iloc[1]),
        "client_id_number":     safe_str(row.iloc[2]),

        # 保單基本
        "policy_number":        safe_str(row.iloc[3]),
        "policy_name":          safe_str(row.iloc[4]),
        "policy_status":        to_int(row.iloc[5]) if not pd.isna(row.iloc[5]) else 1,
        "insurance_company":    safe_str(row.iloc[6]),
        "policy_category":      safe_str(row.iloc[28]),

        # 要保/被保/受益
        "owner_name":           safe_str(row.iloc[7]),
        "owner_id_number":      safe_str(row.iloc[8]),
        "insured_name":         safe_str(row.iloc[9]),
        "insured_id_number":    safe_str(row.iloc[10]),
        "beneficiary_name":     safe_str(row.iloc[11]),

        # 日期
        "effective_date":       to_date(row.iloc[12]),
        "receipt_date":         to_date(row.iloc[13]),
        "application_date":     to_date(row.iloc[29]),

        # 幣別
        "currency":             to_int(row.iloc[14]) or 1,

        # 保費
        "main_premium":         to_float(row.iloc[15]),
        "lifetime_rider_prem":  to_float(row.iloc[16]),
        "term_rider_prem":      to_float(row.iloc[17]),
        "waiver_prem":          to_float(row.iloc[18]),
        "prem_fee_rate":        to_float(row.iloc[19]),
        "flexible_prem":        to_float(row.iloc[20]),
        "flexible_prem_rate":   to_float(row.iloc[21]),

        # 繳費
        "payment_years":        to_float(row.iloc[22]),
        "payment_frequency":    to_int(row.iloc[23]),
        "deduction_method":     to_int(row.iloc[24]),
        "bank_name":            safe_str(row.iloc[25]),
        "account_number":       safe_str(row.iloc[26]),
        "card_expiry":          safe_str(row.iloc[27]),

        # 保額
        "policy_amount":        to_float(row.iloc[30]),
        "policy_unit":          safe_str(row.iloc[31]),

        # 違約金
        "penalty_rate_y1":      to_float(row.iloc[32]),
        "penalty_rate_y2":      to_float(row.iloc[33]),
        "penalty_rate_y3":      to_float(row.iloc[34]),
        "penalty_rate_y4":      to_float(row.iloc[35]),
        "penalty_rate_y5":      to_float(row.iloc[36]),

        # 壽險
        "life_whole_amount":    to_float(row.iloc[37]),
        "life_term_amount":     to_float(row.iloc[38]),
        "life_term_years":      to_float(row.iloc[39]),
        "life_invest_amount":   to_float(row.iloc[40]),

        # Coverage JSONB
        "medical_coverage":     build_coverage_list(row, MEDICAL_SUBTYPES),
        "accident_coverage":    build_coverage_list(row, ACCIDENT_SUBTYPES),
        "critical_coverage":    build_coverage_list(row, CRITICAL_SUBTYPES),
        "disability_coverage":  build_coverage_list(row, DISABILITY_SUBTYPES),
        "ltc_coverage":         build_coverage_list(row, LTC_SUBTYPES),
        "cancer_coverage":      build_coverage_list(row, CANCER_SUBTYPES),
        "account_value":        build_account_value(row),
    }


def upsert_to_supabase(table, records, batch_size=50):
    """Upsert a list of dicts into a Supabase table in batches."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    total = len(records)
    inserted = 0

    for i in range(0, total, batch_size):
        batch = records[i:i + batch_size]
        resp = requests.post(url, headers=HEADERS, data=json.dumps(batch))
        if resp.status_code not in (200, 201):
            print(f"  ❌ 批次 {i}-{i+len(batch)} 失敗: {resp.status_code} {resp.text[:200]}")
        else:
            inserted += len(batch)
            print(f"  ✅ 匯入 {inserted}/{total}")

    return inserted


def ensure_customer_profile(client_name, client_id_number):
    """Insert customer_profiles if not exists; return id."""
    url = f"{SUPABASE_URL}/rest/v1/customer_profiles"

    # Check if exists
    check_url = f"{url}?client_name=eq.{requests.utils.quote(client_name or '')}&client_id_number=eq.{requests.utils.quote(client_id_number or '')}&select=id"
    resp = requests.get(check_url, headers=HEADERS)
    if resp.ok and resp.json():
        return resp.json()[0]["id"]

    # Insert new
    payload = {"client_name": client_name, "client_id_number": client_id_number}
    resp = requests.post(url, headers={**HEADERS, "Prefer": "return=representation"}, data=json.dumps(payload))
    if resp.ok and resp.json():
        return resp.json()[0]["id"]
    return None


# ── 主程式 ─────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("用法: python3 import_policies.py <policy.xls 或 .xlsx>")
        sys.exit(1)

    input_file = Path(sys.argv[1])
    if not input_file.exists():
        print(f"❌ 找不到檔案: {input_file}")
        sys.exit(1)

    # 若為 .xls 則先轉換
    if input_file.suffix.lower() == ".xls":
        print("📋 轉換 .xls → .xlsx ...")
        out_dir = input_file.parent
        subprocess.run(["libreoffice", "--headless", "--convert-to", "xlsx",
                        str(input_file), "--outdir", str(out_dir)], check=True)
        xlsx_file = out_dir / (input_file.stem + ".xlsx")
    else:
        xlsx_file = input_file

    xl = pd.ExcelFile(xlsx_file)
    all_records = []
    customer_cache = {}  # name+id → uuid

    for sheet_name, policy_type in SHEET_TYPE_MAP.items():
        if sheet_name not in xl.sheet_names:
            continue

        print(f"\n📂 讀取 {sheet_name} ({policy_type})...")
        df = pd.read_excel(xlsx_file, sheet_name=sheet_name, header=None, skiprows=5)

        if len(df) == 0 or len(df.columns) < 108:
            print(f"  ⚠️  空白或欄數不足，跳過")
            continue

        sheet_records = []
        for idx, row in df.iterrows():
            client_name = safe_str(row.iloc[1])
            if not client_name:
                continue  # 略過空白列

            # 確保客戶存在
            client_id = safe_str(row.iloc[2])
            cache_key = f"{client_name}|{client_id}"
            if cache_key not in customer_cache:
                customer_cache[cache_key] = ensure_customer_profile(client_name, client_id)

            record = row_to_policy(row, policy_type)
            record["customer_id"] = customer_cache.get(cache_key)
            sheet_records.append(record)

        print(f"  → {len(sheet_records)} 筆保單")
        all_records.extend(sheet_records)

    print(f"\n📤 開始匯入 Supabase（共 {len(all_records)} 筆）...")
    upsert_to_supabase("customer_policies", all_records)
    print("\n✅ 完成！")


if __name__ == "__main__":
    main()
