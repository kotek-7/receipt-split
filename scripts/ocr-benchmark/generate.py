#!/usr/bin/env python3
"""Generate reproducible synthetic receipt photos; requires Pillow and Noto CJK."""

import argparse
import json
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


FIXTURES = [
    (
        "supermarket",
        [
            "国産豚肉こま切れ", "北海道牛乳１Ｌ", "絹ごし豆腐３個入", "ほうれん草",
            "千切りキャベツ", "炭火焼き鳥もも串", "天然水５５０ｍｌ", "完熟トマト",
            "チョコレートアイス", "濃厚チーズケーキ",
        ],
        [598, 218, 128, 158, 108, 428, 88, 298, 178, 328],
    ),
    (
        "restaurant",
        [
            "鶏の唐揚げ定食", "炭火焼き鯖定食", "ねぎ塩牛タン焼き", "海老と野菜の天ぷら",
            "ほうれん草のおひたし", "明太子だし巻き卵", "特製つくね盛り合わせ", "抹茶わらび餅",
            "生ビール中ジョッキ", "ジンジャーエール",
        ],
        [980, 1080, 1480, 780, 380, 580, 880, 480, 590, 350],
    ),
    (
        "convenience",
        [
            "手巻おにぎり鮭", "ツナマヨネーズ", "北海道産じゃがいも", "ふんわり食パン６枚",
            "カフェラテＬサイズ", "天然水５００ｍｌ", "濃い抹茶ラテ", "燻製チーズおつまみ",
            "ＳＡＬＡＤチキン", "チョコ＆クッキー",
        ],
        [168, 158, 198, 178, 230, 98, 188, 298, 248, 148],
    ),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path,
                        default=Path(tempfile.gettempdir()) / "reciwake-ocr-benchmark")
    parser.add_argument("--font", type=Path,
                        default=Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"))
    args = parser.parse_args()
    if not args.font.is_file():
        parser.error("Install fonts-noto-cjk or provide --font /path/to/NotoSansCJK-Regular.ttc")
    args.directory.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(str(args.font), 30, index=0)
    small = ImageFont.truetype(str(args.font), 26, index=0)
    title = ImageFont.truetype(str(args.font), 42, index=0)
    manifest = []

    for index, (slug, names, amounts) in enumerate(FIXTURES):
        photo = Image.new("RGB", (900, 2700), (233, 232, 229))
        draw = ImageDraw.Draw(photo)
        draw.rectangle((80, 45, 820, 2650), fill=(249, 248, 243))
        draw.text((235, 155), "お買い上げ明細", font=title, fill=(42, 42, 42))
        draw.text((133, 275), "2026/09/29 18:42", font=small, fill=(73, 73, 73))
        draw.text((133, 325), "レジ 03    担当 107", font=small, fill=(73, 73, 73))
        draw.line((130, 430, 770, 430), fill=(125, 125, 125), width=2)
        for row, (name, amount) in enumerate(zip(names, amounts)):
            y = 525 + row * 99
            fill = (index * 9 + 55,) * 3
            draw.text((132, y), name, font=font, fill=fill)
            price = f"¥{amount:,}"
            draw.text((770 - draw.textlength(price, font=font), y), price,
                      font=font, fill=fill)
        draw.line((130, 1555, 770, 1555), fill=(125, 125, 125), width=2)
        for row, (label, amount) in enumerate([
            ("小計", sum(amounts)), ("合計", sum(amounts)),
            ("お預り", 10000), ("お釣り", 10000 - sum(amounts)),
        ]):
            y = 1645 + row * 95
            draw.text((132, y), label, font=font, fill=(55,) * 3)
            price = f"¥{amount:,}"
            draw.text((770 - draw.textlength(price, font=font), y), price,
                      font=font, fill=(55,) * 3)
        draw.text((132, 2200), "ありがとうございました", font=small, fill=(90,) * 3)
        photo = photo.filter(ImageFilter.GaussianBlur(0.40 + index * 0.1)).rotate(
            (index - 1) * 0.25,
            resample=Image.Resampling.BICUBIC,
            fillcolor=(233, 232, 229),
        )
        photo.save(args.directory / f"{slug}-source.png")
        for variant, max_edge, output_format in [
            ("baseline", 1600, "jpg"), ("detail", 3200, "png"),
        ]:
            scale = min(1, max_edge / max(photo.size),
                        (1_920_000 / (photo.width * photo.height)) ** 0.5)
            size = (int(photo.width * scale), int(photo.height * scale))
            prepared = photo.resize(size, Image.Resampling.LANCZOS)
            options = {"quality": 88} if output_format == "jpg" else {}
            prepared.save(args.directory / f"{slug}-{variant}.{output_format}", **options)
        manifest.append({
            "slug": slug,
            "expected": [{"name": name, "amount": amount}
                         for name, amount in zip(names, amounts)],
            "total": sum(amounts),
        })

    (args.directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote three synthetic receipts to {args.directory}")


if __name__ == "__main__":
    main()
