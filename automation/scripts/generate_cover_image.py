#!/usr/bin/env python3
"""Generate a cover image via Gemini 3.1 Flash Image (Nano Banana 2)."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
from typing import Sequence

import requests

CREDENTIALS_PATH = Path("automation/config/gemini_credentials.json")
MODEL_NAME = "gemini-3.1-flash-image-preview"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent"
DEFAULT_OUTPUT = Path("artifacts/gemini_digest_cover.png")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Gemini cover image")
    parser.add_argument("--title", type=str, default="基金快訊｜測試")
    parser.add_argument("--subtitle", type=str, default="安聯收益成長-AM穩定月收")
    parser.add_argument("--bullet", action="append", dest="bullets", help="Bullet lines (can repeat)")
    parser.add_argument("--output", type=str, help="Output file path", default=str(DEFAULT_OUTPUT))
    return parser.parse_args()


def load_api_key() -> str:
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key:
        return api_key
    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            "Missing Gemini credentials. Set GEMINI_API_KEY env var or provide " f"{CREDENTIALS_PATH}"
        )
    data = json.loads(CREDENTIALS_PATH.read_text())
    return data["api_key"]


def build_prompt(title: str, subtitle: str, bullets: Sequence[str]) -> str:
    joined = "\n".join(f"- {item}" for item in bullets)
    return (
        "Design a 1:1 Mandarin financial infographic with this layout: "
        "top blue header bar (主標 + 副標 + 日期/小圖示), "
        "center section with three numbered cards (icon + 1 行主句 + 1 行補充), "
        "bottom strategy strip with three mini cards (icon + 建議). "
        "Use deep navy gradient background, white/sky blue blocks, modern sans-serif, ample spacing, "
        "font slightly smaller for readability. No photos or people, use flat icons only. Include the following text:"
        f"\n主標題：{title}\n副標題：{subtitle}\n要點：\n{joined}\n"
        "Keep wording short (<=12 字/行) and visually balanced."
    )


def generate_image(prompt: str) -> bytes:
    api_key = load_api_key()
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt}
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {
                "aspectRatio": "1:1",
                "imageSize": "1K"
            }
        }
    }
    resp = requests.post(
        API_URL,
        params={"key": api_key},
        headers={"Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    try:
        b64 = data["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    except (KeyError, IndexError) as exc:  # noqa: BLE001
        raise RuntimeError(f"Unexpected response: {data}") from exc
    return base64.b64decode(b64)


def main() -> None:
    args = parse_args()
    bullets = args.bullets or [
        "72.73 (+0.83%) 最新 NAV",
        "高收債回落，月配資金控曝 30%",
        "美元走勢未定：分批加碼",
    ]
    prompt = build_prompt(args.title, args.subtitle, bullets)
    binary = generate_image(prompt)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(binary)
    print(f"Saved Gemini cover to {output_path}")


if __name__ == "__main__":
    main()
