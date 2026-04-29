/**
 * pdf-sync.js
 * 監控桌面「LINE官方PDF」資料夾
 * 當 PDF 有異動 → 自動複製到 assets/forms/ → git push
 *
 * 啟動：pm2 start pdf-sync.js --name pdf-sync
 */

const fs   = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const SRC_DIR  = path.join(process.env.HOME, 'Desktop', 'LINE官方PDF');
const DEST_DIR = path.join(__dirname, 'assets', 'forms');
const DEBOUNCE_MS = 3000; // 等 3 秒才 push（避免連續改動重複觸發）

// ── 確保目錄存在 ──────────────────────────────────────────────
if (!fs.existsSync(SRC_DIR)) {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  console.log(`[pdf-sync] ✅ 已建立桌面資料夾：${SRC_DIR}`);
}
if (!fs.existsSync(DEST_DIR)) {
  fs.mkdirSync(DEST_DIR, { recursive: true });
}

// ── 同步所有 PDF ──────────────────────────────────────────────
function syncAllPdfs() {
  const files = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (files.length === 0) {
    console.log('[pdf-sync] 📂 桌面資料夾目前沒有 PDF');
    return false;
  }
  let changed = 0;
  for (const f of files) {
    const src  = path.join(SRC_DIR,  f);
    const dest = path.join(DEST_DIR, f);
    const srcStat  = fs.statSync(src);
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
    // 只有新檔或有異動才複製
    if (!destStat || srcStat.mtimeMs > destStat.mtimeMs) {
      fs.copyFileSync(src, dest);
      console.log(`[pdf-sync] 📄 已複製：${f}`);
      changed++;
    }
  }
  return changed > 0;
}

// ── git push ──────────────────────────────────────────────────
let timer = null;
function scheduleGitPush() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      const changed = syncAllPdfs();
      if (!changed) return;

      execSync('git add assets/forms/', { cwd: __dirname, stdio: 'pipe' });

      // 確認有東西要 commit
      const status = execSync('git status --porcelain assets/forms/', { cwd: __dirname }).toString().trim();
      if (!status) {
        console.log('[pdf-sync] ✅ 沒有新變更，不需要 push');
        return;
      }

      execSync('git commit -m "update: PDF 申請表自動同步"', { cwd: __dirname, stdio: 'pipe' });
      exec('git push origin main', { cwd: __dirname }, (err, stdout, stderr) => {
        if (err) {
          console.error('[pdf-sync] ❌ git push 失敗：', stderr);
        } else {
          console.log('[pdf-sync] 🚀 已推送到 Render，約 1 分鐘後上線');
        }
      });
    } catch (e) {
      console.error('[pdf-sync] ❌ 同步失敗：', e.message);
    }
  }, DEBOUNCE_MS);
}

// ── 啟動時先同步一次 ─────────────────────────────────────────
console.log(`[pdf-sync] 👀 開始監控：${SRC_DIR}`);
scheduleGitPush();

// ── 監控資料夾 ────────────────────────────────────────────────
fs.watch(SRC_DIR, { persistent: true }, (eventType, filename) => {
  if (!filename || !filename.toLowerCase().endsWith('.pdf')) return;
  console.log(`[pdf-sync] 🔔 偵測到變動：${filename}（${eventType}）`);
  scheduleGitPush();
});

console.log('[pdf-sync] ✅ 監控中，有 PDF 異動會自動上傳');
