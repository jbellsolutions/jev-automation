/** esbuild plugin: `import { listElements } from "virtual:page-script"` becomes the core page
 *  script inlined as real code, so the content script needs no eval (page CSPs forbid it). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../core/page-script.ts", import.meta.url));

/** Pull the raw template literal out of core/page-script.ts without executing TypeScript. */
export function pageScriptSource(file = SOURCE) {
  const text = readFileSync(file, "utf8");
  const m = /PAGE_SCRIPT = String\.raw`([\s\S]*?)`;\s*$/m.exec(text);
  if (!m) throw new Error(`PAGE_SCRIPT not found in ${file}`);
  return m[1];
}

export function pageScriptPlugin() {
  return {
    name: "jev-page-script",
    setup(build) {
      build.onResolve({ filter: /^virtual:page-script$/ }, () => ({ path: "virtual:page-script", namespace: "jev-virtual" }));
      build.onLoad({ filter: /.*/, namespace: "jev-virtual" }, () => ({
        contents: `export const listElements = ${pageScriptSource()};`,
        loader: "js",
        watchFiles: [SOURCE],
      }));
    },
  };
}
