export const DEFAULT_BLOCKLIST = [
  "baseline",
  "fixed",
  "low_downforce_sprint",
  "high_downforce_sprint",
  "medium_downforce_sprint"
];

export const DEFAULT_OPTIONS = {
  dryRun: true,
  delayMs: 300,
  retryCount: 1,
  persistDedupe: true,
  blockedNames: DEFAULT_BLOCKLIST
};

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeSetupName(value) {
  return normalizeText(value).replace(/[\s-]+/g, "_");
}

export function shouldRunOnPage(urlString) {
  try {
    const url = new URL(urlString);
    return url.hostname === "garage61.net" && url.pathname.startsWith("/app/laps/");
  } catch {
    return false;
  }
}

export function discoverRowsFromDom(doc) {
  const rowNodes = Array.from(doc.querySelectorAll("[data-lap-row], tr, .lap-row, .result-row"));
  return rowNodes.map((node, index) => {
    const setupButton = node.querySelector("button, a");
    const titleNode = node.querySelector("[data-setup-name], .setup-name, .name") ?? node;
    const hasSetupButton = Boolean(setupButton && /setup/i.test(setupButton.textContent || ""));
    return {
      id: node.getAttribute("data-lap-id") || `row-${index}`,
      title: (titleNode.textContent || "").trim(),
      hasSetupButton,
      skipReason: hasSetupButton ? null : "no-setup-button",
      node
    };
  });
}

export function collectCandidates(rows) {
  return rows.filter((row) => Boolean(row?.hasSetupButton));
}

export function createDryRunPlan(rows) {
  return collectCandidates(rows).map((row) => ({
    id: row.id,
    title: row.title,
    action: "dry-run-scan"
  }));
}

export function createFilterPolicy(blockedNames = DEFAULT_BLOCKLIST) {
  const normalized = new Set(blockedNames.map(normalizeSetupName));
  return {
    isBlocked(name) {
      return normalized.has(normalizeSetupName(name));
    }
  };
}

export function resolveSetupName(row) {
  return (row.title || "").trim();
}

export function createRunState() {
  return {
    running: false,
    seenInRun: new Set(),
    seenPersistent: new Set(),
    start() {
      this.running = true;
      this.seenInRun.clear();
    },
    stop() {
      this.running = false;
    },
    hasSeen(key, usePersistent) {
      return this.seenInRun.has(key) || (usePersistent && this.seenPersistent.has(key));
    },
    markSeen(key, usePersistent) {
      this.seenInRun.add(key);
      if (usePersistent) {
        this.seenPersistent.add(key);
      }
    }
  };
}

export async function loadOptions(storage) {
  if (!storage?.get) {
    return { ...DEFAULT_OPTIONS };
  }
  const loaded = await storage.get(Object.keys(DEFAULT_OPTIONS));
  return {
    ...DEFAULT_OPTIONS,
    ...loaded,
    blockedNames: loaded?.blockedNames ?? DEFAULT_OPTIONS.blockedNames
  };
}

export async function saveOptions(storage, options) {
  if (!storage?.set) {
    return;
  }
  await storage.set(options);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForElement(doc, selector, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = doc.querySelector(selector);
    if (el) {
      return el;
    }
    await sleep(100);
  }
  throw new Error(`element-not-found:${selector}`);
}

export function createImportOrchestrator({
  policy,
  runState,
  adapter,
  options,
  logger
}) {
  return {
    async run(rows) {
      runState.start();
      const summary = { imported: 0, skipped: 0, duplicate: 0, errors: 0 };

      for (const row of rows) {
        if (!runState.running) {
          break;
        }

        if (!row.hasSetupButton) {
          summary.skipped += 1;
          logger.log({ id: row.id, status: "skipped", reason: "no-setup-button" });
          continue;
        }

        const setupName = resolveSetupName(row);
        if (policy.isBlocked(setupName)) {
          summary.skipped += 1;
          logger.log({ id: row.id, status: "skipped", reason: "blocked-name", setupName });
          continue;
        }

        const dedupeKey = `${row.id}:${normalizeSetupName(setupName)}`;
        if (runState.hasSeen(dedupeKey, options.persistDedupe)) {
          summary.duplicate += 1;
          logger.log({ id: row.id, status: "skipped", reason: "duplicate", setupName });
          continue;
        }

        runState.markSeen(dedupeKey, options.persistDedupe);

        if (options.dryRun) {
          summary.skipped += 1;
          logger.log({ id: row.id, status: "dry-run", setupName });
          continue;
        }

        let success = false;
        for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
          try {
            await adapter.importSetup(row, setupName);
            success = true;
            break;
          } catch {
            if (attempt < options.retryCount) {
              await sleep(options.delayMs);
            }
          }
        }

        if (success) {
          summary.imported += 1;
          logger.log({ id: row.id, status: "imported", setupName });
        } else {
          summary.errors += 1;
          logger.log({ id: row.id, status: "error", reason: "import-failed", setupName });
        }

        await sleep(options.delayMs);
      }

      runState.stop();
      logger.logSummary(summary);
      return summary;
    }
  };
}

function findFolderButton(modal, folderName) {
  const labels = Array.from(modal.querySelectorAll("cdk-tree .p-3"));
  const target = labels.find((el) => normalizeText(el.textContent) === normalizeText(folderName));
  if (!target) {
    return null;
  }
  return target.closest("[role='button']");
}

export function createUiActionAdapter(ctx = {}) {
  const doc = ctx.doc ?? document;
  return {
    async importSetup(row, setupName) {
      const trigger = row.node?.querySelector("button, a");
      if (!trigger) {
        throw new Error("no setup trigger");
      }
      trigger.click();

      const modal = await waitForElement(doc, "app-file-operation-modal");
      const nameInput = await waitForElement(modal, "input#name");
      nameInput.value = setupName;
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));

      const folderButton = findFolderButton(modal, "My personal setups");
      if (!folderButton) {
        throw new Error("personal-folder-not-found");
      }
      folderButton.click();

      const saveButton = Array.from(modal.querySelectorAll(".modal-footer button")).find(
        (btn) => normalizeText(btn.textContent) === "save"
      );
      if (!saveButton) {
        throw new Error("save-button-not-found");
      }
      saveButton.click();
    }
  };
}

export function createAuditLogger() {
  const entries = [];
  let summary = null;
  return {
    log(entry) {
      entries.push(entry);
    },
    logSummary(value) {
      summary = value;
    },
    getEntries() {
      return entries;
    },
    getSummary() {
      return summary;
    }
  };
}
