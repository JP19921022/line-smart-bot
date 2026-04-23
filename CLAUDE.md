# Memory — LINE Bot 專案

## 專案基本資訊
- **專案名稱**：健平 AI 智能客服 LINE Bot
- **GitHub**：https://github.com/JP19921022/line-smart-bot.git
- **部署平台**：Render.com（LINE webhook 在此運行）
- **本地 dashboard pm2**：`~/line-bot/dashboard/server.js`（管理面板，port 3977，非 LINE bot）
- **部署方式**：`git push` → Render 自動部署

## 關鍵檔案
| 檔案 | 用途 |
|------|------|
| `app.js` | LINE webhook 主程式（在 Render 上跑） |
| `policyBinding.js` | 保單卡片 UI + 綁定/解綁流程 |
| `supabasePolicies.js` | Supabase 查詢封裝 |
| `scrape_gishpher.js` | 爬蟲（gishpher 保單平台） |
| `dashboard/server.js` | 管理面板（本地 pm2 dashboard 跑這個） |

## 資料庫
- **Supabase project**：arfjfcqnfodtilurehdu
- **主要資料表**：`customer_profiles`、`customer_policies`
- **UUID namespace**：`3b6a27bc-b0c4-4c1a-b3e0-9f5d31a0cfb5`（UUID v5，key = `公司|保單號碼`）

## 術語
| 縮寫/術語 | 意思 |
|----------|------|
| raw_data | 保單 JSONB 欄位，含 products 陣列、owner_phone 等 |
| binding | 客戶將 LINE 帳號綁定到保單資料 |
| gishpher | 保單管理平台（爬蟲來源） |

→ 詳細設定：memory/projects/line-bot-policy-card.md
