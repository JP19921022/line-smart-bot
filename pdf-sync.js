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

// 桌面「LINE官方PDF」→ 同步到 assets/forms/
// 結構：LINE官方PDF/{表單類型}/{保險公司}-{表單類型}.pdf
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

// ── 遞迴收集所有 PDF（含子資料夾）────────────────────────────
function collectPdfs(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath  = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectPdfs(fullPath, relPath));
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

// ── 同步所有 PDF（保留子資料夾結構）─────────────────────────
function syncAllPdfs() {
  const pdfs = collectPdfs(SRC_DIR, '');
  if (pdfs.length === 0) {
    console.log('[pdf-sync] 📂 桌面資料夾目前沒有 PDF');
    return false;
  }
  let changed = 0;
  for (const { fullPath: src, relPath } of pdfs) {
    const dest    = path.join(DEST_DIR, relPath);
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const srcStat  = fs.statSync(src);
    const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (!destStat || srcStat.mtimeMs > destStat.mtimeMs) {
      fs.copyFileSync(src, dest);
      console.log(`[pdf-sync] 📄 已複製：${relPath}`);
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

// ── 遞迴監控（含子資料夾）────────────────────────────────────
// macOS / Linux 支援 recursive: true
fs.watch(SRC_DIR, { persistent: true, recursive: true }, (eventType, filename) => {
  if (!filename) return;
  // 只處理 PDF 或子資料夾異動
  const isPdf = filename.toLowerCase().endsWith('.pdf');
  const isDir = !filename.includes('.');
  if (!isPdf && !isDir) return;
  console.log(`[pdf-sync] 🔔 偵測到變動：${filename}（${eventType}）`);
  scheduleGitPush();
});

// ── 每 10 分鐘定期補同步（保底機制）─────────────────────────
setInterval(() => {
  console.log('[pdf-sync] ⏰ 定期補同步...');
  scheduleGitPush();
}, 10 * 60 * 1000);

console.log('[pdf-sync] ✅ 監控中（遞迴），有 PDF 異動會自動上傳');
