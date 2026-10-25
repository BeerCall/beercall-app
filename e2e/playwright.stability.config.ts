import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const resultsDir = process.env.BEERCALL_USAGE_RESULTS ?? resolve(process.cwd(), 'test-results');

const repoRoot = resolve(__dirname, '../..');
const workspaceFrontend = process.env.BEERCALL_WORKSPACE_FRONTEND ?? resolve(repoRoot, 'beercall-frontend');
const workspaceBackend = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(repoRoot, 'beercall-backend');
process.env.BEERCALL_WORKSPACE_FRONTEND = workspaceFrontend;
process.env.BEERCALL_WORKSPACE_BACKEND = workspaceBackend;

export default defineConfig({
  testDir: './bench',
  testMatch: /three-stability\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: resolve(resultsDir, 'stability-results'),
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'stability',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
});
