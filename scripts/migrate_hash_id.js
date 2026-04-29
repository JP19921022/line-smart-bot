/**
 * migrate_hash_id.js
 * 一次性遷移：將 customer_profiles.client_id_number 明文 → HMAC-SHA256 hash
 *
 * 執行：node scripts/migrate_hash_id.js
 * ⚠️  只需執行一次！執行前確認 ID_HASH_PEPPER 已設定在 .env
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const sb = require('../supabaseClient');
const { hashIdNumber } = require('../idHashUtils');

const HASH_REGEX = /^[0-9a-f]{64}$/; // 已 hash 的 pattern

async function migrate() {
  if (!sb) { console.error('❌ Supabase 未連線'); process.exit(1); }

  const pepper = process.env.ID_HASH_PEPPER;
  if (!pepper) { console.error('❌ ID_HASH_PEPPER 未設定'); process.exit(1); }

  console.log('🔍 讀取所有客戶身分證資料...');
  const { data, error } = await sb
    .from('customer_profiles')
    .select('id, client_name, client_id_number')
    .not('client_id_number', 'is', null);

  if (error) { console.error('❌ 讀取失敗:', error.message); process.exit(1); }

  const total = data.length;
  let skipped = 0, migrated = 0, failed = 0;

  console.log(`📊 共找到 ${total} 筆資料，開始遷移...\n`);

  for (const row of data) {
    const raw = row.client_id_number || '';

    // 已是 hash → 跳過
    if (HASH_REGEX.test(raw)) {
      skipped++;
      continue;
    }

    // 明文 → hash
    const hashed = hashIdNumber(raw);
    if (!hashed) {
      console.warn(`  ⚠️  ${row.client_name}（${row.id}）hash 失敗，跳過`);
      failed++;
      continue;
    }

    const { error: updateErr } = await sb
      .from('customer_profiles')
      .update({ client_id_number: hashed })
      .eq('id', row.id);

    if (updateErr) {
      console.error(`  ❌ ${row.client_name} 更新失敗:`, updateErr.message);
      failed++;
    } else {
      console.log(`  ✅ ${row.client_name} → 已 hash`);
      migrated++;
    }
  }

  console.log(`\n══════════════════════════════`);
  console.log(`✅ 遷移完成`);
  console.log(`   已遷移：${migrated} 筆`);
  console.log(`   已是 hash（跳過）：${skipped} 筆`);
  console.log(`   失敗：${failed} 筆`);
  console.log(`══════════════════════════════`);

  if (migrated > 0) {
    console.log('\n🎉 資料庫明文身分證已全部加密完成！');
    console.log('⚠️  請記得在 Render 環境變數加入 ID_HASH_PEPPER');
  }
}

migrate().catch(console.error);
