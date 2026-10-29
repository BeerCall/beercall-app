import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { webkit } from 'playwright';

const resultsDir = process.env.BEERCALL_USAGE_RESULTS;
if (!resultsDir) {
  throw new Error('BEERCALL_USAGE_RESULTS doit être défini vers un répertoire de résultats temporaire.');
}

const repoRoot = resolve(__dirname, '../..');
const workspaceFrontend = process.env.BEERCALL_WORKSPACE_FRONTEND ?? resolve(repoRoot, 'beercall-frontend');
const workspaceBackend = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(repoRoot, 'beercall-backend');
process.env.BEERCALL_WORKSPACE_FRONTEND = workspaceFrontend;
process.env.BEERCALL_WORKSPACE_BACKEND = workspaceBackend;

// Contrôle explicite de la disponibilité du navigateur WebKit
try {
  const executable = webkit.executablePath();
  if (!existsSync(executable)) {
    console.warn(`[mobile-runner] AVERTISSEMENT : L'exécutable WebKit n'est pas installé à ${executable}. Exécutez "npx playwright install webkit" pour l'installer.`);
  }
} catch {
  console.warn('[mobile-runner] AVERTISSEMENT : Impossible de vérifier l\'exécutable WebKit.');
}

export default defineConfig({
  testDir: './tests',
  testMatch: /ux-(pwa|mobile-shell|avatar-framing)\.spec\.ts/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: resolve(resultsDir, 'test-results-mobile'),
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    // Heure locale déterministe : les contrats de palette jour/nuit ne doivent
    // pas dépendre du fuseau de la machine qui exécute le runner mobile.
    timezoneId: 'Europe/Paris',
  },
  projects: [
    {
      name: 'chromium-mobile-390',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'block',
      },
    },
    {
      name: 'chromium-mobile-320',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 320, height: 568 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'block',
      },
    },
    {
      name: 'webkit-mobile-390',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'block',
      },
    },
    {
      name: 'webkit-mobile-320',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 320, height: 568 },
        hasTouch: true,
        isMobile: true,
        serviceWorkers: 'block',
      },
    },
  ],
});
