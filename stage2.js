/**
 * Stage 2 — Annotation Review.
 *
 * Tests whether the class-level problems found in the Stage 1 Ghost Audit help
 * when reviewing different images. Both conditions see the same GT-only images,
 * the same form, the same timer and the same zoom; the only difference is that
 * GHOST_INFORMED tasks carry a class-specific focus note.
 *
 * Each reviewer takes exactly one condition per class, so nobody reviews the
 * same class both informed and uninformed. The reviewer never sees a condition
 * label -- the task payload does not contain one, so a reviewer cannot tell that
 * they are the control arm for a class.
 *
 * Reviewers are anonymous: reviewer_a / reviewer_b only.
 *
 * Entirely separate from Stage 1: own views, own timer, own localStorage keys.
 */
(function () {
  "use strict";

  var Core = window.ReviewCore;
  var App = window.ReviewApp;

  var TASK_COUNT = 90;

  var state = {
    reviewerId: null,
    tasks: [],
    answers: [],
    index: 0,
    draft: null,
    activeMs: 0,
    runningSince: null,
    paused: false,
    tickHandle: null,
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    [
      "btn-stage1", "btn-stage2", "btn-stage1-back", "btn-stage2-back",
      "view-stage2-hub", "view-s2-brief", "view-s2-review",
      "view-s2-complete",
      "s2-reviewer-name", "s2-count", "s2-progress", "s2-progress-text",
      "btn-s2-start", "btn-s2-home",
      "s2-counter", "s2-timer", "btn-s2-pause",
      "s2-focus", "s2-focus-text", "s2-image", "s2-form", "s2-yes-fields",
      "s2-defect-types", "s2-target-classes", "s2-defect-count", "s2-notes",
      "s2-notes-req", "s2-ambiguous-hint", "s2-validation", "btn-s2-next",
      "s2-pause-overlay", "s2-pause-title", "s2-pause-message", "btn-s2-resume",
      "s2-final-count", "s2-final-time",
      "btn-s2-download", "btn-s2-complete-home",
    ].forEach(function (id) { el[id] = $(id); });
  }

  // ---------------------------------------------------------------- storage
  function loadProgress(reviewerId) {
    try {
      var raw = window.localStorage.getItem(Core.stage2StorageKey(reviewerId));
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed.answers) ? parsed.answers : [];
    } catch (err) {
      console.warn("Could not read saved Stage 2 progress:", err);
      return [];
    }
  }

  function saveProgress() {
    try {
      window.localStorage.setItem(
        Core.stage2StorageKey(state.reviewerId),
        JSON.stringify({
          reviewer_id: state.reviewerId,
          answers: state.answers,
          updated_at: new Date().toISOString(),
        })
      );
      return true;
    } catch (err) {
      console.error("Could not save Stage 2 progress:", err);
      window.alert(
        "Your answer could not be saved in this browser. Please tell the " +
        "researcher before continuing."
      );
      return false;
    }
  }

  // ------------------------------------------------------------------ timer
  function currentSeconds() {
    var ms = state.activeMs;
    if (state.runningSince !== null) ms += Date.now() - state.runningSince;
    return Math.round(ms / 1000);
  }

  function renderTimer() {
    el["s2-timer"].textContent = "Time: " + Core.formatDuration(currentSeconds());
  }

  function startTimer() {
    if (state.runningSince === null) state.runningSince = Date.now();
    if (state.tickHandle === null) {
      state.tickHandle = window.setInterval(renderTimer, 1000);
    }
    renderTimer();
  }

  function stopTimer() {
    if (state.runningSince !== null) {
      state.activeMs += Date.now() - state.runningSince;
      state.runningSince = null;
    }
    if (state.tickHandle !== null) {
      window.clearInterval(state.tickHandle);
      state.tickHandle = null;
    }
    renderTimer();
  }

  /** Never resumes on its own — the reviewer must press Resume. */
  function pause(message) {
    if (state.paused || el["view-s2-review"].hidden) return;
    state.paused = true;
    stopTimer();
    el["s2-pause-message"].textContent = message;
    el["s2-pause-overlay"].hidden = false;
    el["btn-s2-resume"].focus();
  }

  function resume() {
    if (!state.paused) return;
    state.paused = false;
    el["s2-pause-overlay"].hidden = true;
    startTimer();
  }

  // ------------------------------------------------------------------- form
  function buildCheckboxes(container, items, prefix) {
    container.innerHTML = "";
    items.forEach(function (item) {
      var value = typeof item === "string" ? item : item.value;
      var label = typeof item === "string" ? item : item.label;
      var id = prefix + "-" + value;
      var wrapper = document.createElement("label");
      wrapper.className = "checkbox";
      wrapper.setAttribute("for", id);
      var input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.value = value;
      var span = document.createElement("span");
      span.textContent = label;
      wrapper.appendChild(input);
      wrapper.appendChild(span);
      container.appendChild(wrapper);
    });
  }

  function checkedValues(container) {
    return Array.prototype.slice
      .call(container.querySelectorAll("input[type=checkbox]"))
      .filter(function (i) { return i.checked; })
      .map(function (i) { return i.value; });
  }

  function resetForm() {
    state.draft = { defectFound: null };
    Array.prototype.slice
      .call(el["s2-form"].querySelectorAll("input[type=checkbox]"))
      .forEach(function (i) { i.checked = false; });
    el["s2-defect-count"].value = "1";
    el["s2-notes"].value = "";
    el["s2-yes-fields"].hidden = true;
    el["s2-ambiguous-hint"].hidden = true;
    el["s2-validation"].hidden = true;
    el["s2-notes-req"].textContent = "(optional)";
    el["s2-notes-req"].className = "optional";
    Array.prototype.slice
      .call(el["s2-form"].querySelectorAll(".choice-button"))
      .forEach(function (b) { b.classList.remove("selected"); });
  }

  function selectAnswer(value) {
    state.draft.defectFound = value;
    Array.prototype.slice
      .call(el["s2-form"].querySelectorAll(".choice-button"))
      .forEach(function (b) {
        b.classList.toggle("selected", b.dataset.s2Answer === value);
      });
    el["s2-yes-fields"].hidden = value !== "YES";
    el["s2-ambiguous-hint"].hidden = value !== "AMBIGUOUS";
    el["s2-notes-req"].textContent = value === "AMBIGUOUS" ? "(required)" : "(optional)";
    el["s2-notes-req"].className = value === "AMBIGUOUS" ? "req" : "optional";
    el["s2-validation"].hidden = true;
  }

  function readDraft() {
    return {
      defectFound: state.draft.defectFound,
      defectTypes: checkedValues(el["s2-defect-types"]),
      targetClasses: checkedValues(el["s2-target-classes"]),
      numberOfDefects: parseInt(el["s2-defect-count"].value, 10),
      notes: el["s2-notes"].value,
    };
  }

  // ------------------------------------------------------------------- flow
  function renderTask() {
    var task = state.tasks[state.index];
    el["s2-counter"].textContent =
      "Task " + (state.index + 1) + " / " + state.tasks.length;
    el["s2-image"].src =
      "data/stage2/" + state.reviewerId + "/" + task.image;
    el["s2-image"].alt =
      "Image under review, " + (state.index + 1) + " of " + state.tasks.length;

    // Only GHOST_INFORMED tasks carry focus information; the payload has no
    // condition label, so its presence is the only signal and it is intended.
    if (task.focus_information) {
      el["s2-focus"].hidden = false;
      el["s2-focus-text"].textContent = task.focus_information;
    } else {
      el["s2-focus"].hidden = true;
      el["s2-focus-text"].textContent = "";
    }

    resetForm();
    stopTimer();
    state.activeMs = 0;
    startTimer();
    window.scrollTo(0, 0);
  }

  function submit(event) {
    event.preventDefault();
    if (state.paused) return;

    var draft = readDraft();
    var verdict = Core.validateStage2(draft);
    if (!verdict.ok) {
      el["s2-validation"].textContent = verdict.message;
      el["s2-validation"].hidden = false;
      return;
    }

    stopTimer();
    var task = state.tasks[state.index];
    // The condition is not in the payload; it is recovered from whether the task
    // carries focus information, so the CSV keeps it for the analysis.
    var condition = task.focus_information ? "GHOST_INFORMED" : "GENERAL";
    var answer = Core.buildStage2Answer(
      draft, task, state.reviewerId, condition, currentSeconds()
    );
    state.answers.push(answer);
    if (!saveProgress()) {
      state.answers.pop();
      startTimer();
      return;
    }

    state.index += 1;
    if (state.index >= state.tasks.length) {
      showComplete();
    } else {
      renderTask();
    }
  }

  function showComplete() {
    stopTimer();
    el["s2-final-count"].textContent =
      state.answers.length + " / " + state.tasks.length;
    el["s2-final-time"].textContent =
      Core.formatTotalTime(Core.totalReviewSeconds(state.answers));
    App.showView("view-s2-complete");
  }

  function startReview() {
    return fetch("data/stage2/" + state.reviewerId + "/tasks.json",
                 { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (payload) {
        // Order comes from the package and is used exactly as-is.
        state.tasks = payload.tasks || [];
        state.index = Math.min(state.answers.length, state.tasks.length);
        if (state.index >= state.tasks.length) {
          showComplete();
          return;
        }
        App.showView("view-s2-review");
        renderTask();
      })
      .catch(function (err) {
        console.error(err);
        window.alert("Could not load the Stage 2 task list.");
      });
  }

  function openBrief(reviewerId) {
    state.reviewerId = reviewerId;
    state.answers = loadProgress(reviewerId);

    el["s2-reviewer-name"].textContent =
      "Reviewer " + reviewerId.replace(/^reviewer_/, "").toUpperCase();
    el["s2-count"].textContent = String(TASK_COUNT);

    var done = state.answers.length;
    if (done > 0) {
      el["s2-progress"].hidden = false;
      el["s2-progress-text"].textContent = done + " / " + TASK_COUNT + " completed";
      el["btn-s2-start"].textContent =
        done >= TASK_COUNT ? "View result" : "Resume Review";
    } else {
      el["s2-progress"].hidden = true;
      el["btn-s2-start"].textContent = "Start Review";
    }
    App.showView("view-s2-brief");
  }

  function downloadCsv() {
    var csv = Core.buildStage2Csv(state.answers);
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = Core.stage2CsvFileName(state.reviewerId);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    el["btn-s2-download"].textContent = "Download CSV again";
  }

  // ------------------------------------------------------------------- wire
  function bind() {
    el["btn-stage1"].addEventListener("click", function () {
      App.showView("view-landing");
    });
    el["btn-stage2"].addEventListener("click", function () {
      App.showView("view-stage2-hub");
    });
    el["btn-stage1-back"].addEventListener("click", function () {
      App.showView("view-stage-select");
    });
    el["btn-stage2-back"].addEventListener("click", function () {
      App.showView("view-stage-select");
    });

    Array.prototype.slice
      .call(document.querySelectorAll("[data-s2-reviewer]"))
      .forEach(function (b) {
        b.addEventListener("click", function () {
          openBrief(b.dataset.s2Reviewer);
        });
      });

    el["btn-s2-home"].addEventListener("click", function () {
      App.showView("view-stage2-hub");
    });
    el["btn-s2-start"].addEventListener("click", startReview);

    Array.prototype.slice
      .call(el["s2-form"].querySelectorAll(".choice-button"))
      .forEach(function (b) {
        b.addEventListener("click", function () {
          if (state.paused) return;
          selectAnswer(b.dataset.s2Answer);
        });
      });
    el["s2-form"].addEventListener("submit", submit);

    el["btn-s2-pause"].addEventListener("click", function () {
      pause("Timing is stopped. Press Resume when you are ready to continue.");
    });
    el["btn-s2-resume"].addEventListener("click", resume);

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        pause("Paused because the review tab was inactive. Press Resume to continue.");
      }
    });
    window.addEventListener("blur", function () {
      pause("Paused because the review window was inactive. Press Resume to continue.");
    });

    el["s2-image"].addEventListener("click", function () {
      App.openZoom(el["s2-image"].src);
    });

    el["btn-s2-download"].addEventListener("click", downloadCsv);
    el["btn-s2-complete-home"].addEventListener("click", function () {
      App.showView("view-stage-select");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    cacheElements();
    buildCheckboxes(el["s2-defect-types"], Core.DEFECT_TYPES, "s2-defect");
    buildCheckboxes(el["s2-target-classes"], Core.TARGET_CLASSES, "s2-class");
    resetForm();
    bind();
  });
})();
