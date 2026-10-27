import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  assertBoundedGrowth,
  assertContextAccounting,
  assertContextInventory,
  assertFrameProgress,
  assertFrames,
  assertModelWhitelist,
  assertSingleDocument,
  installStabilityFixtures,
} from './support/stabilityFixtures';
import {
  assertCleanTeardown,
  getStabilitySnapshot,
  installStabilityMetrics,
  teardownStabilityMetrics,
} from './support/stabilityMetrics';

const PHASE = process.env.BEERCALL_STABILITY_PHASE === 'verify' ? 'verify' : 'baseline';
const TOTAL_CYCLES = Number(process.env.BEERCALL_STABILITY_CYCLES ?? 40);
const WARMUP_CYCLES = Math.min(10, TOTAL_CYCLES - 1);
const resultsDir = process.env.BEERCALL_USAGE_RESULTS ?? resolve(process.cwd(), 'test-results');

async function waitForDashboard(page: Page) {
  const mapCanvas = page.locator('div.maplibregl-map canvas.maplibregl-canvas').first();
  await expect(mapCanvas).toBeVisible({ timeout: 45_000 });
  await mapCanvas.evaluate((canvas) => canvas.setAttribute('data-stability-map', 'map-1'));
  await expect.poll(
    () => mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws(canvas)),
    { timeout: 30_000, message: 'La carte doit soumettre au moins une frame WebGL' },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => page.evaluate(() => Boolean(window.__beercall_scene_metrics?.avatarFrameSubmitted)),
    { timeout: 30_000, message: 'Le joueur doit soumettre une frame réelle' },
  ).toBe(true);
  return mapCanvas;
}

async function openConnections(page: Page) {
  await page.getByRole('button', { name: 'Connexions' }).click();
  await expect(page.getByRole('heading', { name: 'Connexions' })).toBeVisible({ timeout: 15_000 });
  const list = page.locator('div.flex-1.overflow-y-auto').first();
  await expect(list).toBeVisible();
  return list;
}

async function backToDashboard(page: Page) {
  await page.locator('header button').first().click();
  await expect(page.locator('div.maplibregl-map')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('canvas[data-stability-map="map-1"]')).toHaveCount(1);
}

