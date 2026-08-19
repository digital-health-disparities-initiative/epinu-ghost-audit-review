/**
 * Unit tests for review-core.js (validation, CSV building, formatting).
 * Run with: node tests/core.test.js
 *
 * These cover the pure logic only. Timer, pause, localStorage and the DOM flow
 * live in app.js and need a browser to exercise.
 */
"use strict";

const assert = require("node:assert");
const Core = require("../review-core.js");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  PASS  " + name);
  } catch (err) {
    failures.push([name, err.message]);
    console.log("  FAIL  " + name + "  -- " + err.message);
  }
}

console.log("\n[validation]");

test("no answer selected is rejected", () => {
  assert.strictEqual(Core.validateAnswer({ defectFound: null }).ok, false);
});

test("NO needs nothing else", () => {
  assert.strictEqual(Core.validateAnswer({ defectFound: "NO" }).ok, true);
});

test("AMBIGUOUS needs nothing else", () => {
  assert.strictEqual(Core.validateAnswer({ defectFound: "AMBIGUOUS" }).ok, true);
});

test("YES without defect type is rejected", () => {
  const v = Core.validateAnswer({
    defectFound: "YES", defectTypes: [], targetClasses: ["Lemon"], numberOfDefects: 1,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /defect type/);
});

test("YES without affected class is rejected", () => {
  const v = Core.validateAnswer({
    defectFound: "YES", defectTypes: ["BBOX_ERROR"], targetClasses: [], numberOfDefects: 1,
  });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /target class/);
});

test("YES with count 0 is rejected", () => {
  const v = Core.validateAnswer({
    defectFound: "YES", defectTypes: ["BBOX_ERROR"], targetClasses: ["Lemon"], numberOfDefects: 0,
  });
  assert.strictEqual(v.ok, false);
});

test("YES with NaN count is rejected", () => {
  const v = Core.validateAnswer({
    defectFound: "YES", defectTypes: ["BBOX_ERROR"], targetClasses: ["Lemon"], numberOfDefects: NaN,
  });
  assert.strictEqual(v.ok, false);
});

test("YES fully filled is accepted", () => {
  const v = Core.validateAnswer({
    defectFound: "YES",
    defectTypes: ["MISSING_LABEL", "BBOX_ERROR"],
    targetClasses: ["Lemon"],
    numberOfDefects: 2,
  });
  assert.strictEqual(v.ok, true);
});

console.log("\n[answer building]");

const task = { task_id: "HGA_0001" };

test("NO normalises to NONE / 0", () => {
  const a = Core.buildAnswer({ defectFound: "NO", notes: "" }, task, "reviewer1", 12);
  assert.strictEqual(a.defect_found, "NO");
  assert.strictEqual(a.defect_types, "NONE");
  assert.strictEqual(a.number_of_defects, 0);
  assert.strictEqual(a.target_classes_affected, "");
  assert.strictEqual(a.review_time_seconds, 12);
});

test("YES joins multiple values with semicolons", () => {
  const a = Core.buildAnswer({
    defectFound: "YES",
    defectTypes: ["MISSING_LABEL", "BBOX_ERROR"],
    targetClasses: ["Lemon", "Papaya"],
    numberOfDefects: 3,
    notes: "two onions unlabelled",
  }, task, "reviewer1", 45);
  assert.strictEqual(a.defect_types, "MISSING_LABEL;BBOX_ERROR");
  assert.strictEqual(a.target_classes_affected, "Lemon;Papaya");
  assert.strictEqual(a.number_of_defects, 3);
  assert.strictEqual(a.notes, "two onions unlabelled");
});

test("AMBIGUOUS leaves detail fields empty", () => {
  const a = Core.buildAnswer({ defectFound: "AMBIGUOUS", notes: "blurry" }, task, "reviewer2", 30);
  assert.strictEqual(a.defect_found, "AMBIGUOUS");
  assert.strictEqual(a.defect_types, "");
  assert.strictEqual(a.target_classes_affected, "");
  assert.strictEqual(a.number_of_defects, "");
  assert.strictEqual(a.notes, "blurry");
});

test("reviewer_id is carried through", () => {
  const a = Core.buildAnswer({ defectFound: "NO" }, task, "reviewer2", 5);
  assert.strictEqual(a.reviewer_id, "reviewer2");
  assert.strictEqual(a.task_id, "HGA_0001");
});

console.log("\n[csv]");

test("header matches the existing review.csv columns exactly", () => {
  const expected = "task_id,reviewer_id,defect_found,defect_types," +
    "target_classes_affected,number_of_defects,notes,review_time_seconds";
  assert.strictEqual(Core.buildCsv([]).split("\r\n")[0], expected);
});

