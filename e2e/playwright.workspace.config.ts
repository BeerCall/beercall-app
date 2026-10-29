import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const resultsDir = process.env.BEERCALL_USAGE_RESULTS;
if (!resultsDir) {
  throw new Error('BEERCALL_USAGE_RESULTS doit être défini vers un répertoire de résultats temporaire.');
}

const repoRoot = resolve(__dirname, '../..');
const workspaceFrontend = process.env.BEERCALL_WORKSPACE_FRONTEND ?? resolve(repoRoot, 'beercall-frontend');
const workspaceBackend = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(repoRoot, 'beercall-backend');
process.env.BEERCALL_WORKSPACE_FRONTEND = workspaceFrontend;
process.env.BEERCALL_WORKSPACE_BACKEND = workspaceBackend;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: resolve(resultsDir, 'test-results'),
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'integration',
      testIgnore: /ux-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'ux',
      testMatch: /ux-.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        hasTouch: true,
        serviceWorkers: 'block',
      },
    },
  ],
});
