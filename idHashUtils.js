/**
 * idHashUtils.js
 * 身分證字號 HMAC-SHA256 加密工具
 *
 * 使用 HMAC-SHA256 + pepper（環境變數 ID_HASH_PEPPER）
 * 特性：
 *   - 單向不可逆（無法從 hash 還原原始身分證）
 *   - 相同輸入永遠產生相同 hash（可驗證）
 *   - pepper 外洩也無法暴力破解（ID 格式固定但 HMAC 計算成本高）
 *
 * ⚠️  ID_HASH_PEPPER 一旦設定絕對不能修改，
 *      修改後所有已儲存的 hash 全部失效，客戶需重新驗證。
 */

const crypto = require('crypto');

const PEPPER = process.env.ID_HASH_PEPPER || '';

if (!PEPPER) {
  console.warn('[idHashUtils] ⚠️  ID_HASH_PEPPER 未設定，身分證 hash 功能停用');
}

/**
 * 將身分證字號雜湊化
 * @param {string} idNumber  原始身分證字號（大小寫不拘、允許前後空白）
 * @returns {string|null}    hex 格式 SHA-256 hash，或 null（輸入無效時）
 */
function hashIdNumber(idNumber) {
  if (!idNumber || !PEPPER) return null;
  const normalized = idNumber.trim().toUpperCase();
  if (!normalized) return null;
  return crypto.createHmac('sha256', PEPPER).update(normalized).digest('hex');
}

/**
 * 驗證使用者輸入的身分證是否與資料庫 hash 吻合
 * @param {string} inputId   使用者輸入
 * @param {string} storedHash 資料庫儲存的 hash
 * @returns {boolean}
 */
function verifyIdNumber(inputId, storedHash) {
  if (!inputId || !storedHash || !PEPPER) return false;
  const inputHash = hashIdNumber(inputId);
  if (!inputHash) return false;
  // 使用 timingSafeEqual 防止 timing attack
  const a = Buffer.from(inputHash);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { hashIdNumber, verifyIdNumber };
