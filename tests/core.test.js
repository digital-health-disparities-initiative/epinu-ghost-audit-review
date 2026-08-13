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