test.describe('Stabilité 3D réelle — 30 connexions et carte retenue (T20/REL-01)', () => {
  test('banc SPA 40 cycles sans rechargement de document', async ({ context, page }) => {
    test.setTimeout(900_000);
    await installStabilityMetrics(page);

    try {
      const webglWarnings: string[] = [];
      const documentRequests: string[] = [];
      page.on('console', (message) => {
        const text = message.text();
        if (text.includes('WARNING: Too many active WebGL contexts') || text.includes('CONTEXT_LOST_WEBGL')) {
          webglWarnings.push(text);
        }
      });
      page.on('request', (request) => {
        if (request.resourceType() === 'document') documentRequests.push(request.url());
      });
      let currentCycle = 0;
      page.on('pageerror', (error) => console.log(`[T20 pageerror cycle ${currentCycle}]`, error.stack ?? error.message));

      const fixture = await installStabilityFixtures(context);
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      const mapCanvas = await waitForDashboard(page);

      const history: Array<{
        cycle: number;
        contextsCreated: number;
        contextsLost: number;
        contextsRestored: number;
        drawCalls: number;
        mapDraws: number;
        thumbnailDraws: number;
        backgroundReturn: boolean;
      }> = [];

      for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
        currentCycle = cycle;
        const varied = cycle > 20;
        const isFast = varied && cycle <= 25;
        await openConnections(page);
        const thumbnails = page.locator('[data-testid^="avatar-thumb-"]');
        await expect(thumbnails).toHaveCount(30, { timeout: 15_000 });

        const index = varied ? 10 + ((cycle - 21) % 20) : 0;
        const item = thumbnails.nth(index);
        await item.scrollIntoViewIfNeeded();
        await expect(item).toBeVisible();
        // Laisse le budget de miniatures se stabiliser avant de mesurer les Canvas.
        await page.waitForTimeout(500);

        const readyThumbnail = page.locator('[data-avatar-framing="ready"] canvas').first();
        await expect(readyThumbnail).toBeVisible({ timeout: isFast ? 15_000 : 30_000 });
        await expect.poll(
          () => page.locator('[data-avatar-framing="loading"]').count(),
          { timeout: 15_000, message: 'Aucun Canvas de miniature encore en cours de connexion' },
        ).toBe(0);
        const thumbnailDraws = await readyThumbnail.evaluate((canvas) => window.__stabilityCanvasDraws?.(canvas) ?? 0);
        assertFrames(thumbnailDraws, `Miniature cycle ${cycle}`);
        // Laisse le Canvas R3F terminer son effet de connexion avant le démontage SPA.
        await page.waitForTimeout(isFast ? 120 : 300);

        let backgroundReturn = false;
        if (cycle === 30) {
          backgroundReturn = Boolean(await page.evaluate(() => window.__stabilitySetDocumentHidden?.(true)));
          await page.waitForTimeout(250);
          backgroundReturn = Boolean(await page.evaluate(() => window.__stabilitySetDocumentHidden?.(false))) && backgroundReturn;
          await page.waitForTimeout(250);
        }

        await backToDashboard(page);
        const mapDraws = await mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws?.(canvas) ?? 0);
        assertFrames(mapDraws, `Carte cycle ${cycle}`);
        const metrics = await page.evaluate(() => window.__stabilityMetrics ?? {
          contextsCreated: 0,
          contextsLost: 0,
          contextsRestored: 0,
          drawCalls: 0,
          activeContexts: 0,
        });

        history.push({
          cycle,
          contextsCreated: metrics.contextsCreated,
          contextsLost: metrics.contextsLost,
          contextsRestored: metrics.contextsRestored,
          drawCalls: metrics.drawCalls,
          mapDraws,
          thumbnailDraws,
          backgroundReturn,
        });
      }

      await fixture.assertModels();
      fixture.isolation.assertIsolated();
      assertSingleDocument(documentRequests);
      expect(documentRequests, 'Un seul document, aucune navigation complète').toHaveLength(1);
      expect(webglWarnings, 'Aucun warning de quota WebGL').toEqual([]);
      const afterWarmup = history[WARMUP_CYCLES - 1].contextsCreated;
      const finalMetrics = await page.evaluate(() => window.__stabilityMetrics ?? {
        contextsCreated: 0,
        contextsLost: 0,
        contextsRestored: 0,
        drawCalls: 0,
        activeContexts: 0,
      });
      const activeContexts = finalMetrics.activeContexts ?? (finalMetrics.contextsCreated - finalMetrics.contextsLost);

      const summary = {
        phase: PHASE,
        cycles: TOTAL_CYCLES,
        warmupCycles: WARMUP_CYCLES,
        finalMetrics,
        activeContexts,
        afterWarmupContexts: afterWarmup,
        documentRequests,
        webglWarnings,
        pageErrors: fixture.isolation.pageErrors,
        modelHits: Object.fromEntries(fixture.modelHits),
        history,
      };
      const output = resolve(resultsDir, `stability-${PHASE}.json`);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(summary, null, 2));

      assertBoundedGrowth(afterWarmup, finalMetrics.contextsCreated, TOTAL_CYCLES - WARMUP_CYCLES);
      expect(activeContexts, 'Contextes WebGL actifs bornés après échauffement').toBeLessThanOrEqual(4);

      if (PHASE === 'verify') {
        expect(webglWarnings).toHaveLength(0);
        expect(fixture.isolation.pageErrors).toHaveLength(0);
        expect(history.every((entry) => entry.mapDraws > 0)).toBe(true);
        expect(history.every((entry) => entry.thumbnailDraws > 0)).toBe(true);
        let baseline: { finalMetrics?: { contextsCreated?: number }; history?: unknown[] } | null = null;
        try {
          baseline = JSON.parse(await readFile(resolve(resultsDir, 'stability-baseline.json'), 'utf8'));
        } catch {
          baseline = null;
        }
        if (baseline?.finalMetrics?.contextsCreated !== undefined) {
          console.log(
            `[T20] baseline contextes=${baseline.finalMetrics.contextsCreated}, verify=${finalMetrics.contextsCreated}`,
          );
        } else {
          console.log('[T20] baseline absente ou non comparable : vérification sur image courante seulement');
        }
      }
    } finally {
      await teardownStabilityMetrics(page);
    }
  });

  test('perte/restauration volontaire du contexte 3D si WEBGL_lose_context existe', async ({ context, page }) => {
    test.setTimeout(120_000);
    await installStabilityMetrics(page);

    try {
      const fixture = await installStabilityFixtures(context);
      await page.goto('/profile');
      await page.waitForLoadState('domcontentloaded');

      const avatarCanvas = page.locator('div[data-testid="safe-avatar-container"] canvas').first();
      await expect(avatarCanvas).toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => avatarCanvas.evaluate((canvas) => window.__stabilityCanvasDraws?.(canvas) ?? 0),
        { timeout: 30_000 },
      ).toBeGreaterThan(0);

      const result = await page.evaluate(async () => {
        const canvas = document.querySelector('div[data-testid="safe-avatar-container"] canvas') as HTMLCanvasElement | null;
        if (!canvas) return { available: false, reason: 'no canvas' };
        const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
        if (!gl) return { available: false, reason: 'no webgl context' };
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) return { available: false, reason: 'extension not supported' };
        const before = window.__stabilityMetrics;
        const lostBefore = before?.contextsLost ?? 0;
        const restoredBefore = before?.contextsRestored ?? 0;
        extension.loseContext();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        extension.restoreContext();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
        return {
          available: true,
          lost: (window.__stabilityMetrics?.contextsLost ?? 0) - lostBefore,
          restored: (window.__stabilityMetrics?.contextsRestored ?? 0) - restoredBefore,
        };
      });

      if (!result.available) {
        test.info().annotations.push({ type: 'non mesuré', description: result.reason });
        console.log(`[T20 WEBGL_lose_context] non mesuré : ${result.reason}`);
      } else {
        expect(result.lost).toBeGreaterThan(0);
        expect(result.restored).toBeGreaterThan(0);
        await expect(page.locator('div[data-testid="safe-avatar-container"] canvas')).toHaveCount(1);
        await expect.poll(
          () => avatarCanvas.evaluate((canvas) => window.__stabilityCanvasDraws?.(canvas) ?? 0),
          { timeout: 15_000 },
        ).toBeGreaterThan(0);
      }
      await fixture.assertModels();
    } finally {
      await teardownStabilityMetrics(page);
    }
  });

  test('contrôles négatifs du harnais et cycle de vie des contextes', async ({ page }) => {
    // 1. Modèles : 0 modèle (vide) et modèle inconnu
    expect(() => assertModelWhitelist(new Set(['a.fbx']), [])).toThrow(/vide/);
    expect(() => assertModelWhitelist(new Set(['a.fbx']), ['b.fbx'])).toThrow(/hors whitelist/);
    expect(() => assertModelWhitelist(new Set(['a.fbx']), ['a.fbx'])).not.toThrow();

    // 2. Progression des frames : frame figée positive et régression refusées
    expect(() => assertFrames(0, 'contrôle')).toThrow(/aucune frame/);
    expect(() => assertFrames(1, 'contrôle')).not.toThrow();
    expect(() => assertFrameProgress(10, 10, 'frame figée')).toThrow(/progression/);
    expect(() => assertFrameProgress(10, 5, 'frame régressive')).toThrow(/progression/);
    expect(() => assertFrameProgress(10, 11, 'progression valide')).not.toThrow();

    // 3. Document unique : reload refusé
    expect(() => assertSingleDocument(['/', '/'])).toThrow(/rechargé/);
    expect(() => assertSingleDocument(['/'])).not.toThrow();

    // 4. Contexte doublé / restauré mal compté
    // Formule naïve created - lost avec restaurations
    expect(() => assertContextAccounting({
      contextsCreated: 1,
      contextsLost: 1,
      contextsRestored: 1,
      activeContexts: 0,
    })).toThrow(/formule naïve/);
    // Identifiant dupliqué lors d'une restauration
    expect(() => assertContextAccounting({
      contextsCreated: 2,
      contextsLost: 1,
      contextsRestored: 1,
      activeContexts: 1,
      contexts: [
        { id: 'ctx_1', status: 'lost' },
        { id: 'ctx_1', status: 'restored' },
      ],
    })).toThrow(/doublé/);
    // Incohérence activeContexts vs états réels
    expect(() => assertContextAccounting({
      contextsCreated: 1,
      contextsLost: 0,
      contextsRestored: 0,
      activeContexts: 2,
      contexts: [{ id: 'ctx_1', status: 'live' }],
    })).toThrow(/incohérent/);
    // Comptage valide
    expect(() => assertContextAccounting({
      contextsCreated: 1,
      contextsLost: 1,
      contextsRestored: 1,
      activeContexts: 1,
      contexts: [{ id: 'ctx_1', status: 'restored' }],
    })).not.toThrow();

    // 5. Inventaire : plafond par checkpoint et inventaire croissant avec chute finale
    expect(() => assertContextInventory([1, 2, 3, 4, 1])).toThrow(/chute finale/);
    expect(() => assertContextInventory([2, 3, 5, 2])).toThrow(/dépasse le plafond/);
    expect(() => assertContextInventory([])).toThrow(/vide/);
    expect(() => assertContextInventory([2, 2, 3, 2, 2])).not.toThrow();

    // 6. Croissance bornée (T20)
    expect(() => assertBoundedGrowth(0, 1_000, 10)).toThrow(/non bornée/);
    expect(() => assertBoundedGrowth(0, 10, 10)).not.toThrow();

    // 7. Teardown qui laisse un patch
    await page.goto('about:blank');
    await page.evaluate(() => {
      (window as unknown as { __stabilityMetrics: unknown }).__stabilityMetrics = {
        contextsCreated: 1,
        contextsLost: 0,
        contextsRestored: 0,
        drawCalls: 0,
        activeContexts: 1,
      };
    });
    await expect(assertCleanTeardown(page)).rejects.toThrow(/Teardown qui laisse un patch/);
    await page.evaluate(() => {
      delete (window as unknown as { __stabilityMetrics?: unknown }).__stabilityMetrics;
    });
    await assertCleanTeardown(page);

    // 8. Cas positif création/perte/restauration du même objet contexte
    await installStabilityMetrics(page);
    await page.goto('about:blank');

    const lifecycle = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      document.body.appendChild(canvas);

      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as (WebGLRenderingContext | WebGL2RenderingContext | null);
      if (!gl) return { supported: false, reason: 'WebGL non supporté' };

      const snap1 = window.__getStabilitySnapshot!();
      const initialId = snap1.contexts[0]?.id;
      const initialStatus = snap1.contexts[0]?.status;
      const initialActive = snap1.activeContexts;

      // Draw call
      try { gl.drawArrays(gl.POINTS, 0, 1); } catch (_) {}
      const snapAfterDraw = window.__getStabilitySnapshot!();
      const drawsAfterDraw = snapAfterDraw.drawCalls;

      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) return { supported: false, reason: 'WEBGL_lose_context non supporté' };

      canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
      ext.loseContext();
      await new Promise(r => setTimeout(r, 60));

      const snap2 = window.__getStabilitySnapshot!();
      const lostId = snap2.contexts[0]?.id;
      const lostStatus = snap2.contexts[0]?.status;
      const lostActive = snap2.activeContexts;

      ext.restoreContext();
      await new Promise(r => setTimeout(r, 60));

      const snap3 = window.__getStabilitySnapshot!();
      const restoredId = snap3.contexts[0]?.id;
      const restoredStatus = snap3.contexts[0]?.status;
      const restoredActive = snap3.activeContexts;

      try { gl.drawArrays(gl.POINTS, 0, 1); } catch (_) {}
      const snapFinal = window.__getStabilitySnapshot!();

      canvas.remove();

      return {
        supported: true,
        initialId,
        initialStatus,
        initialActive,
        drawsAfterDraw,
        lostId,
        lostStatus,
        lostActive,
        restoredId,
        restoredStatus,
        restoredActive,
        finalDraws: snapFinal.drawCalls,
        totalCreated: snapFinal.contextsCreated,
      };
    });

    if (lifecycle.supported) {
      expect(lifecycle.initialId).toBeDefined();
      expect(lifecycle.lostId).toBe(lifecycle.initialId);
      expect(lifecycle.restoredId).toBe(lifecycle.initialId);

      expect(lifecycle.initialStatus).toBe('live');
      expect(lifecycle.lostStatus).toBe('lost');
      expect(lifecycle.restoredStatus).toBe('restored');

      expect(lifecycle.initialActive).toBe(1);
      expect(lifecycle.lostActive).toBe(0);
      expect(lifecycle.restoredActive).toBe(1);

      expect(lifecycle.totalCreated).toBe(1);
      expect(lifecycle.drawsAfterDraw).toBeGreaterThanOrEqual(1);
      expect(lifecycle.finalDraws).toBeGreaterThan(lifecycle.drawsAfterDraw);
    }

    // Teardown propre et vérification d'absence de patch
    await teardownStabilityMetrics(page);
    await assertCleanTeardown(page);
  });
});
