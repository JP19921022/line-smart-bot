'use strict';
/**
 * daily_summary.js — 每天早上 8:00 產生客戶互動摘要
 * pm2：pm2 start daily_summary.js --name daily-summary --cron "0 8 * * *" --no-autorestart
 * 手動：node daily_summary.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');

const CRM_ACTS_FILE  = path.join(__dirname, 'data', 'crm_activities.json');
const CRM_LEADS_FILE = path.join(__dirname, 'data', 'crm_leads.json');
const SUMMARY_FILE   = path.join(__dirname, 'data', 'daily_summary.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function generateSummary() {
  const now    = new Date();
  const since  = new Date(now - 24 * 60 * 60 * 1000); // 過去 24 小時
  const leadsRaw = readJson(CRM_LEADS_FILE, []);
  const leads    = Array.isArray(leadsRaw) ? leadsRaw : (leadsRaw.leads || []);
  const acts     = readJson(CRM_ACTS_FILE, {});

  // 建立 id → name 映射
  const nameMap = {};
  for (const l of leads) nameMap[l.id] = l.name || l.id;

  const active = [];
  for (const [cid, arr] of Object.entries(acts)) {
    const recent = arr.filter(a => new Date(a.at) >= since);
    if (recent.length === 0) continue;
    const latest = recent[0];
    active.push({
      name:    nameMap[cid] || cid,
      count:   recent.length,
      latest:  latest.content.slice(0, 80),
      lastAt:  latest.at.slice(0, 16).replace('T', ' '),
    });
  }
  active.sort((a, b) => b.count - a.count);

  const summary = {
    date:       now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
    generated:  now.toISOString(),
    totalActive: active.length,
    clients:    active,
  };

  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  // 輸出摘要到 console
  const dateStr = summary.date;
  console.log(`\n📊 ${dateStr} 每日客戶互動摘要`);
  console.log(`   過去24小時活躍客戶：${active.length} 位\n`);
  if (active.length === 0) {
    console.log('   昨天沒有客戶互動記錄');
    return summary;
  }
  for (const c of active.slice(0, 10)) {
    console.log(`   👤 ${c.name}  (${c.count}則對話)`);
    console.log(`      最後：[${c.lastAt}] ${c.latest}`);
    console.log('');
  }
  if (active.length > 10) console.log(`   ... 還有 ${active.length - 10} 位客戶`);
  console.log(`\n摘要已儲存：${SUMMARY_FILE}`);
  return summary;
}

generateSummary();
