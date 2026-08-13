#!/usr/bin/env python3
"""Verify this site's copy of the reviewer package against the source of truth.

Checks that the images are byte-identical copies, that the task IDs and their
order match the original review.csv exactly, and that nothing researcher-only
(assignment manifest, original file names, condition labels) leaked into any
file served by the site.

Run with: python3 tests/verify_package.py [--source <reviewers dir>]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

SITE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(
    "/Users/yutokohata/epinu-rfdetr-training/data/human_ghost_audit/reviewers"
)
REVIEWERS = ["reviewer1", "reviewer2"]
EXPECTED_TASKS = 53
CSV_COLUMNS = [
    "task_id",
    "reviewer_id",
    "defect_found",
    "defect_types",
    "target_classes_affected",
    "number_of_defects",
    "notes",
    "review_time_seconds",
]
# Terms that would reveal the experimental condition to a reviewer.
FORBIDDEN_TERMS = ["ghost", "model_guided", "random_manifest", "assignment_manifest"]

results: list[tuple[str, str, bool, str]] = []


def check(section: str, name: str, ok: bool, detail: str = "") -> bool:
    results.append((section, name, bool(ok), detail))
    return bool(ok)


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    args = parser.parse_args()
    source = args.source

    if not source.is_dir():
        print(f"ERROR: source reviewer package not found: {source}", file=sys.stderr)
        return 1

    for reviewer in REVIEWERS:
        src_images = source / reviewer / "images"
        site_images = SITE_ROOT / "data" / reviewer / "images"
        src_csv = source / reviewer / "review.csv"
        tasks_json = SITE_ROOT / "data" / reviewer / "tasks.json"

        src_names = sorted(p.name for p in src_images.iterdir() if p.is_file())
        site_names = sorted(p.name for p in site_images.iterdir() if p.is_file())

        check(reviewer, f"site images == {EXPECTED_TASKS}",
              len(site_names) == EXPECTED_TASKS, f"got {len(site_names)}")
        check(reviewer, "site images match source image names",
              site_names == src_names,
              f"missing={sorted(set(src_names) - set(site_names))} "
              f"extra={sorted(set(site_names) - set(src_names))}")

        mismatched = [
            n for n in src_names
            if n in site_names and md5(src_images / n) != md5(site_images / n)
        ]
        check(reviewer, "every copied image is byte-identical (MD5) to the source",
              not mismatched, f"mismatched: {mismatched}" if mismatched else "")

        src_ids = [r["task_id"] for r in csv.DictReader(src_csv.open(encoding="utf-8"))]
        payload = json.loads(tasks_json.read_text(encoding="utf-8"))
        site_ids = [t["task_id"] for t in payload["tasks"]]

        check(reviewer, "tasks.json task_ids equal review.csv task_ids, in the same order",
              site_ids == src_ids,
              "order or contents differ" if site_ids != src_ids else "")
        check(reviewer, "no duplicate task_id", len(set(site_ids)) == len(site_ids))
        check(reviewer, f"task count == {EXPECTED_TASKS}", len(site_ids) == EXPECTED_TASKS,
              f"got {len(site_ids)}")
        check(reviewer, "reviewer_id is correct", payload["reviewer_id"] == reviewer)

        missing_files = [t["task_id"] for t in payload["tasks"]
                         if not (SITE_ROOT / "data" / reviewer / t["image"]).is_file()]
        check(reviewer, "every task image file exists", not missing_files,
              f"missing: {missing_files}" if missing_files else "")

        keys = {k for t in payload["tasks"] for k in t}
        check(reviewer, "tasks.json exposes only task_id and image path",
              keys == {"task_id", "image"}, f"keys={sorted(keys)}")

        check(reviewer, "source review.csv untouched by this site",
              [r for r in csv.DictReader(src_csv.open(encoding="utf-8"))][0]["defect_found"] == "")

    # --- cross-reviewer -----------------------------------------------------
    ids = {}
    for reviewer in REVIEWERS:
        payload = json.loads((SITE_ROOT / "data" / reviewer / "tasks.json").read_text())
        ids[reviewer] = {t["task_id"] for t in payload["tasks"]}
    check("global", "reviewer1 and reviewer2 share no task_id",
          not (ids["reviewer1"] & ids["reviewer2"]),
          f"shared: {sorted(ids['reviewer1'] & ids['reviewer2'])}")

    r1_files = {p.name for p in (SITE_ROOT / "data/reviewer1/images").iterdir()}
    r2_files = {p.name for p in (SITE_ROOT / "data/reviewer2/images").iterdir()}
    check("global", "no image file name appears in both reviewer folders",
          not (r1_files & r2_files), f"shared: {sorted(r1_files & r2_files)}")

    # --- leak checks --------------------------------------------------------
    check("blinding", "assignment_manifest.csv is not present in the site",
          not list(SITE_ROOT.rglob("assignment_manifest.csv")))

    manifest_rows = list(csv.DictReader((source / "assignment_manifest.csv").open(encoding="utf-8")))
    originals = {r["original_file_name"] for r in manifest_rows}

    served_text = []
    for path in SITE_ROOT.rglob("*"):
        if path.is_file() and path.suffix in {".html", ".js", ".json", ".css"}:
            if ".git" in path.parts:
                continue
            served_text.append((path, path.read_text(encoding="utf-8", errors="ignore")))

    leaked = [
        str(p.relative_to(SITE_ROOT)) for p, text in served_text
        if any(name in text for name in originals)
    ]
    check("blinding", "no original file name appears in any served file",
          not leaked, f"files: {leaked}" if leaked else "")

    # "random" is allowed nowhere as a condition label; check the reviewer-facing
    # payloads and the page itself for condition vocabulary.
    condition_hits = []
    for path, text in served_text:
        lowered = text.lower()
        for term in FORBIDDEN_TERMS:
            if term in lowered:
                condition_hits.append(f"{path.relative_to(SITE_ROOT)}:{term}")
    check("blinding", "no condition vocabulary in any served file",
          not condition_hits, f"hits: {condition_hits}" if condition_hits else "")

    tasks_text = "\n".join(
        (SITE_ROOT / "data" / r / "tasks.json").read_text() for r in REVIEWERS
    )
    check("blinding", "tasks.json contains no 'condition' field",
          "condition" not in tasks_text.lower())

    # --- csv schema ---------------------------------------------------------
    core = (SITE_ROOT / "review-core.js").read_text(encoding="utf-8")
    src_header = (source / "reviewer1" / "review.csv").read_text(encoding="utf-8").splitlines()[0]
    check("csv", "review-core.js declares every existing review.csv column",
          all(f'"{c}"' in core for c in CSV_COLUMNS))
    check("csv", "existing review.csv header matches the expected schema",
          src_header == ",".join(CSV_COLUMNS), f"got {src_header}")

    # --- report -------------------------------------------------------------
    current = None
    for section, name, ok, detail in results:
        if section != current:
            print(f"\n[{section}]")
            current = section
        line = f"  {'PASS' if ok else 'FAIL'}  {name}"
        if detail:
            line += f"  -- {detail}"
        print(line)

    failed = [r for r in results if not r[2]]
    print("\n" + "=" * 60)
    if failed:
        print(f"RESULT: FAIL ({len(failed)} of {len(results)})")
        return 1
    print(f"RESULT: PASS ({len(results)} checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
