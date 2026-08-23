import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ui.e2e.spec.mjs",
  timeout: 30_000,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "../../.qa-results/ui-e2e.json" }],
  ],
  use: {
    baseURL: process.env.QA_UI_URL || "http://127.0.0.1:15173",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../../.qa-results/playwright-artifacts",
});
