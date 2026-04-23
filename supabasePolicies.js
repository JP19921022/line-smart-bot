/**
 * supabasePolicies.js
 * Supabase 保單 / 客戶查詢封裝
 * 對應 schema_customer_policies.sql 的兩張表
 */

const sb = require('./supabaseClient');

// ── customer_profiles 查詢 ─────────────────────────────────────

/** 透過 LINE user_id 取得客戶 profile */
async function getProfileByLineId(lineUserId) {
  if (!sb || !lineUserId) return null;
  const { data, error } = await sb
    .from('customer_profiles')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();
  if (error) {
    console.error('[supabasePolicies] getProfileByLineId error:', error.message);
    return null;
  }
  return data;
}

/** 透過 profile id 取得客戶 profile */
async function getProfileById(profileId) {
  if (!sb || !profileId) return null;
  const { data, error } = await sb
    .from('customer_profiles')
    .select('*')
    .eq('id', profileId)
    .maybeSingle();
  if (error) {
    console.error('[supabasePolicies] getProfileById error:', error.message);
    return null;
  }
  return data;
}

/**
 * 模糊搜尋客戶姓名（ILIKE）
 * 回傳 Array of { id, client_name, client_id_number }
 */
async function searchProfilesByName(name) {
  if (!sb || !name) return [];
  const keyword = name.trim();
  const { data, error } = await sb
    .from('customer_profiles')
    .select('id, client_name, client_id_number')
    .ilike('client_name', `%${keyword}%`)
    .is('line_user_id', null)  // 只找未綁定的
    .limit(5);
  if (error) {
    console.error('[supabasePolicies] searchProfilesByName error:', error.message);
    return [];
  }
  return data || [];
}

/** 把 LINE user_id 寫進 customer_profiles */
async function bindLineUser(profileId, lineUserId) {
  if (!sb || !profileId || !lineUserId) return false;
  const { error } = await sb
    .from('customer_profiles')
    .update({ line_user_id: lineUserId })
    .eq('id', profileId);
  if (error) {
    console.error('[supabasePolicies] bindLineUser error:', error.message);
    return false;
  }
  return true;
}

// ── customer_policies 查詢 ─────────────────────────────────────

/** 取得某客戶所有有效保單（預設只取有效保單） */
async function getPoliciesByCustomerId(customerId, activeOnly = true) {
  if (!sb || !customerId) return [];
  let query = sb
    .from('customer_policies')
    .select(`
      id, policy_type, policy_name, policy_number, policy_category,
      policy_status, insurance_company, currency_text, currency,
      client_name, owner_name, insured_name,
      main_premium, lifetime_rider_prem, term_rider_prem, waiver_prem,
      payment_years, payment_frequency,
      policy_amount, policy_unit,
      life_whole_amount, life_term_amount, life_invest_amount,
      medical_coverage, accident_coverage, critical_coverage,
      disability_coverage, ltc_coverage, cancer_coverage,
      account_value, effective_date
    `)
    .eq('customer_id', customerId)
    .order('effective_date', { ascending: false });

  if (activeOnly) {
    query = query.eq('policy_status', 1);
  }

  // 只顯示壽險保單，排除產險（P）
  query = query.neq('policy_type', 'P');

  const { data, error } = await query;
  if (error) {
    console.error('[supabasePolicies] getPoliciesByCustomerId error:', error.message);
    return [];
  }
  return data || [];
}

/** 透過 LINE user_id 取保單（用 view） */
async function getPoliciesByLineUserId(lineUserId, activeOnly = true) {
  if (!sb || !lineUserId) return [];
  let query = sb
    .from('v_line_user_policies')
    .select('*')
    .eq('line_user_id', lineUserId)
    .order('effective_date', { ascending: false });

  if (activeOnly) {
    query = query.eq('policy_status', 1);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[supabasePolicies] getPoliciesByLineUserId error:', error.message);
    return [];
  }
  return data || [];
}

/** 取得客戶保費摘要 */
async function getPremiumSummaryByLineUserId(lineUserId) {
  if (!sb || !lineUserId) return [];
  const { data, error } = await sb
    .from('v_client_premium_summary')
    .select('*')
    .eq('line_user_id', lineUserId);
  if (error) {
    console.error('[supabasePolicies] getPremiumSummaryByLineUserId error:', error.message);
    return [];
  }
  return data || [];
}

module.exports = {
  getProfileByLineId,
  getProfileById,
  searchProfilesByName,
  bindLineUser,
  getPoliciesByCustomerId,
  getPoliciesByLineUserId,
  getPremiumSummaryByLineUserId,
};
