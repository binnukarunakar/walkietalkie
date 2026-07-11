import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["shared", "server/vitest.config.ts", "client/vitest.config.ts"],
  },
});
