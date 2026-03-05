#!/usr/bin/env python3
"""Utility to send LINE messages (broadcast or targeted push)."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Iterable

import requests

CREDENTIALS_PATH = Path("automation/config/line_credentials.json")
LINE_BROADCAST_URL = "https://api.line.me/v2/bot/message/broadcast"
LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"


def load_credentials() -> dict:
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
    secret = os.getenv("LINE_CHANNEL_SECRET")
    if token and secret:
        return {
            "channel_access_token": token,
            "channel_secret": secret,
        }
    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            "Missing LINE credentials. Set LINE_CHANNEL_ACCESS_TOKEN/LINE_CHANNEL_SECRET env vars "
            f"or provide {CREDENTIALS_PATH}"
        )
    return json.loads(CREDENTIALS_PATH.read_text())


def build_messages(text: str, image_url: str | None, preview_url: str | None) -> list[dict]:
    messages: list[dict] = []
    if image_url:
        messages.append(
            {
                "type": "image",
                "originalContentUrl": image_url,
                "previewImageUrl": preview_url or image_url,
            }
        )
    messages.append({"type": "text", "text": text})
    return messages


def broadcast_message(messages: list[dict]) -> dict:
    creds = load_credentials()
    headers = {
        "Authorization": f"Bearer {creds['channel_access_token']}",
        "Content-Type": "application/json",
    }
    payload = {"messages": messages}
    resp = requests.post(LINE_BROADCAST_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json() if resp.text else {}


def push_message(user_id: str, messages: list[dict]) -> dict:
    creds = load_credentials()
    headers = {
        "Authorization": f"Bearer {creds['channel_access_token']}",
        "Content-Type": "application/json",
    }
    payload = {"to": user_id, "messages": messages}
    resp = requests.post(LINE_PUSH_URL, headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json() if resp.text else {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send LINE messages")
    parser.add_argument("--text", type=str, help="Text message content")
    parser.add_argument("--image-url", type=str, help="Original content URL for image")
    parser.add_argument("--preview-url", type=str, help="Preview image URL (defaults to image URL)")
    parser.add_argument(
        "--user-id",
        action="append",
        dest="user_ids",
        help="Target userId for push (repeatable). Leave empty to broadcast",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    text = args.text or (
        "【系統測試】自動推播通道已連線成功。"
        "若你收到這則訊息，代表 LINE Broadcast API 正常可用。"
    )
    messages = build_messages(text, args.image_url, args.preview_url)

    if args.user_ids:
        for uid in args.user_ids:
            result = push_message(uid, messages)
            print(f"Push sent to {uid}", result)
    else:
        result = broadcast_message(messages)
        print("Broadcast sent", result)


if __name__ == "__main__":
    main()
