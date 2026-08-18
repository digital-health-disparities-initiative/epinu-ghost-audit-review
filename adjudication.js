/**
 * Final Adjudication.
 *
 * Not a blind review: this is the last pass over the images where the earlier
 * reviews disagreed, deciding what the annotation should actually say. The
 * earlier decisions and (where one exists) the model-assisted view are shown on
 * purpose, and answers can be revisited with Previous / Next.
 *
 * Separate localStorage key from the reviewer flows, so nothing can collide.
 */
(function () {
  "use strict";

  var Core = window.ReviewCore;
  var App = window.ReviewApp;

  var state = {
    entries: [],
    answers: {}, // queue_id -> record
    index: 0,
    draft: null,
    showingModel: false,
    loaded: false,
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  function cacheElements() {
    [
      "btn-adjudication", "view-adj-brief", "view-adj", "view-adj-complete",
      "adj-count", "adj-progress", "adj-progress-text", "btn-adj-start",
      "btn-adj-home", "adj-counter", "adj-answered", "btn-adj-toggle-view",
      "adj-image", "adj-issue", "adj-issue-explanation", "adj-previous",
      "adj-form", "adj-yes-fields", "adj-defect-types", "adj-target-classes",
      "adj-defect-count", "adj-notes", "adj-notes-req", "adj-ambiguous-hint",
      "adj-validation", "btn-adj-prev", "btn-adj-next", "btn-adj-finish",
      "adj-complete-count", "adj-incomplete-warning", "btn-adj-download",
      "btn-adj-back-review", "btn-adj-complete-home",
    ].forEach(function (id) { el[id] = $(id); });
  }

  // ---------------------------------------------------------------- storage
  function loadProgress() {
    try {
      var raw = window.localStorage.getItem(Core.ADJUDICATION_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed.answers === "object" ? parsed.answers : {};
    } catch (err) {
      console.warn("Could not read saved adjudication progress:", err);
      return {};
    }
  }

  function saveProgress() {
    try {
      window.localStorage.setItem(
        Core.ADJUDICATION_STORAGE_KEY,
        JSON.stringify({ answers: state.answers, updated_at: new Date().toISOString() })
      );
      return true;
    } catch (err) {
      console.error("Could not save adjudication progress:", err);
      window.alert(
        "Your decision could not be saved in this browser. Please check before " +
        "continuing."
      );
      return false;
    }
  }

  function answeredCount() {
    return Object.keys(state.answers).length;
  }

  // ------------------------------------------------------------------ form
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

  function setSelection(container, values) {
    var wanted = values ? String(values).split(";") : [];
    Array.prototype.slice
      .call(container.querySelectorAll("input[type=checkbox]"))
      .forEach(function (input) {
        input.checked = wanted.indexOf(input.value) !== -1;
      });
  }

  function selectDecision(value) {
    state.draft.defectFound = value;
    Array.prototype.slice
      .call(el["adj-form"].querySelectorAll(".choice-button"))
      .forEach(function (b) {
        b.classList.toggle("selected", b.dataset.adjAnswer === value);
      });
    el["adj-yes-fields"].hidden = value !== "YES";
    el["adj-ambiguous-hint"].hidden = value !== "AMBIGUOUS";
    el["adj-notes-req"].textContent = value === "AMBIGUOUS" ? "(required)" : "(optional)";
    el["adj-notes-req"].className = value === "AMBIGUOUS" ? "req" : "optional";
    el["adj-validation"].hidden = true;
  }

  function readDraft() {
    return {
      defectFound: state.draft.defectFound,
      defectTypes: checkedValues(el["adj-defect-types"]),
      targetClasses: checkedValues(el["adj-target-classes"]),
      numberOfDefects: parseInt(el["adj-defect-count"].value, 10),
      notes: el["adj-notes"].value,
    };
  }

  /** Restore a previously saved decision so it can be reviewed and changed. */
  function loadAnswerIntoForm(entry) {
    state.draft = { defectFound: null };
    el["adj-validation"].hidden = true;
    var saved = state.answers[entry.queue_id];

    setSelection(el["adj-defect-types"], saved ? saved.final_defect_types : "");
    setSelection(el["adj-target-classes"], saved ? saved.final_target_classes : "");
    el["adj-defect-count"].value =
      saved && saved.final_number_of_defects ? saved.final_number_of_defects : "1";
    el["adj-notes"].value = saved ? saved.final_adjudication_notes : "";

    if (saved) {
      selectDecision(saved.final_defect_found);
    } else {
      Array.prototype.slice
        .call(el["adj-form"].querySelectorAll(".choice-button"))
        .forEach(function (b) { b.classList.remove("selected"); });
      el["adj-yes-fields"].hidden = true;
      el["adj-ambiguous-hint"].hidden = true;
      el["adj-notes-req"].textContent = "(optional)";
      el["adj-notes-req"].className = "optional";
    }
  }

  // ------------------------------------------------------- previous reviews
  function reviewCard(title, review) {
    var card = document.createElement("div");
    card.className = "prev-review";

    var heading = document.createElement("h4");
    heading.textContent = title;
    card.appendChild(heading);

    var rows = [
      ["Decision", review.decision || "—"],
      ["Defect type", review.defect_types || "—"],
      ["Class", review.target_classes || "—"],
      ["Number of defects", review.number_of_defects || "—"],
      ["Notes", review.notes || "—"],
    ];
    var list = document.createElement("dl");
    list.className = "prev-review-fields";
    rows.forEach(function (pair) {
      var dt = document.createElement("dt");
      dt.textContent = pair[0];
      var dd = document.createElement("dd");
      dd.textContent = pair[1];
      if (pair[0] === "Decision") {
        dd.className = "decision decision-" + String(review.decision || "").toLowerCase();
      }
      list.appendChild(dt);
      list.appendChild(dd);
    });
    card.appendChild(list);
    return card;
  }

  function renderPreviousReviews(entry) {
    var host = el["adj-previous"];
    host.innerHTML = "";
    var many = entry.primary_reviews.length > 1;
    entry.primary_reviews.forEach(function (review, i) {
      // Two primary reviews mean the image was reviewed under both conditions.
      // They are labelled A / B only -- never by condition or reviewer.
      var title = many
        ? "Primary Review " + String.fromCharCode(65 + i)
        : "Primary Review";
      host.appendChild(reviewCard(title, review));
    });
    host.appendChild(reviewCard("Reviewer 3", entry.reviewer3));
  }

  // ----------------------------------------------------------------- render
  function setImage(entry) {
    var path = state.showingModel && entry.model_image
      ? entry.model_image
      : entry.gt_image;
    el["adj-image"].src = "data/final_adjudication/" + path;
    el["adj-image"].alt = state.showingModel
      ? "Image with model-assisted view, " + (state.index + 1) + " of " + state.entries.length
      : "Image with current annotation, " + (state.index + 1) + " of " + state.entries.length;

    if (entry.model_image) {
      el["btn-adj-toggle-view"].hidden = false;
      el["btn-adj-toggle-view"].textContent = state.showingModel
        ? "Show GT-only view"
        : "Show model-assisted view";
    } else {
      // No visualisation exists for this image, so offer no toggle at all.
      el["btn-adj-toggle-view"].hidden = true;
    }
  }

  function renderEntry() {
    var entry = state.entries[state.index];
    state.showingModel = false;

    el["adj-counter"].textContent =
      "Image " + (state.index + 1) + " / " + state.entries.length;
    el["adj-answered"].textContent =
      answeredCount() + " / " + state.entries.length + " answered";
    el["adj-issue"].textContent = entry.issue || "—";
    el["adj-issue-explanation"].textContent = entry.issue_explanation || "";

    setImage(entry);
    renderPreviousReviews(entry);
    loadAnswerIntoForm(entry);

    el["btn-adj-prev"].disabled = state.index === 0;
    el["btn-adj-next"].textContent =
      state.index === state.entries.length - 1 ? "Save & finish" : "Next →";
    window.scrollTo(0, 0);
  }

  function showComplete() {
    var done = answeredCount();
    el["adj-complete-count"].textContent = done + " / " + state.entries.length;
    var missing = state.entries
      .filter(function (e) { return !state.answers[e.queue_id]; })
      .map(function (e) { return e.queue_id; });
    if (missing.length) {
      el["adj-incomplete-warning"].hidden = false;
      el["adj-incomplete-warning"].textContent =
        missing.length + " image(s) still have no final decision (queue_id " +
        missing.join(", ") + "). The CSV will only contain the ones you answered.";
    } else {
      el["adj-incomplete-warning"].hidden = true;
    }
    App.showView("view-adj-complete");
  }

  /** Save the current form if it is filled in. Returns false only on a real error. */
  function commitCurrent(requireAnswer) {
    var entry = state.entries[state.index];
    var draft = readDraft();

    if (!draft.defectFound) {
      if (!requireAnswer) return true; // moving away without answering is allowed
      el["adj-validation"].textContent = "Please choose NO, YES or AMBIGUOUS.";
      el["adj-validation"].hidden = false;
      return false;
    }

    var verdict = Core.validateAdjudication(draft);
    if (!verdict.ok) {
      el["adj-validation"].textContent = verdict.message;
      el["adj-validation"].hidden = false;
      return false;
    }

    state.answers[entry.queue_id] = Core.buildAdjudication(draft, entry);
    return saveProgress();
  }

  function goTo(index) {
    state.index = Math.max(0, Math.min(index, state.entries.length - 1));
    renderEntry();
  }

  // ------------------------------------------------------------------- load
  function load() {
    if (state.loaded) return Promise.resolve();
    return fetch("data/final_adjudication/queue.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (payload) {
        // Queue order comes from the workbook and is used exactly as-is.
        state.entries = payload.entries || [];
        state.answers = loadProgress();
        state.loaded = true;
      });
  }

  function openBrief() {
    load().then(function () {
      el["adj-count"].textContent = String(state.entries.length);
      var done = answeredCount();
      if (done > 0) {
        el["adj-progress"].hidden = false;
        el["adj-progress-text"].textContent =
          done + " / " + state.entries.length + " completed";
        el["btn-adj-start"].textContent =
          done >= state.entries.length ? "Review & export" : "Resume";
      } else {
        el["adj-progress"].hidden = true;
        el["btn-adj-start"].textContent = "Start";
      }
      App.showView("view-adj-brief");
    }).catch(function (err) {
      console.error(err);
      window.alert(
        "Could not load the adjudication queue.\n\n" +
        "If you opened this page from a file, serve the folder over HTTP instead."
      );
    });
  }

  function downloadCsv() {
    var csv = Core.buildAdjudicationCsv(state.entries, state.answers);
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "claim2_final_adjudication_completed.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    el["btn-adj-download"].textContent = "Download CSV again";
  }

  // ------------------------------------------------------------------- wire
  function bind() {
    el["btn-adjudication"].addEventListener("click", openBrief);
    el["btn-adj-home"].addEventListener("click", function () {
      App.showView("view-landing");
    });
    el["btn-adj-start"].addEventListener("click", function () {
      // Resume at the first unanswered image.
      var next = state.entries.findIndex(function (e) {
        return !state.answers[e.queue_id];
      });
      state.index = next === -1 ? 0 : next;
      App.showView("view-adj");
      renderEntry();
    });

    Array.prototype.slice
      .call(el["adj-form"].querySelectorAll(".choice-button"))
      .forEach(function (b) {
        b.addEventListener("click", function () { selectDecision(b.dataset.adjAnswer); });
      });

    el["adj-form"].addEventListener("submit", function (event) {
      event.preventDefault();
      if (!commitCurrent(true)) return;
      if (state.index === state.entries.length - 1) {
        showComplete();
      } else {
        goTo(state.index + 1);
      }
    });

    el["btn-adj-prev"].addEventListener("click", function () {
      if (!commitCurrent(false)) return;
      goTo(state.index - 1);
    });
    el["btn-adj-finish"].addEventListener("click", function () {
      if (!commitCurrent(false)) return;
      showComplete();
    });

    el["btn-adj-toggle-view"].addEventListener("click", function () {
      var entry = state.entries[state.index];
      if (!entry.model_image) return;
      state.showingModel = !state.showingModel;
      setImage(entry);
    });

    el["btn-adj-download"].addEventListener("click", downloadCsv);
    el["btn-adj-back-review"].addEventListener("click", function () {
      App.showView("view-adj");
      renderEntry();
    });
    el["btn-adj-complete-home"].addEventListener("click", function () {
      App.showView("view-landing");
    });

    // Same full-size viewer as the reviewer flow, for GT and model views alike.
    el["adj-image"].addEventListener("click", function () {
      App.openZoom(el["adj-image"].src);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    cacheElements();
    buildCheckboxes(el["adj-defect-types"], Core.DEFECT_TYPES, "adj-defect");
    buildCheckboxes(el["adj-target-classes"], Core.TARGET_CLASSES, "adj-class");
    bind();
  });
})();
