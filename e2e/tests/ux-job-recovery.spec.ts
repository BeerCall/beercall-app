import { test, expect } from '@playwright/test';
import { installUxFixtures } from './support/uxFixtures';

declare global {
  interface Window {
    uxJobDeadlineDelays: number[];
    uxJobGpsWatches: { success: PositionCallback; error?: PositionErrorCallback | null }[];
    uxJobPhotoClicks: number;
  }
}

test.use({ viewport: { width: 390, height: 844 }, trace: 'off' });

const SUBMISSION_STAGES = /^(ANALYSE IA EN COURS|PRÉPARATION DE LA PHOTO|ENVOI DE LA PHOTO|PHOTO EN ATTENTE DE VÉRIFICATION|VÉRIFICATION DE LA PHOTO)(\.\.\.|…)$/;

for (const activation of ['touch', 'keyboard'] as const) {
  test(`reprend le même job après suspension (${activation}), sans nouvelle soumission`, async ({ context, page }) => {
    const jobId = 'ux_job_recovery';
    const submitted: { key: string | undefined; body: string }[] = [];
    const results: string[] = [];
    let recovered = false;
    const isolation = await installUxFixtures(context, {
      simulations: [
        {
          method: 'POST', path: '/api/squads/900001/beer-calls',
          respond: async route => {
            submitted.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataBuffer()?.toString('utf8') ?? '' });
            await route.fulfill({ status: 202, json: { job_id: jobId } });
          },
        },
        {
          method: 'GET', path: `/api/squads/900001/beer-calls/jobs/${jobId}`,
          respond: async route => {
            const status = recovered ? 'succeeded' : 'pending';
            results.push(status);
            await route.fulfill({ json: { id: jobId, status } });
          },
        },
      ],
    });
    await context.addInitScript(() => {
      // 8080 = stack Docker E2E (CI), 4173 = preview Vite local (playwright.ux.config.ts).
      if (!['8080', '4173'].includes(window.location.port)) return;
      // Accelerate only the job's 20-minute deadline. Leave Date, performance,
      // requestAnimationFrame, polling and all other timers native: a global clock
      // jump leaves Framer Motion's exiting sheet attached and spoils the recipe.
      const browserWindow: Window = window;
      const nativeTimeout = browserWindow.setTimeout.bind(browserWindow);
      window.uxJobDeadlineDelays = [];
      browserWindow.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 20 * 60 * 1000) {
          window.uxJobDeadlineDelays.push(delay);
          return nativeTimeout(handler, 5000, ...args);
        }
        return nativeTimeout(handler, delay, ...args);
      };
      localStorage.setItem('beercall-location-storage', JSON.stringify({
        state: { userLocation: { lat: 48.8566, lng: 2.34 } }, version: 0,
      }));
      window.uxJobPhotoClicks = 0;
      document.addEventListener('click', event => {
        if (event.target instanceof HTMLInputElement && event.target.type === 'file') window.uxJobPhotoClicks++;
      }, true);
      window.uxJobGpsWatches = [];
      const denied: GeolocationPositionError = {
        code: 1, message: 'GPS refusé dans la fixture', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
      };
      const geolocation: Geolocation = {
        getCurrentPosition: (_success, error) => { error?.(denied); },
        watchPosition: (success, error) => {
          window.uxJobGpsWatches.push({ success, error });
          error?.(denied);
          return window.uxJobGpsWatches.length;
        },
        clearWatch: () => {},
      };
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: geolocation });
    });
    await page.goto('/squad/900001');
    const cached = page.getByRole('button', { name: 'Position mémorisée — création indisponible', exact: true });
    await expect(cached).toHaveAttribute('aria-disabled', 'true');
    const rect = await cached.boundingBox();
    expect(rect).not.toBeNull();
    expect(await cached.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), 'Le tap vise réellement le marqueur, sans force').toBe(true);
    await page.touchscreen.tap(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await cached.focus();
    await cached.press('Enter');
    await cached.press('Space');
    expect(await page.evaluate(() => window.uxJobPhotoClicks)).toBe(0);
    await expect(page.getByText(/Position mémorisée — ancienneté inconnue/).last()).toBeVisible();

    await page.getByRole('button', { name: 'Réessayer le GPS', exact: true }).tap();
    await page.evaluate(() => window.uxJobGpsWatches.at(-1)!.success({
      coords: { latitude: 48.8566, longitude: 2.34, accuracy: 1, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    } as GeolocationPosition));
    const current = page.getByRole('button', { name: 'Créer un Beer Call', exact: true });
    await expect(current).toHaveAttribute('aria-disabled', 'false');
    const chooser = page.waitForEvent('filechooser');
    await current.focus();
    await current.press('Enter');
    const fileChooser = await chooser;
    expect(await page.evaluate(() => window.uxJobPhotoClicks)).toBe(1);
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Image de fixture indisponible');
      ctx.fillRect(0, 0, 2, 2);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await fileChooser.setFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    const heading = page.getByRole('heading', { name: "Valider l'Apéro", exact: true });
    await expect(heading).toBeVisible();
    const locationInput = page.getByPlaceholder('Ex: Bar Le Central...', { exact: true });
    await locationInput.fill('Lieu fixture');
    await page.getByRole('button', { name: "LANCER L'APPEL", exact: true }).tap();
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0].key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(submitted[0].body).toContain('Lieu fixture');
    expect(submitted[0].body).toContain('48.8566');
    expect(submitted[0].body).toContain('2.34');
    await expect.poll(() => results.includes('pending')).toBe(true);
    const resume = page.getByRole('button', { name: 'Reprendre le suivi', exact: true });
    // The deadline is deliberately 5s; this is a local precondition wait, not a
    // larger global test timeout or a wait after tapping the recovery action.
    await expect(resume).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/son résultat reste inconnu/)).toBeVisible();
    await expect(locationInput).toHaveValue('Lieu fixture');
    await expect(page.getByRole('button', { name: SUBMISSION_STAGES })).toBeDisabled();
    expect(submitted).toHaveLength(1);
    expect(await page.evaluate(() => window.uxJobDeadlineDelays)).toEqual([20 * 60 * 1000]);
    recovered = true;
    if (activation === 'touch') await resume.tap();
    else { await resume.focus(); await resume.press('Enter'); }
    await expect.poll(() => results.includes('succeeded')).toBe(true);
    await expect(heading).toHaveCount(0);
    await expect(resume).toHaveCount(0);
    expect(submitted).toHaveLength(1);
    isolation.assertIsolated();
    console.log(JSON.stringify({ activation, jobId, simulatedPosts: submitted.length, results, closed: true }));
  });
}
