#!/usr/bin/env python3
"""Generate a square cover image for fund/news digest."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT_PATH = Path("artifacts/test_digest_cover.png")
FONT_PATH = "/System/Library/Fonts/PingFang.ttc"
TITLE = "基金快訊｜測試"
SUBTITLE = "安聯收益成長-AM穩定月收"
BULLETS = [
    "72.73 (+0.83%) 最新 NAV",
    "高收債回穩，月配資金控曝 30%",
    "美元走勢未定，記得分批再投入",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    width = height = 1080
    img = Image.new("RGB", (width, height), "#0b172a")

    # Create a gradient overlay
    for y in range(height):
        ratio = y / height
        r = int(14 + ratio * 30)
        g = int(32 + ratio * 60)
        b = int(66 + ratio * 80)
        ImageDraw.Draw(img).line([(0, y), (width, y)], fill=(r, g, b))

    draw = ImageDraw.Draw(img)
    title_font = load_font(80)
    subtitle_font = load_font(50)
    bullet_font = load_font(42)

    y_pos = 120
    draw.text((80, y_pos), TITLE, font=title_font, fill="#ffffff")
    y_pos += 120
    draw.text((80, y_pos), SUBTITLE, font=subtitle_font, fill="#cdd7f6")
    y_pos += 100

    bullet_prefix = "• "
    for bullet in BULLETS:
        draw.text((80, y_pos), bullet_prefix + bullet, font=bullet_font, fill="#f5f7ff")
        y_pos += 90

    footer_font = load_font(36)
    draw.text((80, height - 140), "數據來源：MoneyDJ（2026/03/04）", font=footer_font, fill="#9fb7ff")
    draw.text((80, height - 80), "JP 保險日報｜測試稿", font=footer_font, fill="#9fb7ff")

    img.save(OUTPUT_PATH)
    print(f"Saved cover to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
