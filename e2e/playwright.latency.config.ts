import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { defineConfig, devices } from '@playwright/test';

// Ce répertoire est celui du runner (contrôles/collecte), pas un fallback de
// mesures. Le spec exige BEERCALL_USAGE_RESULTS avant tout essai réel.
const runnerOutput = resolve(homedir(), 'AppData/Local/Temp/opencode/latency-runner-output');

const repoRoot = resolve(__dirname, '../..');
const workspaceFrontend = process.env.BEERCALL_WORKSPACE_FRONTEND ?? resolve(repoRoot, '../beercall-frontend');
const workspaceBackend = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(repoRoot, '../beercall-backend');
process.env.BEERCALL_WORKSPACE_FRONTEND = workspaceFrontend;
process.env.BEERCALL_WORKSPACE_BACKEND = workspaceBackend;

export default defineConfig({
  testDir: './bench',
  testMatch: /latency\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: runnerOutput,
  preserveOutput: 'never',
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'latency',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
});
