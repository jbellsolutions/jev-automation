/** Bundles the Electron main process (ESM) and preload (CJS) into dist/app. Dependencies stay
 *  external and resolve from node_modules at runtime, so the bundle is only our own code. */
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node20", packages: "external", sourcemap: true, logLevel: "info" };
await build({ ...common, entryPoints: ["app/main.ts"], format: "esm", outfile: "dist/app/main.mjs" });
await build({ ...common, entryPoints: ["app/preload.cts"], format: "cjs", outfile: "dist/app/preload.cjs" });
