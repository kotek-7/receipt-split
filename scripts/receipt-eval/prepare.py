#!/usr/bin/env python3
"""Prepare receipt images as bounded PNG files without browser paper cropping."""

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-edge", type=int, default=3200)
    parser.add_argument("--max-pixels", type=int, default=1_920_000)
    args = parser.parse_args()
    if args.max_edge < 1 or args.max_pixels < 1:
        parser.error("--max-edge and --max-pixels must be positive")
    source_path = args.manifest.resolve()
    output = args.output.resolve()
    if output / "manifest.json" == source_path:
        parser.error("Use a separate output directory to preserve the source manifest")
    manifest = json.loads(source_path.read_text(encoding="utf-8"))
    directory = output / "images"
    directory.mkdir(parents=True, exist_ok=True)
    for index, fixture in enumerate(manifest["fixtures"]):
        source = source_path.parent / fixture["image"]
        target = directory / f"{index + 1:05d}.png"
        if target.resolve() == source.resolve():
            parser.error(f"Refusing to overwrite source image: {source}")
        with Image.open(source) as original:
            oriented = ImageOps.exif_transpose(original)
            image = oriented.convert("RGBA")
            background = Image.new("RGBA", image.size, "white")
            image = Image.alpha_composite(background, image).convert("RGB")
            width, height = image.size
            scale = min(1, args.max_edge / max(width, height),
                        math.sqrt(args.max_pixels / width / height))
            size = (max(1, math.floor(width * scale)), max(1, math.floor(height * scale)))
            if image.size != size:
                image = image.resize(size, Image.Resampling.LANCZOS)
            image.save(target)
        fixture["sourceImage"] = str(source.resolve())
        fixture["image"] = str(target.relative_to(output))
        fixture["preparedDimensions"] = {"width": size[0], "height": size[1]}
    manifest["preparation"] = {
        "engine": "Pillow",
        "maxEdge": args.max_edge,
        "maxPixels": args.max_pixels,
        "resize": "LANCZOS",
        "orientation": "EXIF transpose",
        "crop": False,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Prepared {len(manifest['fixtures'])} images: {output / 'manifest.json'}")


if __name__ == "__main__":
    main()
