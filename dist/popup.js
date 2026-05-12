const DEFAULTS = {
    dryRun: true,
    delayMs: 300,
    retryCount: 1,
    persistDedupe: true,
    debugMode: false,
    maxRows: 100,
    blockedNames: [
        "baseline",
        "fixed",
        "low_downforce_sprint",
        "high_downforce_sprint",
        "medium_downforce_sprint"
    ]
};
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const saveBtn = document.getElementById("save");
function clampMaxRows(value) {
    return Math.min(100, Math.max(1, Number(value) || DEFAULTS.maxRows));
}
async function loadSettings() {
    const storage = chrome.storage?.sync;
    if (!storage) {
        return { ...DEFAULTS };
    }
    const loaded = await storage.get(Object.keys(DEFAULTS));
    return {
        ...DEFAULTS,
        ...loaded,
        blockedNames: loaded?.blockedNames ?? DEFAULTS.blockedNames,
        maxRows: clampMaxRows(loaded?.maxRows)
    };
}
async function saveSettings(settings) {
    const storage = chrome.storage?.sync;
    if (!storage) {
        return;
    }
    await storage.set(settings);
}
function renderSettings(settings) {
    document.getElementById("dryRun").checked = Boolean(settings.dryRun);
    document.getElementById("delayMs").value = String(Number(settings.delayMs) || 0);
    document.getElementById("retryCount").value = String(Number(settings.retryCount) || 0);
    document.getElementById("maxRows").value = String(clampMaxRows(settings.maxRows));
    document.getElementById("persistDedupe").checked = Boolean(settings.persistDedupe);
    document.getElementById("debugMode").checked = Boolean(settings.debugMode);
    document.getElementById("blockedNames").value = (settings.blockedNames || []).join("\n");
}
function readSettingsFromForm() {
    return {
        ...DEFAULTS,
        dryRun: document.getElementById("dryRun").checked,
        delayMs: Number(document.getElementById("delayMs").value || 0),
        retryCount: Number(document.getElementById("retryCount").value || 0),
        maxRows: clampMaxRows(document.getElementById("maxRows").value),
        persistDedupe: document.getElementById("persistDedupe").checked,
        debugMode: document.getElementById("debugMode").checked,
        blockedNames: document.getElementById("blockedNames").value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
    };
}
async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}
async function startImportWithFallback(tabId) {
    try {
        return await chrome.tabs.sendMessage(tabId, { type: "G61_START_IMPORT" });
    }
    catch (err) {
        const text = String(err || "");
        if (!text.includes("Could not establish connection")) {
            throw err;
        }
        const candidates = ["content.js", "src/content.js"];
        let injected = false;
        for (const file of candidates) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: [file]
                });
                injected = true;
                break;
            }
            catch {
                // try next candidate
            }
        }
        if (!injected) {
            throw new Error("Could not inject content script from known paths.");
        }
        return await chrome.tabs.sendMessage(tabId, { type: "G61_START_IMPORT" });
    }
}
saveBtn.addEventListener("click", async () => {
    try {
        const settings = readSettingsFromForm();
        await saveSettings(settings);
        statusEl.textContent = "Settings saved.";
    }
    catch (err) {
        statusEl.textContent = `Save failed: ${String(err)}`;
    }
});
startBtn.addEventListener("click", async () => {
    try {
        const settings = readSettingsFromForm();
        await saveSettings(settings);
        const tab = await getActiveTab();
        if (!tab?.id || !tab.url?.includes("garage61.net/app/laps/")) {
            statusEl.textContent = "Open a Garage61 laps page first.";
            return;
        }
        const response = await startImportWithFallback(tab.id);
        if (response?.ok) {
            statusEl.textContent = response.message || "Import started.";
        }
        else {
            statusEl.textContent = response?.message || "Could not start import.";
        }
    }
    catch (err) {
        statusEl.textContent = `Error: ${String(err)}`;
    }
});
(async () => {
    const settings = await loadSettings();
    renderSettings(settings);
})();
