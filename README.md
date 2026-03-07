# LINE 智能客服 Bot

這個專案是一個使用 Express + LINE Messaging API 的 Webhook 服務，目的是讓官方帳號可以 24/7 線上回應訊息，並能擴充成結合 AI 的智能客服。

## 功能現況
- 接收 LINE Webhook 事件
- 針對文字訊息回覆「收到：<原文字>」
- 使用環境變數管理 Channel Secret / Access Token

## 本地開發
```bash
# 安裝依賴
npm install

# 建立 .env（僅本機）
cat <<'EOF' > .env
LINE_CHANNEL_ACCESS_TOKEN=你的AccessToken
LINE_CHANNEL_SECRET=你的ChannelSecret
EOF

# 啟動本機伺服器
npm start
```
> 開發時可搭配 `ngrok http 3000` 暫時暴露服務做測試。

## 部署到 Render（推薦）
1. **建立 GitHub Repo**
   - 把整個 `line-bot` 目錄推到 GitHub（例如 `line-smart-bot`）。
2. **在 Render 建立 Web Service**
   - Build Command：`npm install`
   - Start Command：`npm start`
3. **設定環境變數（Render Dashboard → Environment)**
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `OPENAI_API_KEY`（必填，使用 GPT-5.1-codex）
   - `OPENAI_MODEL`（選填，預設 `gpt-5.1-codex`）
   - `OPENAI_BASE_URL`（選填，若需自訂 OpenAI 相容端點）
   - `GEMINI_API_KEY` / `GEMINI_MODEL`（備援，可視需要保留）
4. **部署完成後**
   - Render 會提供固定 HTTPS URL，例如 `https://your-bot.onrender.com`
   - 在 URL 後面加 `/webhook`，填到 LINE Developers Console 的 Webhook URL
   - 按 **Verify** 應該成功

### 綁定自有網域（選用）
- 在 Render 服務頁面加入自訂網域（例如 `bot.yourdomain.com`）
- 依指示到 DNS 業者設定 CNAME/A 記錄
- 等待生效後，LINE Webhook URL 就可以改成 `https://bot.yourdomain.com/webhook`

## LINE 設定提醒
- Messaging API Channel → 啟用 Webhook、貼上新的 URL
- 重新產生 Channel Access Token（避免測試時外流的舊 token）
- 做任何程式更新後，Render 會自動重新部署；確保 Webhook URL 不用再改。

## 智能客服延伸規劃
1. **訊息路由**：針對文字/圖片/按鈕建立 handler，必要時串接 CRM。
2. **知識庫與 AI**：
   - 整理 FAQ / 保單資訊到資料庫或向量索引
   - 透過 GPT/Gemini/Claude + RAG 生成回覆
3. **對話管理**：記錄 session 狀態、支援人工接手
4. **監控與報表**：Log、告警、客服績效統計

有了固定部署後，就可以在此基礎上逐步把智能客服的邏輯加入。歡迎把後續需求列出，我可以持續擴充。