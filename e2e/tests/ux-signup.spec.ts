import { test, expect, type Locator } from '@playwright/test';
import { fixtureCatalogue, installUxFixtures } from './support/uxFixtures';

// Avoid tracing every WebGL frame; all DOM, payload and isolation assertions remain active.
test.use({ trace: 'off' });

async function assertInViewportAndTappable(button: Locator, height: number) {
  const measured = await button.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      tappable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
  });
  expect(measured.width).toBeGreaterThan(0);
  expect(measured.height).toBeGreaterThan(0);
  expect(measured.top).toBeGreaterThanOrEqual(0);
  expect(measured.bottom).toBeLessThanOrEqual(height);
  expect(measured.tappable).toBe(true);
}

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
  for (const catalogue of ['ready', 'delayed', 'error'] as const) {
    test(`inscription par défaut, reprise POST et catalogue ${catalogue} à ${viewport.width}`, async ({ context, page }) => {
      await page.setViewportSize(viewport);
      const payloads: unknown[] = [];
      let catalogueRecovered = false;
      let releaseCatalogue: () => void = () => {};
      const catalogueObserved = new Promise<void>(resolve => { releaseCatalogue = resolve; });
      const isolation = await installUxFixtures(context, {
        authenticated: false, assets: true, catalogue,
        simulations: [
          ...(catalogue === 'delayed' ? [{
            method: 'GET' as const, path: '/api/auth/profile',
            respond: async (route: import('@playwright/test').Route) => {
              await Promise.all([catalogueObserved, new Promise(resolve => setTimeout(resolve, 4000))]);
              await route.fulfill({ json: { shop_items: fixtureCatalogue } });
            },
          }] : []),
          ...(catalogue === 'error' ? [{
            method: 'GET' as const, path: '/api/auth/profile',
            respond: async (route: import('@playwright/test').Route) => {
              await route.fulfill({ status: catalogueRecovered ? 200 : 500,
                json: catalogueRecovered ? { shop_items: fixtureCatalogue } : { detail: 'Catalogue en panne' } });
            },
          }] : []),
          {
            method: 'POST', path: '/api/auth/signup',
            respond: async route => {
              payloads.push(route.request().postDataJSON() as unknown);
              await route.fulfill({ status: payloads.length === 1 ? 500 : 200,
                json: payloads.length === 1 ? { detail: 'Panne simulée, réessaie' }
                  : { access_token: 'signup-fixture-token', refresh_token: 'signup-fixture-refresh-token', username: 'FixtureUser' } });
            },
          },
        ],
      });
      const readyResponse = catalogue === 'ready'
        ? page.waitForResponse(response => response.url().includes('/api/auth/profile') && response.status() === 200)
        : undefined;
      await page.goto('/signup');
      if (catalogue === 'ready') {
        await expect.poll(() => page.getByRole('button', { name: /mon compte/ }).count()).toBe(0);
        await readyResponse;
      }
      await page.getByPlaceholder('Pseudo', { exact: true }).fill('FixtureUser');
      await page.getByPlaceholder('Mot de passe', { exact: true }).fill('Fixture123');
      await page.getByRole('button', { name: "CRÉER L'AVATAR" }).tap();
      const button = page.getByRole('button', { name: 'Créer mon compte', exact: true });
      await expect(button).toBeVisible();
      await assertInViewportAndTappable(button, viewport.height);
      if (catalogue === 'delayed') {
        await expect(button).toBeDisabled();
        await expect(page.getByRole('status')).toHaveText('Chargement du catalogue…');
        releaseCatalogue();
      }
      if (catalogue === 'error') {
        await expect(page.getByRole('alert')).toContainText('Catalogue indisponible', { timeout: 15_000 });
        await expect(button).toBeDisabled();
        catalogueRecovered = true;
        await page.getByRole('button', { name: 'Réessayer', exact: true }).tap();
      }
      await expect(button).toBeEnabled();
      await expect(page.getByText('Essayage — seule la tenue choisie est offerte à la création du compte', { exact: true })).toBeVisible();
      await expect(page.getByText('Tenue initiale', { exact: true })).toBeVisible();
      await expect(page.getByText('Possédé', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /ACHETER|SAUVEGARDER/ })).toHaveCount(0);
      const last = page.getByText('À essayer', { exact: true });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      expect(await last.evaluate(el => {
        const action = document.querySelector('footer button:last-child');
        return !!action && el.getBoundingClientRect().bottom < action.getBoundingClientRect().top;
      })).toBe(true);
      await expect.poll(() => isolation.assetHits.fbx).toBeGreaterThan(0);
      await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
      await assertInViewportAndTappable(button, viewport.height);
      await button.tap();
      await expect(page.getByRole('alert')).toHaveText('Panne simulée, réessaie');
      await expect(button).toBeEnabled();
      await expect(page).toHaveURL('/signup');
      await assertInViewportAndTappable(button, viewport.height);
      await button.tap();
      await expect(page).toHaveURL('/dashboard');
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toEqual(payloads[0]);
      expect(payloads[0]).toEqual({ username: 'FixtureUser', password: 'Fixture123', avatar: {
        head: 'none', body: 'none', legs: 'none', feet: 'none', accessory: 'none', animation: 'none', gender: 'Men',
      } });
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('signup-fixture-token');
      isolation.assertAssets();
      isolation.assertIsolated();
    });
  }
}
