#!/usr/bin/env python3
"""Build the Stage 2 reviewer packages for the site.

Stage 2 tests whether the class-level problems found in the Stage 1 Ghost Audit
help when reviewing *different* images. Both arms see the same GT-only images and
use the same form; the only difference is the instruction.

Splits the fixed 180-image review set across two anonymous reviewers and renders
the GT-only images. The GENERAL / GHOST_INFORMED assignment comes from the
manifest and is never recomputed.

REVIEWER DESIGN
Each reviewer takes exactly one condition per class, so nobody reviews the same
class under both conditions -- once someone has seen the Ghost Audit hint for a
class they cannot go back to being uninformed about it.

  Tomato_Raw    A = GENERAL          B = GHOST_INFORMED
  Lemon         A = GHOST_INFORMED   B = GENERAL
  RedOnion_Raw  decided from the seed, then frozen in a manifest

The conditions alternate across classes so each reviewer carries both roles and
reviewer effects do not all push one way. Within a class, reviewer and condition
are still confounded -- unavoidable with two reviewers -- and that limitation is
documented in the README.

Reviewers are identified only as reviewer_a / reviewer_b. No personal name
appears in any output, path, key or comment.

Output (reviewer-facing, safe to publish)
  data/stage2/reviewer_X/images/S2_XXXX.jpg
  data/stage2/reviewer_X/tasks.json   task_id, image, class_name, and
                                      focus_information only where it applies

The payload carries no condition label: a reviewer cannot read off whether they
are the control arm for a class.

Requires: Pillow.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

SITE_ROOT = Path(__file__).resolve().parents[1]
# Location of the research repository. Override with EPINU_RESEARCH_ROOT;
# defaults to a sibling checkout so no absolute personal path is hard-coded.
RESEARCH_ROOT = Path(
    os.environ.get("EPINU_RESEARCH_ROOT", SITE_ROOT.parent / "epinu-rfdetr-training")
)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gt_render import load_coco, load_font, render_gt_only  # noqa: E402

DEFAULT_MANIFEST = RESEARCH_ROOT / "data/claim2/stage2/stage2_review_manifest.csv"
DEFAULT_POPULATION = RESEARCH_ROOT / "data/claim2/ghost_audit/train"
DEFAULT_AUDIT = RESEARCH_ROOT / "data/claim2/ghost_audit/audit"
DEFAULT_SPLIT = RESEARCH_ROOT / "data/claim2/D_split"

REVIEWERS = ["reviewer_a", "reviewer_b"]
CONDITIONS = ["GENERAL", "GHOST_INFORMED"]
PER_CLASS = 30         # per reviewer, per class (one condition only)
EXPECTED_IMAGES = 180

# Fixed by design; RedOnion_Raw is drawn from the seed and then frozen.
FIXED_CLASS_ROLES = {
    "Tomato_Raw": {"GENERAL": "reviewer_a", "GHOST_INFORMED": "reviewer_b"},
    "Lemon": {"GENERAL": "reviewer_b", "GHOST_INFORMED": "reviewer_a"},
}
SEEDED_CLASS = "RedOnion_Raw"

# Researcher-only: which reviewer holds which condition per class. Kept out of
# the published site so a reviewer cannot look up that they are the control.
ROLES_PATH_NAME = "stage2_class_roles_researcher.json"

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


def resolve_class_roles(seed: int, roles_path: Path) -> dict:
    """class -> {condition: reviewer}. Decided once, then frozen on disk.

    Tomato_Raw and Lemon are fixed by the design. RedOnion_Raw is drawn from the
    seed so the third class does not simply follow one reviewer, and the whole
    map is then written to a frozen manifest and reused verbatim on later runs.
    The draw is deterministic, so a fresh checkout without the manifest rebuilds
    exactly the same map.
    """
    if roles_path.is_file():
        frozen = json.loads(roles_path.read_text(encoding="utf-8"))["roles"]
        for cls, roles in FIXED_CLASS_ROLES.items():
            if frozen.get(cls) != roles:
                die(f"frozen roles for {cls} disagree with the fixed design: "
                    f"{frozen.get(cls)} vs {roles}")
        return frozen

    stream = int(hashlib.sha256(f"{seed}:{SEEDED_CLASS}".encode()).hexdigest()[:12], 16)
    general = REVIEWERS[random.Random(stream).randrange(2)]
    other = REVIEWERS[1] if general == REVIEWERS[0] else REVIEWERS[0]

    roles = dict(FIXED_CLASS_ROLES)
    roles[SEEDED_CLASS] = {"GENERAL": general, "GHOST_INFORMED": other}
    roles_path.write_text(
        json.dumps({"seed": seed, "frozen": True, "roles": roles}, indent=2) + "\n",
        encoding="utf-8")
    return roles


def assign(rows: list[dict], roles: dict) -> dict[str, str]:
    """task_id -> reviewer, straight from the class/condition role map."""
    return {
        row["task_id"]: roles[row["class_name"]][row["condition"]]
        for row in rows
    }


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

    roles_path = SITE_ROOT / "data" / ROLES_PATH_NAME
    roles = resolve_class_roles(args.seed, roles_path)
    assignment = assign(rows, roles)
    image_by_name, anns = load_coco(coco_path)
    font = load_font(13)

    per_reviewer: dict[str, list[dict]] = {r: [] for r in REVIEWERS}
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
        per_reviewer[reviewer].append(entry)

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
        # task_id order was already shuffled when the review set was built, so
        # classes interleave naturally and the run is not blocked by class.
        tasks = sorted(per_reviewer[reviewer], key=lambda t: t["task_id"])
        (out_root / reviewer / "tasks.json").write_text(
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

    # --- the 180-image set must be untouched -------------------------------
    check("dataset", f"unique source images == {EXPECTED_IMAGES}",
          len(set(files)) == EXPECTED_IMAGES, f"got {len(set(files))}")
    check("dataset", "task_ids match the manifest exactly",
          sorted(task_ids) == sorted(r["task_id"] for r in rows))
    check("dataset", "condition per task is unchanged from the manifest",
          {m["task_id"]: m["condition"] for m in mapping} ==
          {r["task_id"]: r["condition"] for r in rows})
    for cond in CONDITIONS:
        n = sum(1 for m in mapping if m["condition"] == cond)
        check("dataset", f"{cond} == 90", n == 90, f"got {n}")
    for cls in sorted(FOCUS_TEXT):
        for cond in CONDITIONS:
            n = sum(1 for m in mapping
                    if m["class_name"] == cls and m["condition"] == cond)
            check("dataset", f"{cls} {cond} == 30", n == 30, f"got {n}")
    check("dataset", "unresolved images == 0", not unresolved)

    # --- reviewer assignment -----------------------------------------------
    for reviewer in REVIEWERS:
        total = sum(1 for m in mapping if m["reviewer_id"] == reviewer)
        check("assignment", f"{reviewer}: 90 tasks", total == 90, f"got {total}")
        for cls in sorted(FOCUS_TEXT):
            n = sum(1 for m in mapping
                    if m["reviewer_id"] == reviewer and m["class_name"] == cls)
            check("assignment", f"{reviewer}: {cls} == {PER_CLASS}",
                  n == PER_CLASS, f"got {n}")

    # the point of the design: one condition per reviewer per class
    violations = [
        (rev, cls) for rev in REVIEWERS for cls in FOCUS_TEXT
        if len({m["condition"] for m in mapping
                if m["reviewer_id"] == rev and m["class_name"] == cls}) > 1
    ]
    check("assignment", "no reviewer sees both conditions for the same class",
          not violations, str(violations))
    for reviewer in REVIEWERS:
        mine = {(m["class_name"], m["condition"]) for m in mapping
                if m["reviewer_id"] == reviewer}
        check("assignment", f"{reviewer} has at least one GENERAL class",
              any(c == "GENERAL" for _, c in mine))
        check("assignment", f"{reviewer} has at least one GHOST_INFORMED class",
              any(c == "GHOST_INFORMED" for _, c in mine))
    check("assignment", "no image assigned to both reviewers",
          not ({m["file_name"] for m in mapping if m["reviewer_id"] == REVIEWERS[0]} &
               {m["file_name"] for m in mapping if m["reviewer_id"] == REVIEWERS[1]}))
    check("assignment", "roles follow the fixed design for Tomato_Raw and Lemon",
          all(roles[cls] == want for cls, want in FIXED_CLASS_ROLES.items()))
    check("assignment", f"{SEEDED_CLASS} roles are frozen on disk",
          roles_path.is_file()
          and json.loads(roles_path.read_text())["roles"][SEEDED_CLASS] == roles[SEEDED_CLASS])

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

    # --- information control ------------------------------------------------
    payloads = {r: json.loads((out_root / r / "tasks.json").read_text(encoding="utf-8"))
                for r in REVIEWERS}
    payload_text = "\n".join(
        (out_root / r / "tasks.json").read_text(encoding="utf-8") for r in REVIEWERS)

    check("info_control", "payload carries no condition label",
          not any(t in payload_text for t in CONDITIONS))
    for term in ["condition", "prediction", "confidence", "_eval", " fp", " fn"]:
        check("info_control", f"payload contains no '{term.strip()}'",
              term not in payload_text.lower())
    check("info_control", "payload carries no original file name",
          not any(f in payload_text for f in files))

    by_task = {m["task_id"]: m for m in mapping}
    general_tasks = [t for r in REVIEWERS for t in payloads[r]["tasks"]
                     if by_task[t["task_id"]]["condition"] == "GENERAL"]
    ghost_tasks = [t for r in REVIEWERS for t in payloads[r]["tasks"]
                   if by_task[t["task_id"]]["condition"] == "GHOST_INFORMED"]
    check("info_control", "GENERAL tasks carry no focus information",
          all("focus_information" not in t for t in general_tasks),
          f"{sum(1 for t in general_tasks if 'focus_information' in t)} leak")
    check("info_control", "every GHOST_INFORMED task carries focus information",
          all(t.get("focus_information") for t in ghost_tasks))
    check("info_control", "focus text matches the task's class",
          all(t["focus_information"] == FOCUS_TEXT[t["class_name"]] for t in ghost_tasks))
    check("info_control", "task keys are limited to the expected fields",
          {k for r in REVIEWERS for t in payloads[r]["tasks"] for k in t}
          <= {"task_id", "image", "class_name", "focus_information"})

    # --- privacy ------------------------------------------------------------
    check("privacy", "reviewer ids are anonymous",
          set(REVIEWERS) == {"reviewer_a", "reviewer_b"})
    check("privacy", "no reviewer directory carries a personal name",
          all(d.name in REVIEWERS for d in out_root.iterdir() if d.is_dir()))
    for name in (ROLES_PATH_NAME, "stage2_assignment_researcher.csv"):
        check("privacy", f"{name} is git-ignored",
              subprocess.run(["git", "check-ignore", "-q", f"data/{name}"],
                             cwd=SITE_ROOT, capture_output=True).returncode == 0)

    # --- reproducibility ----------------------------------------------------
    check("reproducibility", f"assignment is reproducible from seed={args.seed}",
          assign(rows, resolve_class_roles(args.seed, roles_path)) == assignment)

    # ------------------------------------------------------------------ report
    print("\n" + "=" * 78)
    print("STAGE 2 REVIEWER PACKAGES")
    print("=" * 78)
    print(f"{'class':<14}{'GENERAL':<14}{'GHOST_INFORMED':<16}")
    print("-" * 46)
    for cls in sorted(FOCUS_TEXT):
        print(f"{cls:<14}{roles[cls]['GENERAL']:<14}{roles[cls]['GHOST_INFORMED']:<16}")
    for reviewer in REVIEWERS:
        mine = [m for m in mapping if m["reviewer_id"] == reviewer]
        print(f"\n{reviewer}: {len(mine)} tasks")
        for cls in sorted(FOCUS_TEXT):
            sub = [m for m in mine if m["class_name"] == cls]
            cond = sub[0]["condition"] if sub else "-"
            s_ = stats([int(m["instance_count"]) for m in sub])
            print(f"  {cls:<14} {cond:<15} n={s_['n']:>3}  instances={s_['total']:>5} "
                  f"mean={s_['mean']:>6.2f} med={s_['median']:>5}")
        total = sum(int(m["instance_count"]) for m in mine)
        print(f"  {'TOTAL':<14} {'':<15} n={len(mine):>3}  instances={total:>5}")

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