test("notes containing a comma are quoted", () => {
  const csv = Core.buildCsv([Core.buildAnswer(
    { defectFound: "NO", notes: "onion, tomato" }, task, "reviewer1", 1)]);
  assert.match(csv, /"onion, tomato"/);
});

test("notes containing a quote are escaped by doubling", () => {
  const csv = Core.buildCsv([Core.buildAnswer(
    { defectFound: "NO", notes: 'he said "maybe"' }, task, "reviewer1", 1)]);
  assert.match(csv, /"he said ""maybe"""/);
});

test("notes containing a newline stay inside one quoted field", () => {
  const csv = Core.buildCsv([Core.buildAnswer(
    { defectFound: "NO", notes: "line one\nline two" }, task, "reviewer1", 1)]);
  assert.match(csv, /"line one\nline two"/);
});

test("row order follows the answers array", () => {
  const rows = ["HGA_0001", "HGA_0002", "HGA_0003"].map((id, i) =>
    Core.buildAnswer({ defectFound: "NO" }, { task_id: id }, "reviewer1", i));
  const lines = Core.buildCsv(rows).trim().split("\r\n");
  assert.deepStrictEqual(
    lines.slice(1).map((l) => l.split(",")[0]),
    ["HGA_0001", "HGA_0002", "HGA_0003"]
  );
});

test("csv round-trips through a strict RFC4180 parser", () => {
  const answers = [
    Core.buildAnswer({ defectFound: "NO", notes: 'a,b "c"\nd' }, { task_id: "HGA_0001" }, "reviewer1", 7),
    Core.buildAnswer({
      defectFound: "YES", defectTypes: ["OTHER"], targetClasses: ["Yam_Raw"],
      numberOfDefects: 1, notes: "",
    }, { task_id: "HGA_0002" }, "reviewer1", 9),
  ];
  const parsed = parseCsv(Core.buildCsv(answers));
  assert.strictEqual(parsed.length, 3); // header + 2
  assert.deepStrictEqual(parsed[0], Core.CSV_COLUMNS);
  assert.strictEqual(parsed[1][6], 'a,b "c"\nd');
  assert.strictEqual(parsed[1][7], "7");
  assert.strictEqual(parsed[2][3], "OTHER");
});

test("file name matches the requested pattern", () => {
  assert.strictEqual(Core.csvFileName("reviewer1"), "reviewer1_review_completed.csv");
  assert.strictEqual(Core.csvFileName("reviewer2"), "reviewer2_review_completed.csv");
});

console.log("\n[formatting]");

test("duration formats as mm:ss", () => {
  assert.strictEqual(Core.formatDuration(0), "00:00");
  assert.strictEqual(Core.formatDuration(18), "00:18");
  assert.strictEqual(Core.formatDuration(605), "10:05");
});

test("duration rolls over to h:mm:ss past an hour", () => {
  assert.strictEqual(Core.formatDuration(3665), "1:01:05");
});

test("total time reads as 'X min YY sec'", () => {
  assert.strictEqual(Core.formatTotalTime(725), "12 min 05 sec");
});

test("total seconds sums the answers", () => {
  assert.strictEqual(Core.totalReviewSeconds([
    { review_time_seconds: 10 }, { review_time_seconds: 25 },
  ]), 35);
});

test("storage keys differ per reviewer", () => {
  assert.notStrictEqual(Core.storageKey("reviewer1"), Core.storageKey("reviewer2"));
});

console.log("\n[adjudication validation]");

test("no decision is rejected", () => {
  assert.strictEqual(Core.validateAdjudication({ defectFound: null }).ok, false);
});

test("NO needs nothing else", () => {
  assert.strictEqual(Core.validateAdjudication({ defectFound: "NO" }).ok, true);
});

test("AMBIGUOUS without notes is rejected", () => {
  const v = Core.validateAdjudication({ defectFound: "AMBIGUOUS", notes: "" });
  assert.strictEqual(v.ok, false);
  assert.match(v.message, /requires a note/);
});

test("AMBIGUOUS with whitespace-only notes is rejected", () => {
  assert.strictEqual(
    Core.validateAdjudication({ defectFound: "AMBIGUOUS", notes: "   " }).ok, false);
});

test("AMBIGUOUS with notes is accepted", () => {
  assert.strictEqual(
    Core.validateAdjudication({ defectFound: "AMBIGUOUS", notes: "cannot resolve" }).ok,
    true);
});

