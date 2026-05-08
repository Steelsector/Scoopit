import { mkdir, cp, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });

await cp("src/popup.html", "dist/popup.html");
await cp("src/options.html", "dist/options.html");
await cp("src/core.js", "dist/core.js");

const manifestRaw = await readFile("manifest.json", "utf8");
const manifest = JSON.parse(manifestRaw);

manifest.content_scripts = manifest.content_scripts.map((entry) => ({
  ...entry,
  js: entry.js.map((file) => file.replace(/^src\//, ""))
}));
manifest.options_page = "options.html";
manifest.action = {
  ...manifest.action,
  default_popup: "popup.html"
};

await writeFile("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
