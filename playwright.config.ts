import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:33815';

export default defineConfig({
  testDir: './e2e',
  // Playwright cleans its output directory; keep other release evidence intact.
  outputDir: 'test-results/playwright',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  /*
   * CI 保留 1 次重试只为区分「确定性失败」与「flaky」并留下 on-first-retry trace；
   * failOnFlakyTests 让「重试后才通过」的用例同样判红，flake 不会被重试掩盖。
   */
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: true,
  /* 单 daemon + SQLite：并行易触发争抢，改为顺序跑 e2e */
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: 'zh-CN',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