test("YES needs type, class and count", () => {
  assert.strictEqual(Core.validateAdjudication({
    defectFound: "YES", defectTypes: [], targetClasses: ["Lemon"], numberOfDefects: 1,
  }).ok, false);
  assert.strictEqual(Core.validateAdjudication({
    defectFound: "YES", defectTypes: ["OTHER"], targetClasses: [], numberOfDefects: 1,
  }).ok, false);
  assert.strictEqual(Core.validateAdjudication({
    defectFound: "YES", defectTypes: ["OTHER"], targetClasses: ["Lemon"], numberOfDefects: 0,
  }).ok, false);
  assert.strictEqual(Core.validateAdjudication({
    defectFound: "YES", defectTypes: ["OTHER"], targetClasses: ["Lemon"], numberOfDefects: 1,
  }).ok, true);
});

console.log("\n[adjudication records]");

test("NO normalises to NONE / 0 with no classes", () => {
  const r = Core.buildAdjudication({ defectFound: "NO", notes: "" }, { queue_id: 3 });
  assert.strictEqual(r.queue_id, 3);
  assert.strictEqual(r.final_defect_types, "NONE");
  assert.strictEqual(r.final_number_of_defects, 0);
  assert.strictEqual(r.final_target_classes, "");
});

test("YES joins with semicolons", () => {
  const r = Core.buildAdjudication({
    defectFound: "YES", defectTypes: ["MISSING_LABEL", "BBOX_ERROR"],
    targetClasses: ["Lemon", "Papaya"], numberOfDefects: 4, notes: "n",
  }, { queue_id: 7 });
  assert.strictEqual(r.final_defect_types, "MISSING_LABEL;BBOX_ERROR");
  assert.strictEqual(r.final_target_classes, "Lemon;Papaya");
  assert.strictEqual(r.final_number_of_defects, 4);
});

test("AMBIGUOUS keeps the note and leaves details empty", () => {
  const r = Core.buildAdjudication(
    { defectFound: "AMBIGUOUS", notes: "unclear" }, { queue_id: 9 });
  assert.strictEqual(r.final_defect_found, "AMBIGUOUS");
  assert.strictEqual(r.final_defect_types, "");
  assert.strictEqual(r.final_adjudication_notes, "unclear");
});

console.log("\n[adjudication csv]");

test("header is exactly the requested columns", () => {
  assert.strictEqual(
    Core.buildAdjudicationCsv([], {}).split("\r\n")[0],
    "queue_id,final_defect_found,final_defect_types,final_target_classes," +
    "final_number_of_defects,final_adjudication_notes");
});

test("rows follow queue order, not answer order", () => {
  const entries = [{ queue_id: 1 }, { queue_id: 2 }, { queue_id: 3 }];
  const answers = {
    3: Core.buildAdjudication({ defectFound: "NO" }, { queue_id: 3 }),
    1: Core.buildAdjudication({ defectFound: "NO" }, { queue_id: 1 }),
    2: Core.buildAdjudication({ defectFound: "NO" }, { queue_id: 2 }),
  };
  const lines = Core.buildAdjudicationCsv(entries, answers).trim().split("\r\n");
  assert.deepStrictEqual(lines.slice(1).map((l) => l.split(",")[0]), ["1", "2", "3"]);
});

test("unanswered queue entries are skipped", () => {
  const entries = [{ queue_id: 1 }, { queue_id: 2 }];
  const answers = { 1: Core.buildAdjudication({ defectFound: "NO" }, { queue_id: 1 }) };
  assert.strictEqual(
    Core.buildAdjudicationCsv(entries, answers).trim().split("\r\n").length, 2);
});

test("adjudication notes survive commas, quotes and newlines", () => {
  const entries = [{ queue_id: 1 }];
  const answers = {
    1: Core.buildAdjudication(
      { defectFound: "AMBIGUOUS", notes: 'a,b "c"\nd' }, { queue_id: 1 }),
  };
  const parsed = parseCsv(Core.buildAdjudicationCsv(entries, answers));
  assert.strictEqual(parsed[1][5], 'a,b "c"\nd');
});

test("adjudication storage key is separate from the reviewer keys", () => {
  assert.notStrictEqual(Core.ADJUDICATION_STORAGE_KEY, Core.storageKey("reviewer1"));
  assert.notStrictEqual(Core.ADJUDICATION_STORAGE_KEY, Core.storageKey("reviewer3"));
  assert.ok(!Core.ADJUDICATION_STORAGE_KEY.startsWith(Core.STORAGE_PREFIX + ":"));
});

console.log("\n[stage 2]");

