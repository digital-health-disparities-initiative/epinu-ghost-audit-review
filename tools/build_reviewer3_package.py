#!/usr/bin/env python3
"""Build the Reviewer 3 reviewer-facing package.

Reviewer 3 independently verifies whether an annotation defect objectively
exists. They see the original image with the CURRENT GT boxes and class labels,
and nothing else -- no model predictions, no FP/FN/TP markers, no experimental
condition, no Reviewer 1/2 judgement, no original file name.

Inputs
  data/reviewer3_verification_selection_researcher.csv   researcher-only, fixed
  <audit>/images/                                        original source images
  <audit>/_annotations.coco.json                         current GT

Outputs (reviewer-facing, safe to publish)
  data/reviewer3/images/R3_XXXX.jpg   GT-only renders
  data/reviewer3/tasks.json           task_id + image path only

The selection is used exactly as given: this script never re-selects, re-samples
or reorders. Rendering reads the source image and the COCO annotations only --
data/vis and the ghost visualisations are never opened.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gt_render import load_coco, load_font, render_gt_only  # noqa: E402

SITE_ROOT = Path(__file__).resolve().parents[1]
# Override the research repository location with EPINU_RESEARCH_ROOT.
RESEARCH_ROOT = Path(
    os.environ.get("EPINU_RESEARCH_ROOT", SITE_ROOT.parent / "epinu-rfdetr-training")
)
DEFAULT_AUDIT = RESEARCH_ROOT / "data/claim2/ghost_audit/audit"
SELECTION_CSV = SITE_ROOT / "data" / "reviewer3_verification_selection_researcher.csv"

EXPECTED_TASKS = 47
EXPECTED_LINKED_OBSERVATIONS = 61

# Columns that must never reach anything the reviewer can load.
RESEARCHER_ONLY_COLUMNS = [
    "original_file_name",
    "gt_only_source_image_path",
    "linked_primary_task_ids",
    "linked_reviewers",
    "linked_conditions",
    "linked_primary_outcomes",
    "selection_reason",
    "no_sample_seed",
]

results: list[tuple[str, str, bool, str]] = []


def check(section: str, name: str, ok: bool, detail: str = "") -> bool:
    results.append((section, name, bool(ok), detail))
    return bool(ok)


def die(message: str) -> None:
    print(f"\nERROR: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--selection", type=Path, default=SELECTION_CSV)
    parser.add_argument("--force", action="store_true",
                        help="regenerate even if the output already exists")
    args = parser.parse_args()

    if not args.selection.is_file():
        die(
            f"researcher selection file not found: {args.selection}\n"
            "Not regenerating it under a different rule -- the selection is fixed. "
            "Please point --selection at the correct file."
        )
    images_dir = args.audit_dir / "images"
    coco_path = args.audit_dir / "_annotations.coco.json"
    for path in (images_dir, coco_path):
        if not path.exists():
            die(f"input not found: {path}")

    out_dir = SITE_ROOT / "data" / "reviewer3"
    img_dir = out_dir / "images"
    if img_dir.exists() and any(img_dir.iterdir()) and not args.force:
        die(
            f"{img_dir} already exists and is not empty.\n"
            "Refusing to overwrite in case a review is in progress. "
            "Re-run with --force to rebuild."
        )
    if out_dir.exists():
        shutil.rmtree(out_dir)
    img_dir.mkdir(parents=True)

    rows = list(csv.DictReader(args.selection.open(encoding="utf-8")))

    image_by_name, anns_by_image = load_coco(coco_path)

    font = load_font(13)
    tasks = []
    unresolved = []
    rendered = 0

    for row in rows:
        task_id = row["r3_task_id"]
        original = row["original_file_name"]
        src = images_dir / original
        meta = image_by_name.get(original)
        if not src.is_file() or meta is None:
            unresolved.append((task_id, original, "source image or COCO entry missing"))
            continue
        dest = img_dir / f"{task_id}.jpg"
        render_gt_only(src, anns_by_image[meta["id"]], dest, font)
        rendered += 1
        # Reviewer-facing payload: the neutral task id and its image. Nothing else.
        tasks.append({"task_id": task_id, "image": f"images/{task_id}.jpg"})

    if unresolved:
        print("\nFAIL: unresolved Reviewer 3 images")
        for task_id, original, reason in unresolved:
            print(f"  {task_id}: {reason}")

    (out_dir / "tasks.json").write_text(
        json.dumps(
            {"reviewer_id": "reviewer3", "task_count": len(tasks), "tasks": tasks},
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )

    # ---------------------------------------------------------------- checks
    ids = [t["task_id"] for t in tasks]
    originals = [r["original_file_name"] for r in rows]
    linked = [t for r in rows for t in r["linked_primary_task_ids"].split(";") if t]

    check("selection", f"selection rows == {EXPECTED_TASKS}", len(rows) == EXPECTED_TASKS,
          f"got {len(rows)}")
    check("selection", f"linked primary observations == {EXPECTED_LINKED_OBSERVATIONS}",
          len(linked) == EXPECTED_LINKED_OBSERVATIONS, f"got {len(linked)}")
    check("selection", "linked primary task ids are unique",
          len(set(linked)) == len(linked))
    check("selection", "each source image appears exactly once (reviewed once only)",
          len(set(originals)) == len(originals),
          f"{len(set(originals))} unique / {len(originals)} rows")

    check("tasks", f"task count == {EXPECTED_TASKS}", len(ids) == EXPECTED_TASKS,
          f"got {len(ids)}")
    check("tasks", "task ids are R3_0001 .. R3_%04d in order" % EXPECTED_TASKS,
          ids == [f"R3_{i:04d}" for i in range(1, EXPECTED_TASKS + 1)])
    check("tasks", "no duplicate task id", len(set(ids)) == len(ids))
    check("tasks", "unresolved source images == 0", not unresolved,
          f"{len(unresolved)} unresolved" if unresolved else "")

    files = sorted(p.name for p in img_dir.iterdir() if p.is_file())
    check("images", f"generated images == {EXPECTED_TASKS}", len(files) == EXPECTED_TASKS,
          f"got {len(files)}")
    check("images", "image file names match task ids",
          files == sorted(f"{i}.jpg" for i in ids))
    check("images", "every render kept the source image dimensions",
          all(
              Image.open(img_dir / f"{r['r3_task_id']}.jpg").size
              == Image.open(images_dir / r["original_file_name"]).size
              for r in rows
          ))
    check("images", "source images untouched",
          all((images_dir / r["original_file_name"]).is_file() for r in rows))

    payload_text = (out_dir / "tasks.json").read_text(encoding="utf-8")
    keys = {k for t in tasks for k in t}
    check("privacy", "tasks.json exposes only task_id and image path",
          keys == {"task_id", "image"}, f"keys={sorted(keys)}")
    check("privacy", "no original file name in tasks.json",
          not any(o in payload_text for o in originals))
    leaked_cols = [
        c for c in RESEARCHER_ONLY_COLUMNS
        if any(str(r[c]) and str(r[c]) in payload_text for r in rows[:5])
    ]
    check("privacy", "no researcher-only column value in tasks.json",
          not leaked_cols, f"leaked: {leaked_cols}" if leaked_cols else "")
    for term in ["random", "ghost", "condition", "outcome", "reviewer1", "reviewer2",
                 "fp", "fn", "model"]:
        check("privacy", f"tasks.json contains no '{term}'",
              term not in payload_text.lower().replace("reviewer_id", ""))

    # ------------------------------------------------------------------ done
    section = None
    for sec, name, ok, detail in results:
        if sec != section:
            print(f"\n[{sec}]")
            section = sec
        line = f"  {'PASS' if ok else 'FAIL'}  {name}"
        if detail:
            line += f"  -- {detail}"
        print(line)

    failed = [r for r in results if not r[2]]
    print("\n" + "=" * 60)
    print(f"rendered {rendered} GT-only images -> {img_dir}")
    if failed:
        print(f"RESULT: FAIL ({len(failed)} of {len(results)})")
        return 1
    print(f"RESULT: PASS ({len(results)} checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
