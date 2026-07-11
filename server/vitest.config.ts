import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@walkietalkie/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
