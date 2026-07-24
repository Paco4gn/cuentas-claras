import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: true,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5178/cuentas-claras/',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 14'],
        browserName: 'chromium',
      },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5178',
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:5178/cuentas-claras/',
    timeout: 120_000,
  },
})
