import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeText,
  normalizeSetupName,
  shouldRunOnPage,
  collectCandidates,
  createDryRunPlan,
  discoverRowsFromDom,
  createFilterPolicy,
  createRunState,
  createImportOrchestrator,
  createAuditLogger,
  createUiActionAdapter
} from "../src/core.js";

test("normalizeText trims, lowercases, and collapses whitespace", () => {
  assert.equal(normalizeText("  Baseline   Setup  "), "baseline setup");
});

test("normalizeSetupName applies underscore normalization", () => {
  assert.equal(normalizeSetupName("Low Downforce Sprint"), "low_downforce_sprint");
});

test("shouldRunOnPage only allows garage61 laps path", () => {
  assert.equal(shouldRunOnPage("https://garage61.net/app/laps/324/6;a=-1"), true);
  assert.equal(shouldRunOnPage("https://garage61.net/app/home"), false);
  assert.equal(shouldRunOnPage("https://example.com/app/laps/324/6"), false);
});

test("collectCandidates returns setup-capable entries", () => {
  const rows = [
    { id: "1", title: "Fixed", hasSetupButton: true },
    { id: "2", title: "Race", hasSetupButton: false },
    { id: "3", title: "Sprint", hasSetupButton: true }
  ];

  const out = collectCandidates(rows);
  assert.deepEqual(out.map((r) => r.id), ["1", "3"]);
});

test("createDryRunPlan never marks actions as import", () => {
  const plan = createDryRunPlan([
    { id: "1", title: "Fixed", hasSetupButton: true },
    { id: "2", title: "Race", hasSetupButton: true }
  ]);

  assert.equal(plan.every((item) => item.action === "dry-run-scan"), true);
});

test("discoverRowsFromDom extracts row id/title and setup availability", () => {
  const fakeDoc = {
    querySelectorAll() {
      return [
        {
          getAttribute(name) {
            return name === "data-lap-id" ? "lap-1" : null;
          },
          querySelector(sel) {
            if (sel === "button, a") {
              return { textContent: "Setup" };
            }
            if (sel === "[data-setup-name], .setup-name, .name") {
              return { textContent: " Quali Sprint " };
            }
            return null;
          },
          textContent: "fallback"
        },
        {
          getAttribute() {
            return null;
          },
          querySelector(sel) {
            if (sel === "button, a") {
              return { textContent: "Open" };
            }
            return null;
          },
          textContent: "No setup row"
        }
      ];
    }
  };

  const rows = discoverRowsFromDom(fakeDoc);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "lap-1");
  assert.equal(rows[0].title, "Quali Sprint");
  assert.equal(rows[0].hasSetupButton, true);
  assert.equal(rows[1].hasSetupButton, false);
  assert.equal(rows[1].skipReason, "no-setup-button");
});

test("filter policy blocks required setup names", () => {
  const policy = createFilterPolicy();
  assert.equal(policy.isBlocked("baseline"), true);
  assert.equal(policy.isBlocked("Low Downforce Sprint"), true);
  assert.equal(policy.isBlocked("my_custom_setup"), false);
});

test("orchestrator imports only allowed setup and reports summary", async () => {
  const logger = createAuditLogger();
  const runState = createRunState();
  const policy = createFilterPolicy();
  const imported = [];
  const adapter = {
    async importSetup(row, setupName) {
      imported.push({ id: row.id, setupName });
    }
  };

  const orchestrator = createImportOrchestrator({
    policy,
    runState,
    adapter,
    options: { dryRun: false, delayMs: 0, retryCount: 0, persistDedupe: true },
    logger
  });

  const summary = await orchestrator.run([
    { id: "1", title: "baseline", hasSetupButton: true },
    { id: "2", title: "My Setup", hasSetupButton: true },
    { id: "3", title: "No Button", hasSetupButton: false }
  ]);

  assert.deepEqual(imported, [{ id: "2", setupName: "My Setup" }]);
  assert.deepEqual(summary, { imported: 1, skipped: 2, duplicate: 0, errors: 0 });
});

test("orchestrator dedupes and retries failures", async () => {
  const logger = createAuditLogger();
  const runState = createRunState();
  const policy = createFilterPolicy([]);
  const attempts = new Map();
  const adapter = {
    async importSetup(row) {
      const next = (attempts.get(row.id) || 0) + 1;
      attempts.set(row.id, next);
      if (row.id === "a" && next === 1) {
        throw new Error("transient");
      }
    }
  };

  const orchestrator = createImportOrchestrator({
    policy,
    runState,
    adapter,
    options: { dryRun: false, delayMs: 0, retryCount: 1, persistDedupe: true },
    logger
  });

  const summary1 = await orchestrator.run([
    { id: "a", title: "First", hasSetupButton: true },
    { id: "a", title: "First", hasSetupButton: true }
  ]);
  const summary2 = await orchestrator.run([{ id: "a", title: "First", hasSetupButton: true }]);

  assert.equal(attempts.get("a"), 2);
  assert.deepEqual(summary1, { imported: 1, skipped: 0, duplicate: 1, errors: 0 });
  assert.deepEqual(summary2, { imported: 0, skipped: 0, duplicate: 1, errors: 0 });
});

test("ui adapter fills modal, selects personal folder, and saves", async () => {
  const trigger = { clicked: false, click() { this.clicked = true; } };
  const nameInput = {
    value: "",
    events: [],
    dispatchEvent(evt) { this.events.push(evt.type); }
  };
  const folderButton = { clicked: false, click() { this.clicked = true; } };
  const saveButton = { textContent: " Save ", clicked: false, click() { this.clicked = true; } };

  const folderLabel = {
    textContent: " My personal setups ",
    closest() {
      return folderButton;
    }
  };

  const modal = {
    querySelector(sel) {
      if (sel === "input#name") {
        return nameInput;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "cdk-tree .p-3") {
        return [folderLabel];
      }
      if (sel === ".modal-footer button") {
        return [saveButton];
      }
      return [];
    }
  };

  const doc = {
    querySelector(sel) {
      if (sel === "app-file-operation-modal") {
        return modal;
      }
      return null;
    }
  };

  const adapter = createUiActionAdapter({ doc });
  await adapter.importSetup({ node: { querySelector() { return trigger; } } }, "My New Setup");

  assert.equal(trigger.clicked, true);
  assert.equal(nameInput.value, "My New Setup");
  assert.deepEqual(nameInput.events, ["input", "change"]);
  assert.equal(folderButton.clicked, true);
  assert.equal(saveButton.clicked, true);
});
