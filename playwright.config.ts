import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.DIAPUBG_CHROME ??
  (existsSync(installedChrome) ? installedChrome : undefined);
const deployedUrl = process.env.DIAPUBG_TEST_URL || undefined;
const baseURL = deployedUrl ?? 'http://127.0.0.1:8788';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL,
    viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
  webServer: deployedUrl ? undefined : {
    command: 'vite build && wrangler dev --ip 127.0.0.1 --port 8788 --persist-to .wrangler/e2e',
    url: baseURL + '/api/status',
    timeout: 45_000,
  },
});
