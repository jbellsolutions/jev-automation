/** Bundles the Chrome bridge into dist/extension (load it unpacked from there). */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadEnvFile } from "../server/env.ts";
import { pageScriptPlugin } from "./page-script-plugin.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}dist/extension`;
mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: "browser", target: "chrome120", format: "esm", sourcemap: false, logLevel: "info", plugins: [pageScriptPlugin()] };
await build({ ...common, entryPoints: [`${root}extension/background.ts`], outfile: `${out}/background.js` });
await build({ ...common, format: "iife", entryPoints: [`${root}extension/content.ts`], outfile: `${out}/content.js` });
await build({ ...common, format: "iife", entryPoints: [`${root}extension/options.ts`], outfile: `${out}/options.js` });
for (const f of ["manifest.json", "options.html"]) copyFileSync(`${root}extension/${f}`, `${out}/${f}`);
// pairing: the companion's own token and address ride along, so loading the folder is enough
loadEnvFile(`${root}.env`);
const token = process.env.JEV_TOKEN ?? "";
const port = process.env.JEV_BRIDGE_PORT ?? "3111";
writeFileSync(`${out}/config.json`, `${JSON.stringify({ url: `ws://127.0.0.1:${port}/ws/bridge`, token }, null, 2)}\n`, { mode: 0o600 });
console.log(`extension → ${out}${token ? " (paired with this companion's token)" : " (no JEV_TOKEN in .env: set it in the extension options)"}`);
