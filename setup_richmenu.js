/**
 * setup_richmenu.js
 * 建立含「查詢我的保單」的主選單 v4，並設為預設
 *
 * 使用方式：
 *   node setup_richmenu.js
 *
 * 執行後會印出新 Rich Menu ID，請更新 .env 的 RICH_MENU_MAIN_ID
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('❌ 找不到 LINE_CHANNEL_ACCESS_TOKEN，請確認 .env 設定');
  process.exit(1);
}

// ── Rich Menu 定義 ────────────────────────────────────────────
// 全尺寸 2500×1686，3欄×2列
const RICH_MENU = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: 'OC_MainMenu_v4',
  chatBarText: '主選單',
  areas: [
    // ── 第一列 ──
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: { type: 'message', label: '詢問業務員', text: '我想諮詢保險' }
    },
    {
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: { type: 'message', label: '查詢我的保單', text: '查詢我的保單' }
    },
    {
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: { type: 'message', label: '理賠查詢', text: '請問理賠需要準備哪些資料？' }
    },
    // ── 第二列 ──
    {
      bounds: { x: 0, y: 843, width: 833, height: 843 },
      action: { type: 'message', label: '保費計算', text: '幫我計算保費' }
    },
    {
      bounds: { x: 833, y: 843, width: 834, height: 843 },
      action: { type: 'message', label: '更多功能', text: '更多功能' }
    },
    {
      bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: { type: 'message', label: '聯絡業務員', text: '我要聯絡業務員' }
    }
  ]
};

// ── HTTP 工具函式 ─────────────────────────────────────────────

function lineRequest(method, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      hostname: 'api.line.me',
      path,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(data ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function lineUploadImage(menuId, imagePath) {
  return new Promise((resolve, reject) => {
    const imageData = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const opts = {
      hostname: 'api-data.line.me',
      path: `/v2/bot/richmenu/${menuId}/content`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': contentType,
        'Content-Length': imageData.length
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(imageData);
    req.end();
  });
}

// ── 主流程 ───────────────────────────────────────────────────

async function main() {
  console.log('🚀 開始建立新版主選單 OC_MainMenu_v4...\n');

  // 1. 取得現有主選單 ID（從 app.js hardcode 或 env）
  const OLD_MENU_ID = process.env.RICH_MENU_MAIN_ID || 'richmenu-8dfa2dccdecfe4f113e7c69b2c8dab0e';

  // 2. 建立新 Rich Menu
  console.log('📋 建立 Rich Menu 定義...');
  const createRes = await lineRequest('POST', '/v2/bot/richmenu', RICH_MENU);
  if (createRes.status !== 200) {
    console.error('❌ 建立失敗:', createRes.body);
    process.exit(1);
  }
  const newMenuId = createRes.body.richMenuId;
  console.log(`✅ Rich Menu 建立成功：${newMenuId}\n`);

  // 3. 嘗試複製舊選單的圖片（若存在）
  //    如果有自訂圖片請改為指定路徑，例如 './assets/main_menu.jpg'
  const imagePaths = [
    './assets/main_menu.jpg',
    './assets/main_menu.png',
    './assets/richmenu.jpg',
    './assets/richmenu.png',
    './dashboard/public/main_menu.jpg',
  ];
  const existingImage = imagePaths.find(p => fs.existsSync(p));

  if (existingImage) {
    console.log(`🖼️  上傳圖片：${existingImage}`);
    const uploadRes = await lineUploadImage(newMenuId, existingImage);
    if (uploadRes.status === 200) {
      console.log('✅ 圖片上傳成功\n');
    } else {
      console.warn('⚠️  圖片上傳失敗（Rich Menu 仍可使用，但沒有圖片）:', uploadRes.body);
    }
  } else {
    console.log('⚠️  找不到 Rich Menu 圖片，跳過上傳');
    console.log('   請手動到 LINE Official Account Manager 上傳圖片');
    console.log(`   選單 ID：${newMenuId}\n`);
  }

  // 4. 設為預設選單
  console.log('🔗 設為預設 Rich Menu...');
  const defaultRes = await lineRequest('POST', `/v2/bot/user/all/richmenu/${newMenuId}`, null);
  if (defaultRes.status === 200) {
    console.log('✅ 已設為預設選單\n');
  } else {
    console.warn('⚠️  設定預設失敗:', defaultRes.body);
  }

  // 5. 印出結果
  console.log('═══════════════════════════════════════════');
  console.log('✅ 完成！請更新以下設定：');
  console.log('');
  console.log(`新 Rich Menu ID：${newMenuId}`);
  console.log('');
  console.log('方法 A：更新 .env（推薦）');
  console.log(`  RICH_MENU_MAIN_ID=${newMenuId}`);
  console.log('');
  console.log('方法 B：直接改 app.js 第一行 MAIN_RICH_MENU_ID');
  console.log(`  const MAIN_RICH_MENU_ID = '${newMenuId}';`);
  console.log('');
  console.log('更新後記得 git push 並重新部署到 Render！');
  console.log('═══════════════════════════════════════════');

  // 6. 自動更新 app.js 的 hardcode ID
  const appJsPath = './app.js';
  if (fs.existsSync(appJsPath)) {
    let appJs = fs.readFileSync(appJsPath, 'utf-8');
    appJs = appJs.replace(
      /const MAIN_RICH_MENU_ID = ['"](richmenu-[^'"]+)['"]/,
      `const MAIN_RICH_MENU_ID = '${newMenuId}'`
    );
    fs.writeFileSync(appJsPath, appJs);
    console.log('\n✅ app.js 已自動更新 MAIN_RICH_MENU_ID');
  }
}

main().catch(err => {
  console.error('❌ 執行失敗:', err.message);
  process.exit(1);
});
