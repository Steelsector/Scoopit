const DEFAULT_BLOCKLIST = [
  "baseline",
  "fixed",
  "low_downforce_sprint",
  "high_downforce_sprint",
  "medium_downforce_sprint"
];

const DEFAULT_OPTIONS = {
  dryRun: true,
  delayMs: 300,
  retryCount: 1,
  persistDedupe: true,
  debugMode: false,
  blockedNames: DEFAULT_BLOCKLIST,
  maxRows: 100
};

function normalizeText(value) {
  return String(value ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}
function normalizeLoose(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}
function normalizeSetupName(value) { return normalizeText(value).replace(/[\s-]+/g, "_"); }
function shouldRunOnPage(urlString) { try { const url = new URL(urlString); return url.hostname === "garage61.net" && url.pathname.startsWith("/app/laps/"); } catch { return false; } }

function isLikelyLapContext(node) {
  const text = normalizeText(node.textContent || "");
  return text.includes("analyze") || text.includes("copy lap id") || text.includes("ghost");
}

function isInsideNav(el) {
  return Boolean(el.closest("header, nav, .navbar, .menu, .sidebar, app-nav, app-header"));
}

function getSetupButtonDiagnostics(doc) {
  const allSetupish = Array.from(doc.querySelectorAll("span.btn[role='button']"))
    .filter((el) => normalizeText(el.textContent || "").includes("setup"));
  const rows = [];
  let eligible = 0;
  let locked = 0;
  let profile = 0;
  let noWrench = 0;
  let nav = 0;
  let noLapContext = 0;

  for (const el of allSetupish) {
    const label = normalizeText(el.textContent || "");
    if (label !== "setup") continue;
    const hasWrench = Boolean(el.querySelector("ui-icon[name='wrench'], .lucide-wrench"));
    const hasProfileImage = Boolean(el.querySelector("app-profile-image, img.profile-image"));
    const isLocked = Boolean(el.classList.contains("btn-g61-tertiary") || el.querySelector("ui-icon[name='lockFill'], .bi-lock-fill"));
    const inNav = isInsideNav(el);
    const container = el.closest("tr, .row, .card, .list-group-item, .mat-row, [role='row'], td, li, article, section") || el.parentElement;
    const lapContext = Boolean(container && isLikelyLapContext(container));

    let reason = "";
    if (inNav) reason = "nav";
    else if (isLocked) reason = "locked";
    else if (hasProfileImage) reason = "profile";
    else if (!hasWrench) reason = "no-wrench";
    else if (!lapContext) reason = "no-lap-context";
    else reason = "eligible";

    if (reason === "eligible") eligible += 1;
    if (reason === "locked") locked += 1;
    if (reason === "profile") profile += 1;
    if (reason === "no-wrench") noWrench += 1;
    if (reason === "nav") nav += 1;
    if (reason === "no-lap-context") noLapContext += 1;

    rows.push({
      text: (el.textContent || "").trim().slice(0, 80),
      classes: el.className,
      reason
    });
  }

  return {
    totalSetupish: allSetupish.length,
    eligible,
    locked,
    profile,
    noWrench,
    nav,
    noLapContext,
    sampleRejected: rows.filter((r) => r.reason !== "eligible").slice(0, 12)
  };
}

function findSetupButtons(doc) {
  return Array.from(doc.querySelectorAll("span.btn.btn-g61-secondary.btn-xs[role='button']")).filter((el) => {
    const label = normalizeText(el.textContent || "");
    if (label !== "setup") return false;
    const hasWrenchIcon = Boolean(el.querySelector("ui-icon[name='wrench'], .lucide-wrench"));
    if (!hasWrenchIcon) return false;
    const hasProfileImage = Boolean(el.querySelector("app-profile-image, img.profile-image"));
    if (hasProfileImage) return false;
    if (isInsideNav(el)) return false;
    const container = el.closest("tr, .row, .card, .list-group-item, .mat-row, [role='row'], td, li, article, section") || el.parentElement;
    return Boolean(container && isLikelyLapContext(container));
  });
}

function extractTitleFromContext(node) {
  const fromAttrs = node.getAttribute?.("data-setup-name") || node.getAttribute?.("title");
  if (fromAttrs) return fromAttrs.trim();
  const named = node.querySelector?.("[data-setup-name], .setup-name, .name, [title]");
  if (named && (named.textContent || named.getAttribute?.("title"))) {
    return ((named.textContent || named.getAttribute("title") || "") + "").trim();
  }
  const text = (node.textContent || "").trim();
  return text.slice(0, 120);
}

function discoverRowsFromDom(doc) {
  const setupButtons = findSetupButtons(doc);
  return setupButtons.map((btn, index) => {
    const container = btn.closest("tr, .row, .card, .list-group-item, .mat-row, [role='row'], td, li, article, section") || btn.parentElement || btn;
    const analyzeLink = container.querySelector("a[href*='/app/analyze']");
    const analyzeHref = analyzeLink?.getAttribute("href") || "";
    const tokenMatch = analyzeHref.match(/(?:^|[;?])t=([^;&]+)/);
    return {
      id: container.getAttribute?.("data-lap-id") || btn.getAttribute?.("data-lap-id") || `setup-${index}`,
      title: extractTitleFromContext(container),
      analyzeHref,
      analyzeToken: tokenMatch ? tokenMatch[1] : "",
      node: container,
      trigger: btn
    };
  });
}

async function collectLazyLoadedRows(doc, maxRows, delayMs) {
  const seen = new Map();
  let stagnantRounds = 0;
  let rounds = 0;
  let lastButtonCount = 0;
  const maxRounds = 160;
  const stepPx = Math.max(500, Math.floor((window.innerHeight || 900) * 0.9));

  function isScrollable(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    return (overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 20;
  }

  function findScrollContainer() {
    const buttons = findSetupButtons(doc);
    for (const btn of buttons) {
      let p = btn.parentElement;
      while (p && p !== document.body) {
        if (isScrollable(p)) {
          return p;
        }
        p = p.parentElement;
      }
    }
    const candidates = Array.from(document.querySelectorAll("div,section,main,article"))
      .filter((el) => isScrollable(el))
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || (document.scrollingElement || document.documentElement || document.body);
  }

  let scrollEl = findScrollContainer();

  while (rounds < maxRounds && seen.size < maxRows && stagnantRounds < 10) {
    rounds += 1;
    if (rounds % 10 === 0) {
      scrollEl = findScrollContainer();
    }
    const found = discoverRowsFromDom(doc);
    const before = seen.size;
    for (const row of found) {
      const key = `${row.id}:${normalizeSetupName(row.title)}`;
      if (!seen.has(key)) seen.set(key, row);
      if (seen.size >= maxRows) break;
    }

    const currentButtonCount = findSetupButtons(doc).length;
    const grewRows = seen.size > before;
    const grewButtons = currentButtonCount > lastButtonCount;
    stagnantRounds = (!grewRows && !grewButtons) ? stagnantRounds + 1 : 0;
    lastButtonCount = currentButtonCount;

    const isDocScroller = scrollEl === document.scrollingElement || scrollEl === document.documentElement || scrollEl === document.body;
    const viewportHeight = isDocScroller ? (window.innerHeight || 0) : (scrollEl.clientHeight || 0);
    const nextTop = Math.min(
      (scrollEl.scrollTop || 0) + stepPx,
      Math.max(0, (scrollEl.scrollHeight || 0) - viewportHeight)
    );
    if (isDocScroller) {
      window.scrollTo({ top: nextTop, behavior: "instant" });
    } else {
      scrollEl.scrollTop = nextTop;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(350, delayMs)));
  }
  const isDocScroller = scrollEl === document.scrollingElement || scrollEl === document.documentElement || scrollEl === document.body;
  if (isDocScroller) {
    window.scrollTo({ top: 0, behavior: "instant" });
  } else {
    scrollEl.scrollTop = 0;
  }
  return Array.from(seen.values()).slice(0, maxRows);
}

function createFilterPolicy(blockedNames = DEFAULT_BLOCKLIST) {
  const normalized = new Set(blockedNames.map(normalizeSetupName));
  return { isBlocked(name) { return normalized.has(normalizeSetupName(name)); } };
}
function resolveSetupName(row) { return (row.title || "").trim(); }
function createRunState() {
  return {
    running: false,
    seenInRun: new Set(),
    seenPersistent: new Set(),
    start() { this.running = true; this.seenInRun.clear(); },
    stop() { this.running = false; },
    hasSeen(key, usePersistent) { return this.seenInRun.has(key) || (usePersistent && this.seenPersistent.has(key)); },
    markSeen(key, usePersistent) { this.seenInRun.add(key); if (usePersistent) this.seenPersistent.add(key); }
  };
}
async function loadOptions(storage) {
  if (!storage?.get) return { ...DEFAULT_OPTIONS };
  const loaded = await storage.get(Object.keys(DEFAULT_OPTIONS));
  return {
    ...DEFAULT_OPTIONS,
    ...loaded,
    blockedNames: loaded?.blockedNames ?? DEFAULT_OPTIONS.blockedNames,
    maxRows: Number(loaded?.maxRows ?? DEFAULT_OPTIONS.maxRows)
  };
}
async function sleep(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForElement(root, selector, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = root.querySelector(selector);
    if (el) return el;
    await sleep(100);
  }
  throw new Error(`element-not-found:${selector}`);
}

function findFolderButton(modal, folderName) {
  const labels = Array.from(modal.querySelectorAll("cdk-tree .p-3"));
  const target = labels.find((el) => normalizeText(el.textContent) === normalizeText(folderName));
  return target ? target.closest("[role='button']") : null;
}

function detectYearSeason(doc, setupName = "") {
  const haystack = `${setupName} ${doc.title || ""} ${doc.body?.textContent || ""}`;
  const compact = haystack.match(/\b(20\d{2}|2\d)s(\d)\b/i);
  if (compact) {
    const yearToken = compact[1];
    const year = yearToken.length === 2 ? `20${yearToken}` : yearToken;
    const season = compact[2];
    return { strict: normalizeText(`${year} s${season}`), loose: normalizeLoose(`${year}s${season}`) };
  }
  const yearMatch = haystack.match(/\b(20\d{2})\b/);
  const seasonMatch = haystack.match(/\b(?:season\s*(\d{1,2})|s(\d{1,2})|spring|summer|autumn|fall|winter)\b/i);
  if (!yearMatch || !seasonMatch) return null;
  const year = yearMatch[1];
  const seasonToken = seasonMatch[1] || seasonMatch[2] || seasonMatch[0];
  return { strict: normalizeText(`${year} ${seasonToken}`), loose: normalizeLoose(`${year}${seasonToken}`) };
}

async function expandPersonalSetupsIfNeeded(modal) {
  const labels = Array.from(modal.querySelectorAll("cdk-tree .p-3"));
  const personalLabel = labels.find((el) => normalizeText(el.textContent) === normalizeText("My personal setups"));
  if (!personalLabel) return;
  const parentNode = personalLabel.closest("cdk-nested-tree-node");
  if (!parentNode) return;
  const isExpanded = parentNode.getAttribute("aria-expanded") === "true";
  const childContainer = parentNode.querySelector(":scope > div:last-child");
  const childHidden = childContainer?.classList?.contains("d-none");
  if (!isExpanded || childHidden) {
    const clickTarget = personalLabel.closest("[role='button']");
    if (clickTarget) clickTarget.click();
    await sleep(150);
  }
}

function parseYearSeasonToken(text) {
  const loose = normalizeLoose(text);
  const m = loose.match(/(20\d{2})s(\d{1,2})/);
  if (!m) return null;
  return { year: Number(m[1]), season: Number(m[2]), loose };
}

function getPersonalSubfolderButtons(modal) {
  const labels = Array.from(modal.querySelectorAll("cdk-tree .p-3"));
  const personalLabel = labels.find((el) => normalizeText(el.textContent) === normalizeText("My personal setups"));
  if (!personalLabel) return [];
  const parentNode = personalLabel.closest("cdk-nested-tree-node");
  if (!parentNode) return [];

  const childLabels = Array.from(parentNode.querySelectorAll(":scope > div:last-child cdk-nested-tree-node .p-3"));
  return childLabels.map((label) => ({
    label,
    text: normalizeText(label.textContent || ""),
    loose: normalizeLoose(label.textContent || ""),
    button: label.closest("[role='button']")
  })).filter((x) => x.button);
}

async function findBestFolderButton(modal, doc, setupName) {
  await expandPersonalSetupsIfNeeded(modal);
  const labels = Array.from(modal.querySelectorAll("cdk-tree .p-3"));
  const normalized = labels.map((el) => ({
    el,
    text: normalizeText(el.textContent),
    loose: normalizeLoose(el.textContent)
  }));
  const yearSeason = detectYearSeason(doc, setupName);
  const personalChildren = getPersonalSubfolderButtons(modal);

  if (yearSeason && personalChildren.length > 0) {
    const [year, ...seasonParts] = yearSeason.strict.split(" ");
    const season = seasonParts.join("");
    const subfolder = personalChildren.find(
      (item) =>
        (item.text.includes(year) && item.text.replace(/\s+/g, "").includes(season)) ||
        item.loose.includes(yearSeason.loose)
    );
    if (subfolder) {
      return subfolder.button;
    }
  }

  const seasonFolders = personalChildren
    .map((item) => ({ item, parsed: parseYearSeasonToken(item.text) }))
    .filter((x) => x.parsed);
  if (seasonFolders.length > 0) {
    seasonFolders.sort((a, b) => {
      if (a.parsed.year !== b.parsed.year) return b.parsed.year - a.parsed.year;
      return b.parsed.season - a.parsed.season;
    });
    return seasonFolders[0].item.button;
  }

  const personal = normalized.find((item) => item.text === normalizeText("My personal setups"));
  return personal ? personal.el.closest("[role='button']") : null;
}

function listFolderLabels(modal) {
  return Array.from(modal.querySelectorAll("cdk-tree .p-3")).map((el) => normalizeText(el.textContent || ""));
}

async function resolveFolderButtonWithRetry(modal, doc, setupName, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const btn = await findBestFolderButton(modal, doc, setupName);
    if (btn) return btn;
    await sleep(120);
  }
  return null;
}

