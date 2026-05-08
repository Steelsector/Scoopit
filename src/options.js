import { DEFAULT_OPTIONS, loadOptions, saveOptions } from "./core.js";

function clampMaxRows(value) {
  return Math.min(100, Math.max(1, Number(value) || DEFAULT_OPTIONS.maxRows || 100));
}

async function init() {
  const storage = globalThis.chrome?.storage?.sync;
  const options = await loadOptions(storage);

  document.getElementById("dryRun").checked = options.dryRun;
  document.getElementById("delayMs").value = String(options.delayMs);
  document.getElementById("retryCount").value = String(options.retryCount);
  document.getElementById("maxRows").value = String(clampMaxRows(options.maxRows));
  document.getElementById("persistDedupe").checked = options.persistDedupe;
  document.getElementById("blockedNames").value = options.blockedNames.join("\n");

  document.getElementById("save").addEventListener("click", async () => {
    const next = {
      ...DEFAULT_OPTIONS,
      dryRun: document.getElementById("dryRun").checked,
      delayMs: Number(document.getElementById("delayMs").value || 0),
      retryCount: Number(document.getElementById("retryCount").value || 0),
      maxRows: clampMaxRows(document.getElementById("maxRows").value),
      persistDedupe: document.getElementById("persistDedupe").checked,
      blockedNames: document
        .getElementById("blockedNames")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    };
    await saveOptions(storage, next);
    document.getElementById("status").textContent = "Saved.";
  });
}

init();
