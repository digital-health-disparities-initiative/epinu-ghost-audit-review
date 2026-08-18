/**
 * Pure logic for the annotation review app: answer validation, CSV building,
 * time formatting and storage keys.
 *
 * Kept free of DOM access so it can be unit-tested outside a browser. Loaded as
 * a plain script in the page (attaches to window.ReviewCore) and as a CommonJS
 * module by the test harness.
 */
(function (root) {
  "use strict";

  var STORAGE_PREFIX = "epinu-hga-review-v1";

  var TARGET_CLASSES = [
    "RedOnion_Raw",
    "Yam_Raw",
    "Tomato_Raw",
    "Papaya",
    "Potato_Raw",
    "Lemon",
  ];

  // value -> label shown in the UI. The value is what lands in the CSV.
  var DEFECT_TYPES = [
    { value: "MISSING_LABEL", label: "Missing label" },
    { value: "WRONG_CLASS", label: "Wrong class" },
    { value: "BBOX_ERROR", label: "BBox error" },
    { value: "GRANULARITY_MISMATCH", label: "Granularity mismatch" },
    { value: "SPURIOUS_LABEL", label: "Spurious label" },
    { value: "OTHER", label: "Other" },
  ];

  var CSV_COLUMNS = [
    "task_id",
    "reviewer_id",
    "defect_found",
    "defect_types",
    "target_classes_affected",
    "number_of_defects",
    "notes",
    "review_time_seconds",
  ];

  var LIST_SEPARATOR = ";";

  function storageKey(reviewerId) {
    return STORAGE_PREFIX + ":" + reviewerId;
  }

  /**
   * Gate on the Next button. YES needs at least one defect type, at least one
   * affected target class, and a defect count of 1 or more. NO and AMBIGUOUS
   * need nothing extra.
   */
  function validateAnswer(draft) {
    if (!draft || !draft.defectFound) {
      return { ok: false, message: "Please choose NO, YES or AMBIGUOUS." };
    }
    if (draft.defectFound !== "YES") {
      return { ok: true, message: "" };
    }
    var problems = [];
    if (!draft.defectTypes || draft.defectTypes.length === 0) {
      problems.push("select at least one defect type");
    }
    if (!draft.targetClasses || draft.targetClasses.length === 0) {
      problems.push("select at least one affected target class");
    }
    var count = Number(draft.numberOfDefects);
    if (!Number.isInteger(count) || count < 1) {
      problems.push("enter a number of defects of 1 or more");
    }
    if (problems.length > 0) {
      return { ok: false, message: "Please " + problems.join(", ") + "." };
    }
    return { ok: true, message: "" };
  }

  /**
   * Turn the in-form draft into the record that gets stored and exported.
   * NO is normalised to the NONE / 0 convention used by the existing review.csv.
   */
  function buildAnswer(draft, task, reviewerId, reviewTimeSeconds) {
    var answer = {
      task_id: task.task_id,
      reviewer_id: reviewerId,
      defect_found: draft.defectFound,
      defect_types: "",
      target_classes_affected: "",
      number_of_defects: "",
      notes: draft.notes ? String(draft.notes) : "",
      review_time_seconds: reviewTimeSeconds,
    };

    if (draft.defectFound === "NO") {
      answer.defect_types = "NONE";
      answer.number_of_defects = 0;
    } else if (draft.defectFound === "YES") {
      answer.defect_types = (draft.defectTypes || []).join(LIST_SEPARATOR);
      answer.target_classes_affected = (draft.targetClasses || []).join(LIST_SEPARATOR);
      answer.number_of_defects = Number(draft.numberOfDefects);
    }
    // AMBIGUOUS leaves the detail fields empty; the judgement lives in
    // defect_found and any explanation in notes.
    return answer;
  }

  /** RFC 4180 quoting: needed for comma, quote, CR and LF inside notes. */
  function csvEscape(value) {
    var text = value === null || value === undefined ? "" : String(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function buildCsv(answers) {
    var lines = [CSV_COLUMNS.join(",")];
    (answers || []).forEach(function (answer) {
      lines.push(
        CSV_COLUMNS.map(function (column) {
          return csvEscape(answer[column]);
        }).join(",")
      );
    });
    return lines.join("\r\n") + "\r\n";
  }

  function csvFileName(reviewerId) {
    return reviewerId + "_review_completed.csv";
  }

  /** mm:ss, growing to hh:mm:ss only if a task somehow runs past an hour. */
  function formatDuration(totalSeconds) {
    var seconds = Math.max(0, Math.floor(totalSeconds || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var pad = function (n) {
      return n < 10 ? "0" + n : String(n);
    };
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  /** "12 min 05 sec" for the completion screen. */
  function formatTotalTime(totalSeconds) {
    var seconds = Math.max(0, Math.floor(totalSeconds || 0));
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + " min " + (s < 10 ? "0" + s : s) + " sec";
  }

  function totalReviewSeconds(answers) {
    return (answers || []).reduce(function (sum, answer) {
      return sum + (Number(answer.review_time_seconds) || 0);
    }, 0);
  }

  // -------------------------------------------------------------------------
  // Final Adjudication
  // -------------------------------------------------------------------------
  var ADJUDICATION_STORAGE_KEY = "epinu-hga-adjudication-v1";

  var ADJUDICATION_CSV_COLUMNS = [
    "queue_id",
    "final_defect_found",
    "final_defect_types",
    "final_target_classes",
    "final_number_of_defects",
    "final_adjudication_notes",
  ];

  /**
   * YES needs a type, a class and a count of 1+. AMBIGUOUS requires notes --
   * the aim is to land on YES or NO, so an unresolved case has to be explained.
   */
  function validateAdjudication(draft) {
    if (!draft || !draft.defectFound) {
      return { ok: false, message: "Please choose NO, YES or AMBIGUOUS." };
    }
    if (draft.defectFound === "AMBIGUOUS") {
      if (!draft.notes || !String(draft.notes).trim()) {
        return {
          ok: false,
          message: "AMBIGUOUS requires a note explaining what could not be resolved.",
        };
      }
      return { ok: true, message: "" };
    }
    if (draft.defectFound === "NO") {
      return { ok: true, message: "" };
    }
    var problems = [];
    if (!draft.defectTypes || draft.defectTypes.length === 0) {
      problems.push("select at least one defect type");
    }
    if (!draft.targetClasses || draft.targetClasses.length === 0) {
      problems.push("select at least one affected target class");
    }
    var count = Number(draft.numberOfDefects);
    if (!Number.isInteger(count) || count < 1) {
      problems.push("enter a number of defects of 1 or more");
    }
    if (problems.length > 0) {
      return { ok: false, message: "Please " + problems.join(", ") + "." };
    }
    return { ok: true, message: "" };
  }

  function buildAdjudication(draft, entry) {
    var record = {
      queue_id: entry.queue_id,
      final_defect_found: draft.defectFound,
      final_defect_types: "",
      final_target_classes: "",
      final_number_of_defects: "",
      final_adjudication_notes: draft.notes ? String(draft.notes) : "",
    };
    if (draft.defectFound === "NO") {
      record.final_defect_types = "NONE";
      record.final_number_of_defects = 0;
    } else if (draft.defectFound === "YES") {
      record.final_defect_types = (draft.defectTypes || []).join(LIST_SEPARATOR);
      record.final_target_classes = (draft.targetClasses || []).join(LIST_SEPARATOR);
      record.final_number_of_defects = Number(draft.numberOfDefects);
    }
    return record;
  }

  /** Rows follow the queue order so the CSV lines up with the workbook. */
  function buildAdjudicationCsv(entries, answersByQueueId) {
    var lines = [ADJUDICATION_CSV_COLUMNS.join(",")];
    (entries || []).forEach(function (entry) {
      var answer = (answersByQueueId || {})[entry.queue_id];
      if (!answer) return;
      lines.push(
        ADJUDICATION_CSV_COLUMNS.map(function (column) {
          return csvEscape(answer[column]);
        }).join(",")
      );
    });
    return lines.join("\r\n") + "\r\n";
  }

  var api = {
    STORAGE_PREFIX: STORAGE_PREFIX,
    TARGET_CLASSES: TARGET_CLASSES,
    DEFECT_TYPES: DEFECT_TYPES,
    CSV_COLUMNS: CSV_COLUMNS,
    LIST_SEPARATOR: LIST_SEPARATOR,
    storageKey: storageKey,
    validateAnswer: validateAnswer,
    buildAnswer: buildAnswer,
    csvEscape: csvEscape,
    buildCsv: buildCsv,
    csvFileName: csvFileName,
    formatDuration: formatDuration,
    formatTotalTime: formatTotalTime,
    totalReviewSeconds: totalReviewSeconds,
    ADJUDICATION_STORAGE_KEY: ADJUDICATION_STORAGE_KEY,
    ADJUDICATION_CSV_COLUMNS: ADJUDICATION_CSV_COLUMNS,
    validateAdjudication: validateAdjudication,
    buildAdjudication: buildAdjudication,
    buildAdjudicationCsv: buildAdjudicationCsv,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.ReviewCore = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