function closeAnyKnownModals(doc) {
  const modals = Array.from(doc.querySelectorAll(".modal-dialog .modal-content"));
  for (const modal of modals) {
    const closeButton = modal.querySelector("button.btn-close")
      || Array.from(modal.querySelectorAll("button")).find((btn) => normalizeText(btn.textContent) === "close");
    if (closeButton) closeButton.click();
  }
  const globalCloseButtons = Array.from(
    doc.querySelectorAll("button.btn-close, .modal-footer button, app-setup-modal button, app-file-operation-modal button")
  );
  for (const button of globalCloseButtons) {
    const label = normalizeText(button.textContent || "");
    if (label === "close") {
      button.click();
    }
  }
}

async function closeModalsAndWait(doc, timeoutMs = 2000) {
  closeAnyKnownModals(doc);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const stillOpen = doc.querySelector(".modal-dialog .modal-content, app-file-operation-modal, app-setup-modal");
    if (!stillOpen) {
      return;
    }
    await sleep(80);
  }
}

function hasAlreadyExistsError(addFileModal) {
  return Array.from(addFileModal.querySelectorAll(".alert, .alert-danger"))
    .some((el) => normalizeText(el.textContent || "").includes("a file with this name already exists"));
}

function findRowByAnalyzeRef(doc, analyzeHref, analyzeToken) {
  let link = null;
  if (analyzeToken) {
    link = doc.querySelector(`a[href*=";t=${analyzeToken}"], a[href*="?t=${analyzeToken}"], a[href*="&t=${analyzeToken}"]`);
  }
  if (!link && analyzeHref) {
    const escaped = analyzeHref.replace(/"/g, '\\"');
    link = doc.querySelector(`a[href="${escaped}"]`);
  }
  if (!link) return null;
  return link.closest("tr, .row, .card, .list-group-item, .mat-row, [role='row'], td, li, article, section");
}

async function findLiveTriggerForRow(doc, row, delayMs) {
  const direct = row.trigger;
  if (direct && direct.isConnected) {
    return direct;
  }

  let liveRow = findRowByAnalyzeRef(doc, row.analyzeHref, row.analyzeToken);
  if (liveRow) {
    const btn = liveRow.querySelector("span.btn.btn-g61-secondary.btn-xs[role='button'] ui-icon[name='wrench']")?.closest("span.btn.btn-g61-secondary.btn-xs[role='button']");
    if (btn) return btn;
  }

  const scrollEl = document.scrollingElement || document.documentElement || document.body;
  const maxTop = Math.max(0, (scrollEl.scrollHeight || 0) - (window.innerHeight || 0));
  const step = Math.max(500, Math.floor((window.innerHeight || 900) * 0.9));

  for (let top = 0; top <= maxTop; top += step) {
    window.scrollTo({ top, behavior: "instant" });
    await sleep(Math.max(200, delayMs));
    liveRow = findRowByAnalyzeRef(doc, row.analyzeHref, row.analyzeToken);
    if (liveRow) {
      const btn = liveRow.querySelector("span.btn.btn-g61-secondary.btn-xs[role='button'] ui-icon[name='wrench']")?.closest("span.btn.btn-g61-secondary.btn-xs[role='button']");
      if (btn) return btn;
    }
  }

  return null;
}

function createUiActionAdapter(doc = document, policy = null) {
  return {
    async importSetup(row, setupName) {
      await closeModalsAndWait(doc);
      const trigger = await findLiveTriggerForRow(doc, row, 250);
      if (!trigger) throw new Error("no setup trigger");
      trigger.click();

      let clickedAddToMySetups = false;
      let modalSetupName = "";
      for (let i = 0; i < 30; i += 1) {
        const setupModal = doc.querySelector("app-setup-modal");
        if (setupModal) {
          const titleEl = setupModal.querySelector("h4.modal-title app-setup-name span");
          const extracted = (titleEl?.textContent || "").trim();
          if (extracted) {
            modalSetupName = extracted;
            if (policy?.isBlocked?.(modalSetupName)) {
              await closeModalsAndWait(doc);
              throw new Error("blocked-name");
            }
          }
        }

        if (setupModal && !clickedAddToMySetups) {
          const addBtn = Array.from(setupModal.querySelectorAll("button")).find(
            (btn) => normalizeText(btn.textContent).includes("add to my setups")
          );
          if (addBtn) {
            addBtn.click();
            clickedAddToMySetups = true;
          }
        }

        const addFileModal = doc.querySelector("app-file-operation-modal");
          if (addFileModal) {
            const nameInput = await waitForElement(addFileModal, "input#name");
            const finalName = (modalSetupName || setupName || "").trim();
            if (finalName && (nameInput.value || "").trim() !== finalName) {
              nameInput.value = finalName;
            nameInput.dispatchEvent(new Event("input", { bubbles: true }));
            nameInput.dispatchEvent(new Event("change", { bubbles: true }));
          }

          await waitForElement(addFileModal, "cdk-tree");
          const folderButton = await resolveFolderButtonWithRetry(addFileModal, doc, setupName);
          if (!folderButton) {
            const labels = listFolderLabels(addFileModal).slice(0, 30);
            closeAnyKnownModals(doc);
            throw new Error(`personal-folder-not-found:${labels.join("|")}`);
          }
          folderButton.click();
          await sleep(100);

            const saveButton = Array.from(addFileModal.querySelectorAll(".modal-footer button")).find(
              (btn) => normalizeText(btn.textContent) === "save"
            );
            if (!saveButton) {
              closeAnyKnownModals(doc);
              throw new Error("save-button-not-found");
            }
            saveButton.click();
            await sleep(350);
            if (hasAlreadyExistsError(addFileModal)) {
              await closeModalsAndWait(doc);
              throw new Error("already-exists");
            }
            await sleep(350);
            await closeModalsAndWait(doc, 1000);
            return;
          }

        await sleep(100);
      }
      await closeModalsAndWait(doc);
      throw new Error("setup-modal-timeout");
    }
  };
}

function createAuditLogger() {
  const entries = [];
  let enabled = false;
  return {
    setEnabled(value) {
      enabled = Boolean(value);
    },
    log(entry) {
      entries.push(entry);
      if (enabled) {
        console.debug("[G61 Setup Collector]", entry);
      }
    },
    getEntries() {
      return entries.slice();
    }
  };
}

function createImportOrchestrator({ policy, runState, adapter, options, logger }) {
  return {
    async run(rows) {
      runState.start();
      const summary = {
        imported: 0,
        skipped: 0,
        duplicate: 0,
        errors: 0,
        skippedByReason: {},
        errorByReason: {}
      };
      const bump = (bucket, reason) => {
        const key = reason || "unknown";
        bucket[key] = (bucket[key] || 0) + 1;
      };

      for (let idx = 0; idx < rows.length; idx += 1) {
        const row = rows[idx];
        runLastProgressAt = Date.now();
        if (!options.debugMode && idx % 10 === 0) {
          console.info("[G61 Setup Collector] Progress", { current: idx + 1, total: rows.length });
        }
        const setupName = resolveSetupName(row);

        if (policy.isBlocked(setupName)) {
          summary.skipped += 1;
          bump(summary.skippedByReason, "blocked-name");
          logger.log({ id: row.id, status: "skipped", reason: "blocked-name", setupName });
          continue;
        }

        const dedupeKey = `${row.id}:${normalizeSetupName(setupName)}`;
        if (runState.hasSeen(dedupeKey, options.persistDedupe)) {
          summary.duplicate += 1;
          bump(summary.skippedByReason, "duplicate");
          logger.log({ id: row.id, status: "skipped", reason: "duplicate", setupName });
          continue;
        }

        runState.markSeen(dedupeKey, options.persistDedupe);

        if (options.dryRun) {
          summary.skipped += 1;
          bump(summary.skippedByReason, "dry-run");
          logger.log({ id: row.id, status: "dry-run", setupName });
          continue;
        }

        let success = false;
        for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
          try {
            await adapter.importSetup(row, setupName);
            success = true;
            break;
          } catch (err) {
            const reason = String(err);
            if (reason.includes("no setup trigger")) {
              summary.skipped += 1;
              bump(summary.skippedByReason, "no-setup-trigger");
              logger.log({ id: row.id, status: "skipped", reason: "no-setup-trigger", setupName });
              success = null;
              break;
            }
            if (reason.includes("already-exists")) {
              summary.skipped += 1;
              bump(summary.skippedByReason, "already-exists");
              logger.log({ id: row.id, status: "skipped", reason: "already-exists", setupName });
              success = null;
              break;
            }
            if (attempt < options.retryCount) {
              await sleep(options.delayMs);
            } else {
              bump(summary.errorByReason, reason);
              logger.log({ id: row.id, status: "error", reason, setupName });
            }
          }
        }

        if (success === true) {
          summary.imported += 1;
          logger.log({ id: row.id, status: "imported", setupName });
        } else if (success === false) {
          summary.errors += 1;
          bump(summary.errorByReason, "import-failed");
        }

        await sleep(options.delayMs);
      }

      runState.stop();
      return summary;
    }
  };
}

