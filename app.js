/**
 * Annotation review app.
 *
 * Static, single page, no backend. Task lists are read from
 * data/<reviewer>/tasks.json in the order the reviewer package fixed; the app
 * never reorders, reshuffles or reassigns anything. Answers are kept in
 * localStorage under a per-reviewer key and exported as CSV on completion.
 */
(function () {
  "use strict";

  var Core = window.ReviewCore;

  var REVIEWER_IDS = ["reviewer1", "reviewer2", "reviewer3"];

  // Reviewer 3 is an independent verification pass and is shown GT-only images.
  // Its instructions must not mention model output at all.
  var INSTRUCTION_BLOCK = {
    reviewer1: "instr-r12",
    reviewer2: "instr-r12",
    reviewer3: "instr-r3",
  };

  var state = {
    reviewerId: null,
    tasks: [],
    answers: [],
    index: 0,
    draft: null,
    // timing
    activeMs: 0, // accumulated active time for the current task
    runningSince: null, // timestamp of the current running segment, or null
    paused: false,
    tickHandle: null,
    previousView: null,
  };

  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      "view-landing", "view-brief", "view-review", "view-complete",
      "view-instructions", "brief-reviewer", "brief-count", "brief-progress",
      "brief-progress-text", "btn-start", "btn-back-landing", "btn-instructions",
      "btn-instructions-back", "btn-reset", "task-counter", "timer", "btn-pause",
      "review-image", "answer-form", "yes-fields", "defect-types",
      "target-classes", "defect-count", "notes", "validation-message",
      "ambiguous-hint", "btn-next", "pause-overlay", "pause-title",
      "pause-message", "btn-resume", "complete-count", "complete-time",
      "btn-download", "btn-complete-home", "zoom-overlay", "zoom-image",
      "btn-zoom-close", "instr-r12", "instr-r3", "instr-select-first",
    ].forEach(function (id) {
      el[id] = $(id);
    });
  }

  // -----------------------------------------------------------------------
  // Views
  // -----------------------------------------------------------------------
  var VIEWS = ["view-landing", "view-brief", "view-review", "view-complete", "view-instructions"];

  function showView(name) {
    VIEWS.forEach(function (view) {
      el[view].hidden = view !== name;
    });
    window.scrollTo(0, 0);
  }

  /** "reviewer1" -> "Reviewer 1" */
  function displayName(reviewerId) {
    return reviewerId.replace(/^reviewer/, "Reviewer ");
  }

  /**
   * Show only the instruction block for the selected reviewer. Before a reviewer
   * is chosen, show neither: Reviewer 3 must never see the Reviewer 1/2 section
   * describing model output.
   */
  function applyInstructionVariant() {
    var wanted = INSTRUCTION_BLOCK[state.reviewerId];
    el["instr-r12"].hidden = wanted !== "instr-r12";
    el["instr-r3"].hidden = wanted !== "instr-r3";
    el["instr-select-first"].hidden = Boolean(wanted);
  }

  // -----------------------------------------------------------------------
  // Storage
  // -----------------------------------------------------------------------
  function loadProgress(reviewerId) {
    try {
      var raw = window.localStorage.getItem(Core.storageKey(reviewerId));
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed.answers) ? parsed.answers : [];
    } catch (err) {
      console.warn("Could not read saved progress:", err);
      return [];
    }
  }

  function saveProgress() {
    try {
      window.localStorage.setItem(
        Core.storageKey(state.reviewerId),
        JSON.stringify({
          reviewer_id: state.reviewerId,
          answers: state.answers,
          updated_at: new Date().toISOString(),
        })
      );
      return true;
    } catch (err) {
      console.error("Could not save progress:", err);
      window.alert(
        "Your answer could not be saved in this browser. Please tell the " +
        "researcher before continuing."
      );
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Timer
  // -----------------------------------------------------------------------
  function currentSeconds() {
    var ms = state.activeMs;
    if (state.runningSince !== null) {
      ms += Date.now() - state.runningSince;
    }
    return Math.round(ms / 1000);
  }

  function renderTimer() {
    el.timer.textContent = "Time: " + Core.formatDuration(currentSeconds());
  }

  function startTimer() {
    if (state.runningSince === null) {
      state.runningSince = Date.now();
    }
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

  function resetTimer() {
    stopTimer();
    state.activeMs = 0;
  }

  /** Pause never resumes on its own — the reviewer must press Resume. */
  function pause(title, message) {
    if (state.paused || el["view-review"].hidden) return;
    state.paused = true;
    stopTimer();
    el["pause-title"].textContent = title;
    el["pause-message"].textContent = message;
    el["pause-overlay"].hidden = false;
    el["btn-resume"].focus();
  }

  function resume() {
    if (!state.paused) return;
    state.paused = false;
    el["pause-overlay"].hidden = true;
    startTimer();
  }

  // -----------------------------------------------------------------------
  // Answer form
  // -----------------------------------------------------------------------
  function buildCheckboxes(container, items, namePrefix) {
    container.innerHTML = "";
    items.forEach(function (item) {
      var value = typeof item === "string" ? item : item.value;
      var label = typeof item === "string" ? item : item.label;
      var id = namePrefix + "-" + value;

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
      .filter(function (input) { return input.checked; })
      .map(function (input) { return input.value; });
  }

  function resetForm() {
    state.draft = { defectFound: null, defectTypes: [], targetClasses: [], numberOfDefects: 1, notes: "" };
    Array.prototype.slice
      .call(el["answer-form"].querySelectorAll("input[type=checkbox]"))
      .forEach(function (input) { input.checked = false; });
    el["defect-count"].value = "1";
    el["notes"].value = "";
    el["yes-fields"].hidden = true;
    el["ambiguous-hint"].hidden = true;
    el["validation-message"].hidden = true;
    Array.prototype.slice
      .call(el["answer-form"].querySelectorAll(".choice-button"))
      .forEach(function (button) { button.classList.remove("selected"); });
  }

  function selectAnswer(value) {
    state.draft.defectFound = value;
    Array.prototype.slice
      .call(el["answer-form"].querySelectorAll(".choice-button"))
      .forEach(function (button) {
        button.classList.toggle("selected", button.dataset.answer === value);
      });
    el["yes-fields"].hidden = value !== "YES";
    el["ambiguous-hint"].hidden = value !== "AMBIGUOUS";
    el["validation-message"].hidden = true;
  }

  function readDraft() {
    return {
      defectFound: state.draft.defectFound,
      defectTypes: checkedValues(el["defect-types"]),
      targetClasses: checkedValues(el["target-classes"]),
      numberOfDefects: parseInt(el["defect-count"].value, 10),
      notes: el["notes"].value,
    };
  }

  // -----------------------------------------------------------------------
  // Task flow
  // -----------------------------------------------------------------------
  function renderTask() {
    var task = state.tasks[state.index];
    el["task-counter"].textContent = "Task " + (state.index + 1) + " / " + state.tasks.length;
    el["review-image"].src = "data/" + state.reviewerId + "/" + task.image;
    el["review-image"].alt = "Review image " + (state.index + 1) + " of " + state.tasks.length;
    resetForm();
    resetTimer();
    startTimer();
  }

  function submitAnswer(event) {
    event.preventDefault();
    if (state.paused) return;

    var draft = readDraft();
    var verdict = Core.validateAnswer(draft);
    if (!verdict.ok) {
      el["validation-message"].textContent = verdict.message;
      el["validation-message"].hidden = false;
      return;
    }

    stopTimer();
    var answer = Core.buildAnswer(draft, state.tasks[state.index], state.reviewerId, currentSeconds());
    state.answers.push(answer);

    if (!saveProgress()) {
      // Saving failed: keep the reviewer on this task rather than losing it.
      state.answers.pop();
      startTimer();
      return;
    }

    state.index += 1;
    if (state.index >= state.tasks.length) {
      showCompletion();
    } else {
      renderTask();
    }
  }

  function showCompletion() {
    stopTimer();
    el["complete-count"].textContent = state.answers.length + " / " + state.tasks.length;
    el["complete-time"].textContent = Core.formatTotalTime(Core.totalReviewSeconds(state.answers));
    showView("view-complete");
  }

  // -----------------------------------------------------------------------
  // Reviewer selection
  // -----------------------------------------------------------------------
  function loadReviewer(reviewerId) {
    return fetch("data/" + reviewerId + "/tasks.json", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (payload) {
        // Order comes from the file and is used exactly as-is.
        state.reviewerId = reviewerId;
        state.tasks = payload.tasks || [];
        state.answers = loadProgress(reviewerId);
        if (state.answers.length > state.tasks.length) {
          state.answers = state.answers.slice(0, state.tasks.length);
        }
        state.index = state.answers.length;

        el["brief-reviewer"].textContent = displayName(reviewerId);
        el["brief-count"].textContent = String(state.tasks.length);

        var done = state.answers.length;
        if (done > 0) {
          el["brief-progress"].hidden = false;
          el["brief-progress-text"].textContent = done + " / " + state.tasks.length + " completed";
          el["btn-start"].textContent = done >= state.tasks.length ? "View Result" : "Resume Review";
        } else {
          el["brief-progress"].hidden = true;
          el["btn-start"].textContent = "Start Review";
        }
        showView("view-brief");
      })
      .catch(function (err) {
        console.error(err);
        window.alert(
          "Could not load the task list for " + reviewerId + ".\n\n" +
          "If you opened this page directly from a file, please serve the " +
          "folder over HTTP instead (see README)."
        );
      });
  }

  function startReview() {
    if (state.index >= state.tasks.length) {
      showCompletion();
      return;
    }
    showView("view-review");
    renderTask();
  }

  function resetProgress() {
    var confirmed = window.confirm(
      "This will permanently delete your saved review progress.\n\n" +
      "Answers already downloaded as CSV are not affected. Continue?"
    );
    if (!confirmed) return;
    var second = window.confirm("Are you sure? This cannot be undone.");
    if (!second) return;

    REVIEWER_IDS.forEach(function (reviewerId) {
      window.localStorage.removeItem(Core.storageKey(reviewerId));
    });
    window.alert("Saved progress has been deleted.");
    window.location.reload();
  }

  function downloadCsv() {
    var csv = Core.buildCsv(state.answers);
    // BOM keeps Excel from mangling UTF-8 on open.
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = Core.csvFileName(state.reviewerId);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    el["btn-download"].textContent = "Download CSV again";
  }

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------
  function bindEvents() {
    Array.prototype.slice
      .call(document.querySelectorAll("[data-reviewer]"))
      .forEach(function (button) {
        button.addEventListener("click", function () {
          loadReviewer(button.dataset.reviewer);
        });
      });

    el["btn-start"].addEventListener("click", startReview);
    el["btn-back-landing"].addEventListener("click", function () {
      state.reviewerId = null;
      showView("view-landing");
    });
    el["btn-reset"].addEventListener("click", resetProgress);

    Array.prototype.slice
      .call(el["answer-form"].querySelectorAll(".choice-button"))
      .forEach(function (button) {
        button.addEventListener("click", function () {
          if (state.paused) return;
          selectAnswer(button.dataset.answer);
        });
      });

    el["answer-form"].addEventListener("submit", submitAnswer);
    el["btn-pause"].addEventListener("click", function () {
      pause("Review paused", "Timing is stopped. Press Resume when you are ready to continue.");
    });
    el["btn-resume"].addEventListener("click", resume);

    // Leaving the tab or backgrounding the window stops the clock; it only
    // restarts when the reviewer presses Resume.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        pause(
          "Review paused",
          "Paused because the review tab was inactive. Press Resume to continue."
        );
      }
    });
    window.addEventListener("blur", function () {
      pause(
        "Review paused",
        "Paused because the review window was inactive. Press Resume to continue."
      );
    });

    // Instructions can be opened from anywhere; opening them pauses the clock.
    el["btn-instructions"].addEventListener("click", function () {
      var current = VIEWS.filter(function (v) { return !el[v].hidden; })[0];
      if (current === "view-instructions") return;
      if (current === "view-review") {
        pause("Review paused", "Timing is stopped while you read the instructions.");
      }
      state.previousView = current;
      applyInstructionVariant();
      showView("view-instructions");
    });
    el["btn-instructions-back"].addEventListener("click", function () {
      showView(state.previousView || "view-landing");
    });
    Array.prototype.slice
      .call(document.querySelectorAll("[data-goto-instructions]"))
      .forEach(function (button) {
        button.addEventListener("click", function () {
          state.previousView = "view-brief";
          applyInstructionVariant();
          showView("view-instructions");
        });
      });

    el["btn-download"].addEventListener("click", downloadCsv);
    el["btn-complete-home"].addEventListener("click", function () {
      showView("view-landing");
    });

    // Full-size image viewer.
    el["review-image"].addEventListener("click", function () {
      el["zoom-image"].src = el["review-image"].src;
      el["zoom-overlay"].hidden = false;
    });
    el["btn-zoom-close"].addEventListener("click", function () {
      el["zoom-overlay"].hidden = true;
    });
    el["zoom-overlay"].addEventListener("click", function (event) {
      if (event.target === el["zoom-overlay"]) el["zoom-overlay"].hidden = true;
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !el["zoom-overlay"].hidden) {
        el["zoom-overlay"].hidden = true;
      }
    });

    // Guard against closing the tab mid-task; the answer in progress is not
    // saved until Next is pressed.
    window.addEventListener("beforeunload", function (event) {
      if (!el["view-review"].hidden) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }

  function init() {
    cacheElements();
    buildCheckboxes(el["defect-types"], Core.DEFECT_TYPES, "defect");
    buildCheckboxes(el["target-classes"], Core.TARGET_CLASSES, "class");
    resetForm();
    applyInstructionVariant();
    bindEvents();
    showView("view-landing");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
