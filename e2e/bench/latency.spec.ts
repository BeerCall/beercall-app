import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test.setTimeout(180_000);

const baseURL = 'http://127.0.0.1:8080';
const password = 'BeerCallE2E123!';
const unique = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Actor {
  context: BrowserContext;
  page: Page;
  username: string;
  token: string;
}

interface LatencyMeasurement {
  attempt: number;
  kind: 'drink' | 'no_drink';
  photoHash: string;
  jobId: string;
  verdict: string;
  clickToPostMs: number;
  postToAcceptedMs: number;
  acceptedToResultMs: number;
  totalDurationMs: number;
  timestampUtc: string;
}

function getPhoto(kind: 'drink' | 'no_drink'): { name: string; mimeType: string; buffer: Buffer; hash: string } {
  const envPath = kind === 'drink'
    ? process.env.BEERCALL_LATENCY_DRINK_PHOTO
    : process.env.BEERCALL_LATENCY_NO_DRINK_PHOTO;

  if (envPath && existsSync(envPath)) {
    const buffer = readFileSync(envPath);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const name = `${kind}.jpg`;
    return { name, mimeType: 'image/jpeg', buffer, hash };
  }

  // Fallback binaire PNG valide (1x1 pixel) si aucune photo externe n'est fournie
  const validPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const buffer = Buffer.from(validPngBase64, 'base64');
  const hash = createHash('sha256').update(buffer).digest('hex');
  return { name: `${kind}.png`, mimeType: 'image/png', buffer, hash };
}

async function registerActor(browser: Browser): Promise<Actor> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ['geolocation'],
  });

  const catalogue = await context.request.get('/api/auth/profile/');
  expect(catalogue.status()).toBe(200);
  const items = (await catalogue.json() as { shop_items: { id: string; category: string; gender: string }[] }).shop_items;
  const avatar: Record<string, string> = { gender: 'Men' };
  for (const category of ['head', 'body', 'legs', 'feet', 'accessory', 'animation']) {
    avatar[category] = items.find(item => item.category === category && ['Men', 'Unisex'].includes(item.gender) && item.id.endsWith('_0'))?.id ?? 'none';
  }
  avatar.accessory = 'none';
  avatar.animation = 'Idle';

  const username = unique();
  const registered = await context.request.post('/api/auth/signup/', { data: { username, password, avatar } });
  expect(registered.status()).toBe(200);
  const token = (await registered.json() as { access_token: string }).access_token;

  const page = await context.newPage();
  await page.goto('/login');
  await page.getByPlaceholder('Ton Pseudo', { exact: true }).fill(username);
  await page.getByPlaceholder('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'SE CONNECTER', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Attendre la carte utilisable avant toute mesure
  const mapContainer = page.locator('div.maplibregl-map, div[aria-label="Carte des apéros"]');
  await expect(mapContainer.first()).toBeVisible({ timeout: 10_000 });

  return { context, page, username, token };
}

test.describe('Banc de mesure de latence réelle (PERF-01 / T07a)', () => {
  test('mesure chronométrée de bout en bout clic -> 202 -> résultat', async ({ browser }) => {
    const resultsDir = process.env.BEERCALL_USAGE_RESULTS ?? resolve(process.cwd(), 'test-results');
    mkdirSync(resultsDir, { recursive: true });

    const runs: LatencyMeasurement[] = [];
    const kinds: Array<'drink' | 'no_drink'> = ['drink', 'no_drink'];

    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const photo = getPhoto(kind);
      const actor = await registerActor(browser);

      try {
        // Créer une squad neuve pour cet essai
        const squadName = `Squad Latency ${unique()}`;
        const createdSquad = await actor.context.request.post('/api/squads/', {
          headers: { Authorization: `Bearer ${actor.token}` },
          data: { name: squadName, icon: 'beer', color: '#F59E0B' },
        });
        expect(createdSquad.status()).toBe(200);
        const squad = await createdSquad.json() as { id: number };

        // Aller sur la squad
        await actor.page.goto(`/squad/${squad.id}`);
        const squadHeading = actor.page.getByRole('heading', { name: squadName, exact: true });
        await expect(squadHeading).toBeVisible({ timeout: 15_000 });
        // Clic sur l'en-tête pour déclencher la première interaction utilisateur qui démarre le GPS (watchPosition)
        await squadHeading.click();

        // Attendre que le marqueur joueur « Créer un Beer Call » soit actif (position GPS fixée)
        const createButton = actor.page.getByRole('button', { name: 'Créer un Beer Call', exact: true });
        await expect(createButton).toBeVisible({ timeout: 15_000 });

        // Préparer le fichier photo
        const fileChooserPromise = actor.page.waitForEvent('filechooser');
        await createButton.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
          name: photo.name,
          mimeType: photo.mimeType,
          buffer: photo.buffer,
        });

        const locationName = `Bar ${unique()}`;
        await actor.page.getByPlaceholder('Ex: Bar Le Central...').fill(locationName);

        // Promesses de chronométrage
        let tPostSent = 0;
        let tPostReceived = 0;
        let tCompleted = 0;

        const acceptedPromise = actor.page.waitForResponse(response => {
          if (response.url().endsWith(`/api/squads/${squad.id}/beer-calls/`) && response.request().method() === 'POST') {
            tPostSent = performance.now();
            return true;
          }
          return false;
        });

        const terminalPromise = actor.page.waitForResponse(async response => {
          if (response.url().includes(`/api/squads/${squad.id}/beer-calls/jobs/`) && response.status() === 200) {
            try {
              const body = await response.json() as { status: string };
              if (body.status === 'succeeded' || body.status === 'rejected' || body.status === 'failed') {
                tCompleted = performance.now();
                return true;
              }
            } catch {
              return false;
            }
          }
          return false;
        });

        // Début chronométrage clic
        const tClick = performance.now();
        await actor.page.getByRole('button', { name: "LANCER L'APPEL", exact: true }).click();

        const acceptedResponse = await acceptedPromise;
        tPostReceived = performance.now();
        expect(acceptedResponse.status()).toBe(202);
        const jobData = await acceptedResponse.json() as { job_id: string; status: string };

        const terminalResponse = await terminalPromise;
        const terminalData = await terminalResponse.json() as { id: string; status: string };

        const measurement: LatencyMeasurement = {
          attempt: i + 1,
          kind,
          photoHash: photo.hash,
          jobId: jobData.job_id,
          verdict: terminalData.status,
          clickToPostMs: Math.round(tPostSent - tClick),
          postToAcceptedMs: Math.round(tPostReceived - tPostSent),
          acceptedToResultMs: Math.round(tCompleted - tPostReceived),
          totalDurationMs: Math.round(tCompleted - tClick),
          timestampUtc: new Date().toISOString(),
        };

        runs.push(measurement);
        console.log(`[T07a Latence] Essai ${i + 1} (${kind}): Total=${measurement.totalDurationMs}ms, Post202=${measurement.postToAcceptedMs}ms, JobAI=${measurement.acceptedToResultMs}ms, Verdict=${measurement.verdict}`);
      } finally {
        await actor.context.close();
      }
    }

    const outputPath = resolve(resultsDir, 'latency-runs.json');
    writeFileSync(outputPath, JSON.stringify({ runs }, null, 2), 'utf-8');
    console.log(`[T07a Latence] Données de banc enregistrées sous ${outputPath}`);
  });
});
