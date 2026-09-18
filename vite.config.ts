import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The React client lives in ./client and imports shared types from ../server. */
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist/client", emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://localhost:3000",
      "/demo": "http://localhost:3000",
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