let isRunning = false;
let runStartedAt = 0;
let runLastProgressAt = 0;
const MAX_RUN_MS = 4 * 60 * 1000;
const STALE_PROGRESS_MS = 45 * 1000;

async function runImport() {
  if (isRunning) {
    const now = Date.now();
    const stale = runLastProgressAt > 0 && now - runLastProgressAt > STALE_PROGRESS_MS;
    const tooLong = runStartedAt > 0 && now - runStartedAt > MAX_RUN_MS;
    if (stale || tooLong) {
      isRunning = false;
    } else {
      return { ok: true, message: "Import already running." };
    }
  }
  isRunning = true;
  runStartedAt = Date.now();
  runLastProgressAt = runStartedAt;
  if (!shouldRunOnPage(window.location.href)) {
    isRunning = false;
    runStartedAt = 0;
    runLastProgressAt = 0;
    return { ok: false, message: "Not on a Garage61 laps page." };
  }
  try {
    const storage = globalThis.chrome?.storage?.sync;
    const options = await loadOptions(storage);
    const maxRows = Math.min(Math.max(1, options.maxRows || 100), 100);
    const policy = createFilterPolicy(options.blockedNames);
    const runState = createRunState();
    const adapter = createUiActionAdapter(document, policy);
    const logger = createAuditLogger();
    logger.setEnabled(options.debugMode);
    const summary = {
      imported: 0,
      skipped: 0,
      duplicate: 0,
      errors: 0,
      skippedByReason: {},
      errorByReason: {}
    };
    const bump = (bucket, reason) => {
      const key = reason || "unknown";
      bucket[key] = (bucket[key] || 0) + 1;
    };

    runState.start();
    const processed = new Set();
    let stagnantRounds = 0;
    let loops = 0;
    const maxLoops = 400;
    const step = Math.max(500, Math.floor((window.innerHeight || 900) * 0.9));

    function isScrollable(el) {
      if (!el) return false;
      if (el.closest(".modal, .modal-dialog, .modal-content, ngb-modal-window")) return false;
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      return (overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 80;
    }

    function findActiveScrollContainer() {
      const buttons = findSetupButtons(document);
      for (const btn of buttons) {
        let p = btn.parentElement;
        while (p && p !== document.body) {
          if (isScrollable(p)) return p;
          p = p.parentElement;
        }
      }
      const candidates = Array.from(document.querySelectorAll("div,section,main,article"))
        .filter((el) => isScrollable(el))
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return candidates[0] || (document.scrollingElement || document.documentElement || document.body);
    }

    let scrollEl = findActiveScrollContainer();

    while (loops < maxLoops && processed.size < maxRows && stagnantRounds < 12) {
      loops += 1;
      runLastProgressAt = Date.now();
      closeAnyKnownModals(document);

      const rows = discoverRowsFromDom(document);
      if (options.debugMode && loops % 20 === 1) {
        console.info("[G61 Setup Collector] Discovery", {
          totalRows: rows.length,
          maxRows,
          diagnostics: getSetupButtonDiagnostics(document)
        });
      }

      let progressedThisLoop = false;
      for (const row of rows) {
        if (processed.size >= maxRows) break;
        const setupName = resolveSetupName(row);
        const baseKey = row.analyzeToken || row.analyzeHref || `${row.id}:${normalizeSetupName(setupName)}`;
        if (processed.has(baseKey)) {
          continue;
        }

        if (policy.isBlocked(setupName)) {
          processed.add(baseKey);
          summary.skipped += 1;
          bump(summary.skippedByReason, "blocked-name");
          logger.log({ id: row.id, status: "skipped", reason: "blocked-name", setupName });
          progressedThisLoop = true;
          continue;
        }

        if (runState.hasSeen(baseKey, options.persistDedupe)) {
          processed.add(baseKey);
          summary.duplicate += 1;
          bump(summary.skippedByReason, "duplicate");
          logger.log({ id: row.id, status: "skipped", reason: "duplicate", setupName });
          progressedThisLoop = true;
          continue;
        }

        runState.markSeen(baseKey, options.persistDedupe);

        if (options.dryRun) {
          processed.add(baseKey);
          summary.skipped += 1;
          bump(summary.skippedByReason, "dry-run");
          logger.log({ id: row.id, status: "dry-run", setupName });
          progressedThisLoop = true;
          continue;
        }

        let success = false;
        for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
          try {
            await adapter.importSetup(row, setupName);
            success = true;
            break;
          } catch (err) {
            const reason = String(err);
            if (reason.includes("already-exists")) {
              summary.skipped += 1;
              bump(summary.skippedByReason, "already-exists");
              logger.log({ id: row.id, status: "skipped", reason: "already-exists", setupName });
              success = null;
              break;
            }
            if (reason.includes("blocked-name")) {
              summary.skipped += 1;
              bump(summary.skippedByReason, "blocked-name");
              logger.log({ id: row.id, status: "skipped", reason: "blocked-name", setupName });
              success = null;
              break;
            }
            if (reason.includes("no setup trigger")) {
              summary.skipped += 1;
              bump(summary.skippedByReason, "no-setup-trigger");
              logger.log({ id: row.id, status: "skipped", reason: "no-setup-trigger", setupName });
              success = null;
              break;
            }
            if (attempt < options.retryCount) {
              await sleep(options.delayMs);
            } else {
              summary.errors += 1;
              bump(summary.errorByReason, reason);
              logger.log({ id: row.id, status: "error", reason, setupName });
            }
          }
        }

        processed.add(baseKey);
        if (success === true) {
          summary.imported += 1;
          logger.log({ id: row.id, status: "imported", setupName });
        } else if (success === false) {
          bump(summary.errorByReason, "import-failed");
        }
        progressedThisLoop = true;
        await sleep(options.delayMs);
      }

      if (!progressedThisLoop) {
        stagnantRounds += 1;
        if (loops % 8 === 0) {
          scrollEl = findActiveScrollContainer();
        }
        const isDocScroller = scrollEl === document.scrollingElement || scrollEl === document.documentElement || scrollEl === document.body;
        const viewportHeight = isDocScroller ? (window.innerHeight || 0) : (scrollEl.clientHeight || 0);
        const nextTop = Math.min(
          (scrollEl.scrollTop || 0) + step,
          Math.max(0, (scrollEl.scrollHeight || 0) - viewportHeight)
        );
        const currentTop = scrollEl.scrollTop || 0;
        if (isDocScroller) {
          window.scrollTo({ top: nextTop, behavior: "instant" });
          window.scrollBy(0, Math.floor(step / 2));
        } else {
          scrollEl.scrollTop = nextTop;
          if ((scrollEl.scrollTop || 0) === currentTop) {
            window.scrollBy(0, Math.floor(step / 2));
          }
        }
        await sleep(Math.max(300, options.delayMs));
      } else {
        stagnantRounds = 0;
      }
    }

    runState.stop();
    const entries = logger.getEntries();
    const compact = entries.map((e) => ({
      id: e.id || "",
      status: e.status || "",
      reason: e.reason || "",
      setupName: (e.setupName || "").slice(0, 80)
    }));
    if (options.debugMode && compact.length > 0) {
      console.table(compact);
    }
    console.info("[G61 Setup Collector] Summary", summary);
    return { ok: true, message: "Import finished.", summary };
  } finally {
    isRunning = false;
    runStartedAt = 0;
    runLastProgressAt = 0;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "G61_START_IMPORT") {
    return;
  }
  runImport()
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error("[G61 Setup Collector] Fatal error", err);
      sendResponse({ ok: false, message: String(err) });
    });
  return true;
});
