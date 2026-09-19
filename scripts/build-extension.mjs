/** Bundles the Chrome bridge into dist/extension (load it unpacked from there). */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pageScriptPlugin } from "./page-script-plugin.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}dist/extension`;
mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: "browser", target: "chrome120", format: "esm", sourcemap: false, logLevel: "info", plugins: [pageScriptPlugin()] };
await build({ ...common, entryPoints: [`${root}extension/background.ts`], outfile: `${out}/background.js` });
await build({ ...common, format: "iife", entryPoints: [`${root}extension/content.ts`], outfile: `${out}/content.js` });
await build({ ...common, format: "iife", entryPoints: [`${root}extension/options.ts`], outfile: `${out}/options.js` });
for (const f of ["manifest.json", "options.html"]) copyFileSync(`${root}extension/${f}`, `${out}/${f}`);
console.log(`extension → ${out}`);
