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
import subprocess
import sys
from pathlib import Path

SITE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(
    "/Users/yutokohata/epinu-rfdetr-training/data/human_ghost_audit/reviewers"
)
REVIEWERS = ["reviewer1", "reviewer2"]
EXPECTED_TASKS = 53
R3_EXPECTED_TASKS = 47
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

    # --- reviewer 3 ---------------------------------------------------------
    r3_dir = SITE_ROOT / "data" / "reviewer3"
    selection = SITE_ROOT / "data" / "reviewer3_verification_selection_researcher.csv"

    if not selection.is_file():
        print(f"ERROR: reviewer 3 selection file not found: {selection}",
              file=sys.stderr)
        return 1

    sel_rows = list(csv.DictReader(selection.open(encoding="utf-8")))
    r3_payload = json.loads((r3_dir / "tasks.json").read_text(encoding="utf-8"))
    r3_ids = [t["task_id"] for t in r3_payload["tasks"]]
    r3_files = sorted(p.name for p in (r3_dir / "images").iterdir() if p.is_file())
    sel_originals = [r["original_file_name"] for r in sel_rows]

    check("reviewer3", f"task count == {R3_EXPECTED_TASKS}",
          len(r3_ids) == R3_EXPECTED_TASKS, f"got {len(r3_ids)}")
    check("reviewer3", "task ids match the fixed selection, in order",
          r3_ids == [r["r3_task_id"] for r in sel_rows])
    check("reviewer3", "no duplicate task id", len(set(r3_ids)) == len(r3_ids))
    check("reviewer3", "no duplicate source image (each reviewed once)",
          len(set(sel_originals)) == len(sel_originals))
    check("reviewer3", f"images == {R3_EXPECTED_TASKS}",
          len(r3_files) == R3_EXPECTED_TASKS, f"got {len(r3_files)}")
    check("reviewer3", "image names match task ids",
          r3_files == sorted(f"{i}.jpg" for i in r3_ids))
    check("reviewer3", "tasks.json exposes only task_id and image path",
          {k for t in r3_payload["tasks"] for k in t} == {"task_id", "image"})
    check("reviewer3", "reviewer_id is reviewer3",
          r3_payload["reviewer_id"] == "reviewer3")

    # Reviewer 3 images must be GT-only renders of the audit originals, never a
    # model visualisation. Matching a Reviewer 1/2 *GT-only* image is expected and
    # correct -- same renderer, same source -- so the comparison is against the
    # ghost visualisations specifically.
    vis_dirs = [
        Path("/Users/yutokohata/epinu-rfdetr-training/data/human_ghost_audit/model_guided_primary"),
        Path("/Users/yutokohata/epinu-rfdetr-training/data/vis"),
    ]
    vis_hashes = set()
    for d in vis_dirs:
        if d.is_dir():
            vis_hashes |= {md5(p) for p in d.iterdir() if p.is_file()}
    r3_hashes = {md5(r3_dir / "images" / f) for f in r3_files}
    check("reviewer3", "no Reviewer 3 image is a model visualisation",
          not (r3_hashes & vis_hashes),
          f"{len(r3_hashes & vis_hashes)} match a vis file")
    check("reviewer3", "every Reviewer 3 image is distinct",
          len(r3_hashes) == len(r3_files))

    # Positive control: a Reviewer 3 image of a source that also has a GT-only
    # Reviewer 1/2 image should be byte-identical, proving the same GT renderer.
    r12_hashes = {md5(p) for r in REVIEWERS
                  for p in (SITE_ROOT / "data" / r / "images").iterdir() if p.is_file()}
    check("reviewer3", "GT-only renders reproduce the Reviewer 1/2 GT rendering",
          bool(r3_hashes & r12_hashes),
          f"{len(r3_hashes & r12_hashes)} of {len(r3_hashes)} match a GT-only image")

    # --- reviewer 3 privacy -------------------------------------------------
    check("r3_privacy", "researcher selection CSV is git-ignored",
          "reviewer3_verification_selection_researcher.csv"
          in (SITE_ROOT / ".gitignore").read_text(encoding="utf-8"))

    r3_text = (r3_dir / "tasks.json").read_text(encoding="utf-8")
    check("r3_privacy", "no original file name in reviewer3 tasks.json",
          not any(o in r3_text for o in sel_originals))
    for col in ["linked_primary_task_ids", "linked_reviewers", "linked_conditions",
                "linked_primary_outcomes", "selection_reason"]:
        values = {r[col] for r in sel_rows if r[col]}
        check("r3_privacy", f"no {col} value in reviewer3 tasks.json",
              not any(v in r3_text for v in values))
    for term in ["random", "ghost", "condition", "model", "fp", "fn",
                 "outcome", "linked"]:
        check("r3_privacy", f"reviewer3 tasks.json has no '{term}'",
              term not in r3_text.lower())

    # The Reviewer 3 instructions block must not mention model output.
    html = (SITE_ROOT / "index.html").read_text(encoding="utf-8")
    r3_block = html.split('id="instr-r3"')[1].split("/instr-r3")[0].lower()
    check("r3_privacy", "reviewer3 instructions never mention random/ghost",
          "random" not in r3_block and "ghost" not in r3_block)
    check("r3_privacy", "reviewer3 instructions state it is independent verification",
          "independent verification" in r3_block)
    check("r3_privacy", "reviewer3 instructions say such info is intentionally not shown",
          "intentionally not shown" in r3_block)

    # --- reviewer 1/2 unchanged --------------------------------------------
    for reviewer in REVIEWERS:
        payload = json.loads(
            (SITE_ROOT / "data" / reviewer / "tasks.json").read_text(encoding="utf-8"))
        check("unchanged", f"{reviewer} still has {EXPECTED_TASKS} tasks",
              payload["task_count"] == EXPECTED_TASKS, f"got {payload['task_count']}")
        check("unchanged", f"{reviewer} task ids/order untouched",
              [t["task_id"] for t in payload["tasks"]]
              == [r["task_id"] for r in
                  csv.DictReader((source / reviewer / "review.csv").open(encoding="utf-8"))])
    check("unchanged", "reviewer3 shares no task id with reviewer 1/2",
          not (set(r3_ids) & (ids["reviewer1"] | ids["reviewer2"])))

    # --- final adjudication -------------------------------------------------
    adj_dir = SITE_ROOT / "data" / "final_adjudication"
    if adj_dir.is_dir():
        payload = json.loads((adj_dir / "queue.json").read_text(encoding="utf-8"))
        entries = payload["entries"]
        qids = [e["queue_id"] for e in entries]
        gt = sorted(p.name for p in (adj_dir / "images").iterdir() if p.is_file())
        mv = sorted(p.name for p in (adj_dir / "images_model").iterdir() if p.is_file())

        check("adjudication", "queue has 26 entries", len(entries) == 26, f"got {len(entries)}")
        check("adjudication", "no duplicate queue_id", len(set(qids)) == len(qids))
        check("adjudication", "26 GT-only images", len(gt) == 26, f"got {len(gt)}")
        check("adjudication", "every entry's GT image exists",
              all((adj_dir / e["gt_image"]).is_file() for e in entries))
        check("adjudication", "model views exist exactly where declared",
              mv == sorted(Path(e["model_image"]).name for e in entries if e["model_image"]))
        check("adjudication", "every entry has a primary review and a Reviewer 3 result",
              all(e["primary_reviews"] and e["reviewer3"]["decision"] for e in entries))
        check("adjudication", "queue.json carries no original file name",
              not any(m["original_file_name"] in json.dumps(payload)
                      for m in csv.DictReader(
                          (SITE_ROOT / "data"
                           / "final_adjudication_mapping_researcher.csv").open(encoding="utf-8"))))
        for name in ("Claim2_Human_Ghost_Audit_Final_Confirmation_List.xlsx",
                     "final_adjudication_mapping_researcher.csv"):
            check("adjudication", f"{name} is git-ignored",
                  subprocess.run(["git", "check-ignore", "-q", f"data/{name}"],
                                 cwd=SITE_ROOT, capture_output=True).returncode == 0)
        check("adjudication", "no workbook is tracked by git",
              not subprocess.run(["git", "ls-files", "*.xlsx"], cwd=SITE_ROOT,
                                 capture_output=True, text=True).stdout.strip())

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
