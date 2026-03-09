const express = require("express");
const crypto = require("crypto");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

const PORT = process.env.PORT || 3001;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

function verifySignature(req) {
  const signature = req.headers["x-line-signature"];
  const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.rawBody).digest("base64");
  return signature === hash;
}

function quickMenuItems() {
  return {
    items: [
      { type: "action", action: { type: "message", label: "打開服務選單", text: "打開服務選單" } },
      { type: "action", action: { type: "message", label: "最新摘要", text: "最新摘要" } },
      { type: "action", action: { type: "message", label: "我要預約", text: "我要預約" } }
    ]
  };
}

function serviceMenuFlex() {
  return {
    type: "flex",
    altText: "服務選單",
    contents: {
      type: "carousel",
      contents: [
        {
          type: "bubble",
          body: {
            type: "box",
            layout: "vertical",
            contents: [
              { type: "text", text: "🤝 服務選單", weight: "bold", size: "lg" },
              { type: "text", text: "請選擇你需要的服務", size: "sm", color: "#555555" }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              { type: "button", style: "primary", action: { type: "postback", label: "我要預約", data: "action=book", displayText: "我要預約" } },
              { type: "button", style: "secondary", action: { type: "postback", label: "配置建議", data: "action=advice", displayText: "我要配置建議" } },
              { type: "button", style: "link", action: { type: "postback", label: "查看來源", data: "action=source", displayText: "我要看資料來源" } }
            ]
          }
        }
      ]
    }
  };
}

async function replyMessage(replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Reply failed: ${res.status} ${text}`);
}

app.get("/", (_req, res) => res.send("OK webhook-postback"));

app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) return res.status(401).send("Invalid signature");

    const events = req.body.events || [];
    for (const event of events) {
      if (event.type === "postback") {
        const data = new URLSearchParams(event.postback.data || "");
        const action = data.get("action");

        if (action === "book") {
          await replyMessage(event.replyToken, [{ type: "text", text: "收到✅ 已開啟預約流程，請回覆：姓名＋方便時段。", quickReply: quickMenuItems() }]);
        } else if (action === "advice") {
          await replyMessage(event.replyToken, [{ type: "text", text: "好的，請回覆：投資期間、風險偏好、每月預算，我幫你做配置建議。", quickReply: quickMenuItems() }]);
        } else if (action === "source") {
          await replyMessage(event.replyToken, [{ type: "text", text: "資料來源：https://kgilife.moneydj.com/", quickReply: quickMenuItems() }]);
        } else {
          await replyMessage(event.replyToken, [{ type: "text", text: "已收到你的操作，我會接續服務你。", quickReply: quickMenuItems() }]);
        }
        continue;
      }

      if (event.type === "message" && event.message.type === "text") {
        const text = (event.message.text || "").trim();

        if (["選單", "服務", "menu", "開始"].includes(text)) {
          await replyMessage(event.replyToken, [
            { type: "text", text: "點下方按鈕打開服務選單👇", quickReply: quickMenuItems() }
          ]);
          continue;
        }

        if (text === "打開服務選單") {
          await replyMessage(event.replyToken, [serviceMenuFlex()]);
          continue;
        }

        if (text === "最新摘要") {
          await replyMessage(event.replyToken, [{ type: "text", text: "本週摘要已更新，回覆「打開服務選單」可查看完整服務。", quickReply: quickMenuItems() }]);
          continue;
        }

        if (text === "我要預約") {
          await replyMessage(event.replyToken, [{ type: "text", text: "好的，請回覆：姓名＋方便時段。", quickReply: quickMenuItems() }]);
          continue;
        }
      }
    }

    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("ERR");
  }
});

app.listen(PORT, () => console.log(`webhook-postback on :${PORT}`));
