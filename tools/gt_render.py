"""Shared GT-only rendering.

One renderer for every GT-only image on the site (Reviewer 1/2 random images,
Reviewer 3, Final Adjudication) so they are pixel-identical for the same source.
Reads the source image and the COCO annotations only -- never a model
visualisation.
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

GT_COLOR = (0, 200, 0)
GT_LABEL_PREFIX = "GT:"
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/Arial.ttf",
]


def load_font(size: int = 13):
    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def load_coco(coco_path: Path):
    """Returns (image_by_name, annotations_by_image_id)."""
    with Path(coco_path).open(encoding="utf-8") as fh:
        coco = json.load(fh)
    cat_name = {c["id"]: c["name"] for c in coco["categories"]}
    image_by_name = {img["file_name"]: img for img in coco["images"]}
    anns = defaultdict(list)
    for ann in coco["annotations"]:
        anns[ann["image_id"]].append((cat_name[ann["category_id"]], ann["bbox"]))
    return image_by_name, anns


def render_gt_only(src_image: Path, annotations, dest: Path, font) -> None:
    """Draw the current GT boxes + class labels. No model information at all."""
    with Image.open(src_image) as img:
        canvas = img.convert("RGB")
    draw = ImageDraw.Draw(canvas)

    for class_name, bbox in annotations:
        x, y, w, h = bbox
        x0, y0, x1, y1 = x, y, x + w, y + h
        draw.rectangle([x0, y0, x1, y1], outline=GT_COLOR, width=2)

        label = f"{GT_LABEL_PREFIX}{class_name}"
        tx0, ty0, tx1, ty1 = draw.textbbox((0, 0), label, font=font)
        tw, th = tx1 - tx0, ty1 - ty0
        lx = min(max(0, x0), max(0, canvas.width - tw))
        ly = y0 - th - 2 if y0 - th - 2 >= 0 else min(y0 + 2, canvas.height - th)
        draw.text((lx, ly), label, fill=GT_COLOR, font=font)

    canvas.save(dest, format="JPEG", quality=95)
