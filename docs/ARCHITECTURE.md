# 智能客服 BOT 架構藍圖

## 1. 分層架構
```
┌──────────────────────────────────────────────┐
│ Channel Layer                                │
│  - LINE Messaging API                        │
│  - 未來可擴充 IG / FB / Web Chat             │
├──────────────────────────────────────────────┤
│ Webhook & Routing Layer                      │
│  - Express Webhook                           │
│  - 事件分類 (文字/圖片/指令/系統)             │
├──────────────────────────────────────────────┤
│ Intelligence Layer                           │
│  - FAQ / 規則式回覆                           │
│  - LLM 回應 (GPT/Gemini/Claude)               │
│  - RAG：向量資料庫檢索                       │
│  - Workflow Orchestrator                     │
├──────────────────────────────────────────────┤
│ Data & Services Layer                        │
│  - 客戶資料庫 (CRM)                           │
│  - 保單/基金知識庫                           │
│  - Logging / Metrics / Alert                 │
├──────────────────────────────────────────────┤
│ Operations Layer                             │
│  - Render/Railway/Fly.io 部署                │
│  - 監控 (Health checks, Alerts)              │
│  - Secret 管理 (Render Env / Vault)          │
└──────────────────────────────────────────────┘
```

## 2. 核心模組說明
- **Event Router**：依 LINE 事件類型呼叫對應 handler，並注入追蹤 ID 方便日誌串接。
- **Intent & Context**：
  - 先跑規則式 / 關鍵字 → 命中就直接回覆。
  - 命中率不足時，呼叫 LLM，並將用戶上下文（最近幾輪對話）一起帶入。
- **RAG（Retrieval-Augmented Generation）**：
  - 建立一份保險/基金知識庫（Markdown、PDF、Sheets 皆可），透過向量資料庫（如 Pinecone、Weaviate、Supabase Vector）提供檢索片段給 LLM。
- **Workflow Orchestrator**：
  - 例如「保單健檢」需要先確認客戶資料 → 查資料庫 → 生成報告 → 回傳連結，這類流程可抽象成 workflow，讓 AI 或規則呼叫。
- **Fallback & Escalation**：
  - LLM 信心不足或被標記「需要人工」時，寫入任務列表 / 通知客服人員介入。

## 3. 資料流流程
1. 使用者在 LINE 輸入文字。
2. Webhook 收到事件，記錄 log，交給 Event Router。
3. Router 將文字交給 Intent → (a) 命中 FAQ 規則；(b) 否則走 LLM Pipeline。
4. LLM Pipeline：
   - 取最近對話 Context
   - 向量檢索相關知識片段
   - 呼叫 GPT/Gemini 等產生回覆
   - 套用政策檢查（敏感詞、禁止項目）
5. 回覆訊息給 LINE，用戶收到。
6. 同步寫入會話記錄（供報表、再訓練、客服接手）。

## 4. 後台與營運
- **Dashboard**：可視化對話量、滿意度、常見問題、AI 信心等。
- **Alerting**：
  - Webhook 錯誤率升高 → 發通知
  - LLM 連線失敗 → 自動切換備援模型或降級成 FAQ。
- **版本管理**：
  - 將對話流程、FAQ、Prompt 存在 Git，確保可 rollback。
- **安全**：
  - Channel Secret / Token 放在 Render Env（或 Secret Manager）
  - API 金鑰分權限保存，Log 遮蔽敏感資訊。

## 5. 待辦與里程碑
1. ✅ 基礎 Webhook → 雲端部署
2. ⬜️ FAQ/規則式回覆模組
3. ⬜️ LLM + 知識庫整合
4. ⬜️ 客製化 Workflow（保單健檢、基金建議）
5. ⬜️ 後台 Dashboard + 報表
6. ⬜️ 監控與告警

以上架構可視需求逐步落地，先完成部署，再依優先級開發智能客服功能。