import { test, expect } from '@playwright/test';
import { installUxFixtures } from '../tests/support/uxFixtures';

const PHASE = process.env.BEERCALL_STABILITY_PHASE ?? 'baseline';

const MOCK_CONNECTIONS = Array.from({ length: 30 }, (_, i) => ({
  id: `conn_${i + 1}`,
  username: `Camarade_${i + 1}`,
  caps: (i + 1) * 10,
  score: (i + 1) * 100,
  title: i % 2 === 0 ? 'Vétéran du Bar' : 'Novice de l’Apéro',
  avatar: {
    head: 'head_base',
    body: i % 3 === 0 ? 'tshirt' : 'suit',
    legs: i % 2 === 0 ? 'jeans' : 'shorts',
    feet: 'shoes_sneakers',
    accessory: i % 5 === 0 ? 'glasses_round' : 'none',
    gender: (i % 2 === 0 ? 'Men' : 'Women') as 'Men' | 'Women',
  },
}));

test.describe('Stabilité 3D - Navigation répétée 30 amis / Carte (REL-01)', () => {
  test('reproduction et diagnostic de stabilité sur 40 cycles', async ({ context, page }) => {
    test.setTimeout(300_000);

    const pageErrors: string[] = [];
    const webglWarnings: string[] = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('WARNING: Too many active WebGL contexts') || text.includes('CONTEXT_LOST_WEBGL')) {
        webglWarnings.push(text);
      }
    });

    await page.addInitScript(() => {
      window.__stabilityMetrics = {
        contextsCreated: 0,
        contextsLost: 0,
        contextsRestored: 0,
        activeCanvases: 0,
      };

      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type: string, ...args: any[]) {
        const ctx = origGetContext.call(this, type, ...args);
        if (ctx && (type === 'webgl' || type === 'webgl2')) {
          window.__stabilityMetrics.contextsCreated++;
          this.addEventListener('webglcontextlost', () => {
            window.__stabilityMetrics.contextsLost++;
          });
          this.addEventListener('webglcontextrestored', () => {
            window.__stabilityMetrics.contextsRestored++;
          });
        }
        return ctx;
      } as any;
    });

    await installUxFixtures(context, {
      profileMode: 'own',
      assets: true,
      simulations: [
        {
          method: 'GET',
          path: '/api/auth/connections/',
          respond: async route => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(MOCK_CONNECTIONS),
            });
          },
        },
      ],
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const cycleCount = PHASE === 'verify' ? 40 : 20;
    const history: Array<{ cycle: number; contextsCreated: number; contextsLost: number }> = [];

    for (let c = 1; c <= cycleCount; c++) {
      // Aller sur Connexions
      await page.goto('/connections');
      await page.waitForLoadState('domcontentloaded');

      const list = page.locator('div.flex-1.overflow-y-auto');
      if (await list.isVisible()) {
        // Scroll jusqu'en bas
        await list.evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
        await page.waitForTimeout(50);
        // Remonter en haut
        await list.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
        await page.waitForTimeout(50);
      }

      // Retour carte
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      const metrics = await page.evaluate(() => window.__stabilityMetrics ?? { contextsCreated: 0, contextsLost: 0 });
      history.push({ cycle: c, contextsCreated: metrics.contextsCreated, contextsLost: metrics.contextsLost });

      // En mode verify, chaque cycle exige zéro crash et zéro écran blanc
      if (PHASE === 'verify') {
        expect(pageErrors.length, `Aucun crash JS au cycle ${c}: ${pageErrors.join('; ')}`).toBe(0);
        const mapContainer = page.locator('div.maplibregl-map, div[aria-label="Carte des apéros"]');
        await expect(mapContainer.first()).toBeVisible({ timeout: 5000 });
      }
    }

    // Sortie diagnostique
    console.log(`[T14a Diagnostic] Phase=${PHASE}, Cycles=${cycleCount}`);
    console.log(`[T14a Diagnostic] Total contextes créés: ${history.at(-1)?.contextsCreated}`);
    console.log(`[T14a Diagnostic] Total contextes perdus: ${history.at(-1)?.contextsLost}`);
    console.log(`[T14a Diagnostic] Warnings WebGL: ${webglWarnings.length}`);
    console.log(`[T14a Diagnostic] Erreurs JS: ${pageErrors.length}`);

    if (PHASE === 'verify') {
      expect(pageErrors).toHaveLength(0);
    }
  });
});

declare global {
  interface Window {
    __stabilityMetrics: {
      contextsCreated: number;
      contextsLost: number;
      contextsRestored: number;
      activeCanvases: number;
    };
  }
}