test("storage keys are separate from every Stage 1 key", () => {
  assert.strictEqual(Core.stage2StorageKey("reviewer1"), "claim2_stage2_reviewer1");
  assert.strictEqual(Core.stage2StorageKey("reviewer2"), "claim2_stage2_reviewer2");
  ["reviewer1", "reviewer2", "reviewer3"].forEach((r) => {
    assert.notStrictEqual(Core.stage2StorageKey(r), Core.storageKey(r));
  });
  assert.notStrictEqual(Core.stage2StorageKey("reviewer1"), Core.ADJUDICATION_STORAGE_KEY);
});

test("csv file names match the requested pattern", () => {
  assert.strictEqual(Core.stage2CsvFileName("reviewer1"),
    "claim2_stage2_reviewer1_completed.csv");
  assert.strictEqual(Core.stage2CsvFileName("reviewer2"),
    "claim2_stage2_reviewer2_completed.csv");
});

test("csv header is exactly the requested columns", () => {
  assert.strictEqual(Core.buildStage2Csv([]).split("\r\n")[0],
    "task_id,reviewer_id,class_name,condition,defect_found,defect_types," +
    "target_classes_affected,number_of_defects,notes,review_time_seconds");
});

test("answer carries class and condition", () => {
  const a = Core.buildStage2Answer({ defectFound: "NO" },
    { task_id: "S2_0001", class_name: "Lemon" }, "reviewer1", "GENERAL", 30);
  assert.strictEqual(a.class_name, "Lemon");
  assert.strictEqual(a.condition, "GENERAL");
  assert.strictEqual(a.defect_types, "NONE");
  assert.strictEqual(a.number_of_defects, 0);
  assert.strictEqual(a.review_time_seconds, 30);
});

test("YES joins multiple values with semicolons", () => {
  const a = Core.buildStage2Answer({
    defectFound: "YES", defectTypes: ["MISSING_LABEL", "BBOX_ERROR"],
    targetClasses: ["Tomato_Raw"], numberOfDefects: 5, notes: "n",
  }, { task_id: "S2_0002", class_name: "Tomato_Raw" }, "reviewer2", "GHOST_INFORMED", 61);
  assert.strictEqual(a.defect_types, "MISSING_LABEL;BBOX_ERROR");
  assert.strictEqual(a.target_classes_affected, "Tomato_Raw");
  assert.strictEqual(a.number_of_defects, 5);
  assert.strictEqual(a.condition, "GHOST_INFORMED");
});

test("validation: YES needs type, class and count", () => {
  assert.strictEqual(Core.validateStage2({
    defectFound: "YES", defectTypes: [], targetClasses: ["Lemon"], numberOfDefects: 1,
  }).ok, false);
  assert.strictEqual(Core.validateStage2({
    defectFound: "YES", defectTypes: ["OTHER"], targetClasses: ["Lemon"], numberOfDefects: 1,
  }).ok, true);
});

test("validation: AMBIGUOUS requires notes, NO does not", () => {
  assert.strictEqual(Core.validateStage2({ defectFound: "AMBIGUOUS", notes: "" }).ok, false);
  assert.strictEqual(Core.validateStage2({ defectFound: "AMBIGUOUS", notes: "x" }).ok, true);
  assert.strictEqual(Core.validateStage2({ defectFound: "NO" }).ok, true);
});

test("csv row order follows the answers array", () => {
  const rows = ["S2_0003", "S2_0001", "S2_0002"].map((id) =>
    Core.buildStage2Answer({ defectFound: "NO" }, { task_id: id, class_name: "Lemon" },
      "reviewer1", "GENERAL", 1));
  const lines = Core.buildStage2Csv(rows).trim().split("\r\n");
  assert.deepStrictEqual(lines.slice(1).map((l) => l.split(",")[0]),
    ["S2_0003", "S2_0001", "S2_0002"]);
});

test("csv escapes notes with commas, quotes and newlines", () => {
  const rows = [Core.buildStage2Answer({ defectFound: "AMBIGUOUS", notes: 'a,b "c"\nd' },
    { task_id: "S2_0001", class_name: "Lemon" }, "reviewer1", "GENERAL", 1)];
  const parsed = parseCsv(Core.buildStage2Csv(rows));
  assert.strictEqual(parsed[1][8], 'a,b "c"\nd');
});

test("csv contains no file name field", () => {
  assert.ok(!Core.STAGE2_CSV_COLUMNS.includes("file_name"));
});

// --- minimal RFC4180 parser used only by the round-trip test ---------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

console.log("\n" + "=".repeat(60));
if (failures.length > 0) {
  console.log(`RESULT: FAIL (${failures.length} of ${passed + failures.length})`);
  process.exit(1);
}
console.log(`RESULT: PASS (${passed} tests)`);
