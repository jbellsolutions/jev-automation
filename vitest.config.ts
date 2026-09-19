import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "core/**/*.test.ts", "client/src/**/*.test.ts"],
    environment: "node",
  },
});
