#!/usr/bin/env python3
"""Build the Stage 2 reviewer packages for the site.

Stage 2 tests whether the class-level problems found in the Stage 1 Ghost Audit
help when reviewing *different* images. Both arms see the same GT-only images and
use the same form; the only difference is the instruction.

Splits the fixed 180-image review set across two reviewers and renders the
GT-only images. The GENERAL / GHOST_INFORMED assignment comes from the manifest
and is never recomputed.

Output (reviewer-facing, safe to publish)
  data/stage2/reviewerN/images/S2_XXXX.jpg
  data/stage2/reviewerN/tasks_phase_a.json   GENERAL  -- task_id, image, class_name
  data/stage2/reviewerN/tasks_phase_b.json   GHOST_INFORMED -- + focus text

Phase A and Phase B are separate files on purpose: the Phase A payload contains
no focus text and no condition string, so nothing about the Stage 1 findings is
reachable while a reviewer is working through the general arm.

Requires: Pillow.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import shutil
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

SITE_ROOT = Path(__file__).resolve().parents[1]
RESEARCH_ROOT = Path("/Users/yutokohata/epinu-rfdetr-training")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gt_render import load_coco, load_font, render_gt_only  # noqa: E402

DEFAULT_MANIFEST = RESEARCH_ROOT / "data/claim2/stage2/stage2_review_manifest.csv"
DEFAULT_POPULATION = RESEARCH_ROOT / "data/claim2/ghost_audit/train"
DEFAULT_AUDIT = RESEARCH_ROOT / "data/claim2/ghost_audit/audit"
DEFAULT_SPLIT = RESEARCH_ROOT / "data/claim2/D_split"

REVIEWERS = ["reviewer1", "reviewer2"]
CONDITIONS = ["GENERAL", "GHOST_INFORMED"]
PER_CELL = 15          # per reviewer, per class, per condition
EXPECTED_IMAGES = 180

# Shown only in Phase B, only for that image's class.
FOCUS_TEXT = {
    "Tomato_Raw":
        "Previous Ghost Audit found repeated missing-label problems in Tomato_Raw. "
        "Please pay particular attention to visible tomatoes that may be missing a "
        "ground-truth box.",
    "Lemon":
        "Previous Ghost Audit found repeated missing-label problems in Lemon. "
        "Please pay particular attention to visible lemons that may be missing a "
        "ground-truth box.",
    "RedOnion_Raw":
        "Previous Ghost Audit found repeated bounding-box problems in RedOnion_Raw. "
        "Please pay particular attention to ground-truth boxes whose size or position "
        "may be incorrect.",
}

results: list[tuple[str, str, bool, str]] = []


def check(section: str, name: str, ok: bool, detail: str = "") -> bool:
    results.append((section, name, bool(ok), detail))
    return bool(ok)


def die(message: str) -> None:
    print(f"\nERROR: {message}", file=sys.stderr)
    sys.exit(1)


def coco_names(path: Path) -> set[str]:
    with path.open(encoding="utf-8") as fh:
        return {i["file_name"] for i in json.load(fh)["images"]}


CANDIDATES = 500


def _assign_cell(ordered: list[dict], rng: random.Random) -> dict[str, str]:
    """Pairwise randomisation: consecutive ranks paired, one to each reviewer."""
    out: dict[str, str] = {}
    for i in range(0, len(ordered), 2):
        a, b = ordered[i], ordered[i + 1]
        if rng.random() < 0.5:
            a, b = b, a
        out[a["task_id"]] = "reviewer1"
        out[b["task_id"]] = "reviewer2"
    return out


def assign(rows: list[dict], seed: int) -> dict[str, str]:
    """task_id -> reviewer, 15 per class x condition, matched on instance_count.

    Within each class x condition cell the images are ordered by instance count
    and taken as consecutive pairs, one image of each pair to each reviewer. That
    matches the two reviewers across the whole distribution, not just the mean,
    and guarantees the 15/15 cell counts.

    Pairwise flips alone still let the totals drift, because instance counts are
    heavy-tailed and a run of flips can land the larger image of many pairs on the
    same reviewer. So we draw CANDIDATES complete assignments from streams derived
    from the seed and keep the one with the smallest total imbalance. The result
    is still a pure function of the seed and still reproducible; it is a
    deterministic choice among equally valid randomisations, and it never looks at
    anything except the instance counts already in the manifest.
    """
    cells = defaultdict(list)
    for row in rows:
        cells[(row["class_name"], row["condition"])].append(row)
    ordered_cells = {
        key: sorted(cell, key=lambda r: (int(r["instance_count"]), r["task_id"]))
        for key, cell in cells.items()
    }
    count = {r["task_id"]: int(r["instance_count"]) for r in rows}

    def imbalance(candidate: dict[str, str]) -> tuple[int, int]:
        per_cell = 0
        per_condition = defaultdict(int)
        for key, cell in ordered_cells.items():
            diff = 0
            for row in cell:
                n = count[row["task_id"]]
                sign = 1 if candidate[row["task_id"]] == "reviewer1" else -1
                diff += sign * n
                per_condition[key[1]] += sign * n
            per_cell += abs(diff)
        # Rank on the per-cell sum first, then on the condition totals.
        return per_cell, sum(abs(v) for v in per_condition.values())

    best = None
    best_score = None
    for k in range(CANDIDATES):
        candidate: dict[str, str] = {}
        for key, cell in sorted(ordered_cells.items()):
            stream = int(hashlib.sha256(
                f"{seed}:{k}:{key[0]}:{key[1]}".encode()).hexdigest()[:12], 16)
            candidate.update(_assign_cell(cell, random.Random(stream)))
        score = imbalance(candidate)
        if best_score is None or score < best_score:
            best, best_score = candidate, score
    return best


def stats(values: list[int]) -> dict:
    v = sorted(values)
    return {
        "n": len(v), "total": sum(v), "mean": round(sum(v) / len(v), 2),
        "median": statistics.median(v), "min": v[0], "max": v[-1],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--population-dir", type=Path, default=DEFAULT_POPULATION)
    parser.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--split-dir", type=Path, default=DEFAULT_SPLIT)
    parser.add_argument("--seed", type=int, default=20260819)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not args.manifest.is_file():
        die(
            f"Stage 2 manifest not found: {args.manifest}\n"
            "Not rebuilding the review set -- the GENERAL / GHOST_INFORMED "
            "assignment is fixed. Point --manifest at the existing file."
        )
    images_dir = args.population_dir / "images"
    coco_path = args.population_dir / "_annotations.coco.json"
    for path in (images_dir, coco_path):
        if not path.exists():
            die(f"input not found: {path}")

    out_root = SITE_ROOT / "data" / "stage2"
    if out_root.exists() and any(out_root.iterdir()) and not args.force:
        die(
            f"{out_root} already exists and is not empty.\n"
            "Refusing to overwrite in case a review is in progress. "
            "Re-run with --force to rebuild."
        )
    if out_root.exists():
        shutil.rmtree(out_root)

    rows = list(csv.DictReader(args.manifest.open(encoding="utf-8")))
    if len(rows) != EXPECTED_IMAGES:
        die(f"manifest has {len(rows)} rows, expected {EXPECTED_IMAGES}")

    assignment = assign(rows, args.seed)
    image_by_name, anns = load_coco(coco_path)
    font = load_font(13)

    per_reviewer: dict[str, dict[str, list[dict]]] = {
        r: {c: [] for c in CONDITIONS} for r in REVIEWERS
    }
    mapping = []
    unresolved = []

    for reviewer in REVIEWERS:
        (out_root / reviewer / "images").mkdir(parents=True, exist_ok=True)

    for row in sorted(rows, key=lambda r: r["task_id"]):
        task_id = row["task_id"]
        reviewer = assignment[task_id]
        src = RESEARCH_ROOT / row["image_path"]
        meta = image_by_name.get(row["file_name"])
        if not src.is_file() or meta is None:
            unresolved.append((task_id, "source image or COCO entry missing"))
            continue

        dest = out_root / reviewer / "images" / f"{task_id}.jpg"
        render_gt_only(src, anns[meta["id"]], dest, font)

        entry = {"task_id": task_id, "image": f"images/{task_id}.jpg",
                 "class_name": row["class_name"]}
        if row["condition"] == "GHOST_INFORMED":
            entry["focus_information"] = FOCUS_TEXT[row["class_name"]]
        per_reviewer[reviewer][row["condition"]].append(entry)

        mapping.append({
            "task_id": task_id, "reviewer_id": reviewer,
            "class_name": row["class_name"], "condition": row["condition"],
            "file_name": row["file_name"],
            "instance_count": row["instance_count"],
        })

    if unresolved:
        print("\nFAIL: unresolved Stage 2 images")
        for task_id, reason in unresolved:
            print(f"  {task_id}: {reason}")

    for reviewer in REVIEWERS:
        for cond, fname in (("GENERAL", "tasks_phase_a.json"),
                            ("GHOST_INFORMED", "tasks_phase_b.json")):
            tasks = per_reviewer[reviewer][cond]
            (out_root / reviewer / fname).write_text(
                json.dumps({"reviewer_id": reviewer, "task_count": len(tasks),
                            "tasks": tasks}, indent=2) + "\n",
                encoding="utf-8")

    mapping_path = SITE_ROOT / "data" / "stage2_assignment_researcher.csv"
    with mapping_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["task_id", "reviewer_id", "class_name",
                                           "condition", "file_name", "instance_count"])
        w.writeheader()
        w.writerows(mapping)

    # ---------------------------------------------------------------- checks
    counts = Counter((m["reviewer_id"], m["class_name"], m["condition"]) for m in mapping)
    task_ids = [m["task_id"] for m in mapping]
    files = [m["file_name"] for m in mapping]

    check("assignment", f"unique source images == {EXPECTED_IMAGES}",
          len(set(files)) == EXPECTED_IMAGES, f"got {len(set(files))}")
    check("assignment", "no duplicate task_id", len(set(task_ids)) == len(task_ids))
    check("assignment", "no image assigned to both reviewers",
          not ({m["file_name"] for m in mapping if m["reviewer_id"] == "reviewer1"} &
               {m["file_name"] for m in mapping if m["reviewer_id"] == "reviewer2"}))
    check("assignment", "unresolved images == 0", not unresolved)
    for reviewer in REVIEWERS:
        total = sum(1 for m in mapping if m["reviewer_id"] == reviewer)
        check("assignment", f"{reviewer}: 90 tasks", total == 90, f"got {total}")
        for cond in CONDITIONS:
            n = sum(1 for m in mapping
                    if m["reviewer_id"] == reviewer and m["condition"] == cond)
            check("assignment", f"{reviewer}: {cond} == 45", n == 45, f"got {n}")
        for cls in sorted(FOCUS_TEXT):
            for cond in CONDITIONS:
                n = counts[(reviewer, cls, cond)]
                check("assignment", f"{reviewer}: {cls} x {cond} == {PER_CELL}",
                      n == PER_CELL, f"got {n}")

    check("assignment", "condition assignment matches the manifest exactly",
          {m["task_id"]: m["condition"] for m in mapping} ==
          {r["task_id"]: r["condition"] for r in rows})

    # overlap with the excluded sets
    selected = set(files)
    audit = coco_names(args.audit_dir / "_annotations.coco.json")
    valid = coco_names(args.split_dir / "valid" / "_annotations.coco.json")
    test = coco_names(args.split_dir / "test" / "_annotations.coco.json")
    check("overlap", "no overlap with the Stage 1 pseudo-test (728)",
          not (selected & audit), f"{len(selected & audit)}")
    check("overlap", "no overlap with valid", not (selected & valid))
    check("overlap", "no overlap with test", not (selected & test))
    check("overlap", "all images come from the Stage 2 population",
          selected <= coco_names(coco_path))

    for reviewer in REVIEWERS:
        img_dir = out_root / reviewer / "images"
        got = sorted(p.name for p in img_dir.iterdir() if p.is_file())
        want = sorted(f"{m['task_id']}.jpg" for m in mapping
                      if m["reviewer_id"] == reviewer)
        check("images", f"{reviewer}: 90 rendered images", len(got) == 90, f"got {len(got)}")
        check("images", f"{reviewer}: image names match task ids", got == want)

    # information control
    phase_a_text = "\n".join(
        (out_root / r / "tasks_phase_a.json").read_text(encoding="utf-8") for r in REVIEWERS)
    phase_b_text = "\n".join(
        (out_root / r / "tasks_phase_b.json").read_text(encoding="utf-8") for r in REVIEWERS)
    for term in ["focus", "ghost", "general", "missing-label", "missing_label",
                 "bbox", "condition", "stage 1", "previous"]:
        check("info_control", f"Phase A payload contains no '{term}'",
              term not in phase_a_text.lower())
    check("info_control", "Phase A exposes only task_id, image and class_name",
          {k for r in REVIEWERS
           for t in json.loads((out_root / r / "tasks_phase_a.json").read_text())["tasks"]
           for k in t} == {"task_id", "image", "class_name"})
    check("info_control", "Phase B carries the focus text for every task",
          all(t.get("focus_information") for r in REVIEWERS
              for t in json.loads((out_root / r / "tasks_phase_b.json").read_text())["tasks"]))
    check("info_control", "Phase B focus text matches the task's class",
          all(t["focus_information"] == FOCUS_TEXT[t["class_name"]] for r in REVIEWERS
              for t in json.loads((out_root / r / "tasks_phase_b.json").read_text())["tasks"]))
    for text, label in ((phase_a_text, "Phase A"), (phase_b_text, "Phase B")):
        check("info_control", f"{label} payload carries no original file name",
              not any(f in text for f in files))
        for term in ["prediction", "_eval", "fp", "fn", "confidence"]:
            check("info_control", f"{label} payload contains no '{term}'",
                  term not in text.lower())

    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "data/stage2_assignment_researcher.csv"],
        cwd=SITE_ROOT, capture_output=True).returncode == 0
    check("info_control", "researcher assignment file is git-ignored", ignored)

    # reproducibility
    check("reproducibility", f"assignment is reproducible from seed={args.seed}",
          assign(rows, args.seed) == assignment)

    # ------------------------------------------------------------------ report
    print("\n" + "=" * 78)
    print("STAGE 2 REVIEWER PACKAGES")
    print("=" * 78)
    for reviewer in REVIEWERS:
        mine = [m for m in mapping if m["reviewer_id"] == reviewer]
        print(f"\n{reviewer}: {len(mine)} tasks")
        for cond in CONDITIONS:
            sub = [m for m in mine if m["condition"] == cond]
            s = stats([int(m["instance_count"]) for m in sub])
            per_class = Counter(m["class_name"] for m in sub)
            print(f"  {cond:<15} n={s['n']:>3}  instances={s['total']:>5} "
                  f"mean={s['mean']:>6.2f} med={s['median']:>5} "
                  f"[{dict(sorted(per_class.items()))}]")
    print("\ninstance balance between reviewers:")
    for cond in CONDITIONS:
        a = sum(int(m["instance_count"]) for m in mapping
                if m["reviewer_id"] == "reviewer1" and m["condition"] == cond)
        b = sum(int(m["instance_count"]) for m in mapping
                if m["reviewer_id"] == "reviewer2" and m["condition"] == cond)
        print(f"  {cond:<15} r1={a:>5}  r2={b:>5}  diff={abs(a-b):>4} "
              f"({100*abs(a-b)/((a+b)/2):.1f}%)")

    print("\n" + "=" * 78)
    print("VALIDATION")
    print("=" * 78, end="")
    section = None
    for sec, name, ok, detail in results:
        if sec != section:
            print(f"\n[{sec}]")
            section = sec
        line = f"  {'PASS' if ok else 'FAIL'}  {name}"
        if detail and not ok:
            line += f"  -- {detail}"
        print(line)

    failed = [r for r in results if not r[2]]
    print()
    if failed:
        print(f"RESULT: FAIL ({len(failed)} of {len(results)})")
        return 1
    print(f"RESULT: PASS ({len(results)} checks)")
    print(f"\nOutput: {out_root}\nResearcher mapping: {mapping_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
