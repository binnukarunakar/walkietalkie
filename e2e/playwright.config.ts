import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8199",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
        permissions: ["microphone"],
      },
    },
  ],
  webServer: {
    // The build runs in the `e2e` npm script so a reused stale server can
    // never masquerade as fresh code.
    command:
      "PORT=8199 JOIN_RATE_MAX=1000 LOG_LEVEL=warn MAX_HOLD_MS=10000 MAX_CHANNEL_SIZE=3 node server/dist/index.js",
    cwd: appRoot,
    url: "http://127.0.0.1:8199/healthz",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
