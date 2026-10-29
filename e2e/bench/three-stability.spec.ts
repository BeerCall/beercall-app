import { test, expect, type Page, type Locator } from '@playwright/test';
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
  makeVariedConnections,
} from './support/stabilityFixtures';
import {
  assertCleanTeardown,
  getStabilitySnapshot,
  installStabilityMetrics,
  teardownStabilityMetrics,
  type StabilityMetricsSnapshot,
} from './support/stabilityMetrics';

const PHASE = process.env.BEERCALL_STABILITY_PHASE === 'verify' ? 'verify' : 'baseline';
const TOTAL_CYCLES = Number(process.env.BEERCALL_STABILITY_CYCLES ?? 40);
const WARMUP_CYCLES = Math.min(10, TOTAL_CYCLES - 1);
const resultsDir = process.env.BEERCALL_USAGE_RESULTS ?? resolve(process.cwd(), 'test-results');
if (!Number.isSafeInteger(TOTAL_CYCLES) || TOTAL_CYCLES < 2 || TOTAL_CYCLES > 40) {
  throw new Error('Diagnostic borné2..40 cycles ; seule une série40 qualifie le protocole.');
}
interface QueryClientProbe {
  invalidateQueries(options: { queryKey: string[] }): Promise<unknown>;
  getQueryData(key: string[]): unknown;
}
interface StabilityWindow extends Window {
  __queryClient?: QueryClientProbe;
  __prevDevToolsHook?: unknown;
  __hadDevToolsHook?: boolean;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
}

async function centralThumbnail(page: Page, list: Locator, label: string) {
  const id = await list.evaluate(element => {
    const viewport = element.getBoundingClientRect();
    const centerX = viewport.left + viewport.width / 2;
    const centerY = viewport.top + viewport.height / 2;
    return Array.from(element.querySelectorAll<HTMLElement>('[data-testid^="avatar-thumb-"]'))
      .map(node => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right)
      .map(({ node, rect }) => ({ id: node.dataset.testid!, distance: Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY) }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0]?.id;
  });
  expect(id, `${label} : candidat central réel`).toBeDefined();
  const canvas = page.getByTestId(id!).locator('[data-avatar-framing="ready"] canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvas.evaluate(node => window.__stabilityCanvasDraws!(node as HTMLCanvasElement)), { timeout: 15_000 }).toBeGreaterThan(0);
  const info = await canvas.evaluate(node => {
    const element = node.closest('[data-avatar-framing-info]');
    return element ? JSON.parse(element.getAttribute('data-avatar-framing-info')!) as { cpuTimeMs: number } : null;
  });
  expect(info && Number.isFinite(info.cpuTimeMs), `${label} : coût mesuré`).toBeTruthy();
  return { canvas, id: id!, cpuTimeMs: info!.cpuTimeMs };
}

async function loseAndRestore(canvas: Locator) {
  return canvas.evaluate(async element => {
    const node = element as HTMLCanvasElement;
    const gl = node.getContext('webgl2') ?? node.getContext('webgl');
    if (!gl) return { available: false as const, reason: 'WebGL absent' };
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) return { available: false as const, reason: 'WEBGL_lose_context absent : restauration non mesurée' };
    const before = window.__getStabilitySnapshot!();
    const canvasId = node.getAttribute('data-stability-id');
    const contextBefore = before.contexts.find(c => c.canvasId === canvasId);
    let drawsAtRestored = 0;
    const onRestored = () => { drawsAtRestored = window.__stabilityCanvasDraws!(node); };
    node.addEventListener('webglcontextrestored', onRestored);
    try {
      extension.loseContext();
      await new Promise(resolve => setTimeout(resolve, 300));
      const lostSnapshot = window.__getStabilitySnapshot!();
      extension.restoreContext();
      await new Promise(resolve => setTimeout(resolve, 700));
      const restoredSnapshot = window.__getStabilitySnapshot!();
      return {
        available: true as const, canvasId, contextBefore,
        contextLost: lostSnapshot.contexts.find(c => c.canvasId === canvasId),
        contextRestored: restoredSnapshot.contexts.find(c => c.canvasId === canvasId),
        sameCanvas: node.isConnected && node === document.querySelector(`canvas[data-stability-id="${canvasId}"]`),
        sameContext: gl === (node.getContext('webgl2') ?? node.getContext('webgl')),
        lost: lostSnapshot.contextsLost - before.contextsLost,
        restored: restoredSnapshot.contextsRestored - before.contextsRestored,
        drawsAtRestored,
      };
    } finally { node.removeEventListener('webglcontextrestored', onRestored); }
  });
}

async function waitForDashboard(page: Page) {
  const mapCanvas = page.locator('div.maplibregl-map canvas.maplibregl-canvas').first();
  await expect(mapCanvas).toBeVisible({ timeout: 45_000 });
  await mapCanvas.evaluate((canvas) => canvas.setAttribute('data-stability-map', 'map-1'));
  await expect.poll(
    () => mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)),
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

      // Capture non intrusive de QueryClient via DevTools hook local à la spec
      await page.addInitScript(() => {
        type Fiber = {
          memoizedProps?: {
            client?: QueryClientProbe;
          };
          child?: Fiber;
          sibling?: Fiber;
        };
        const w = window as StabilityWindow;
        w.__hadDevToolsHook = Object.prototype.hasOwnProperty.call(w, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
        w.__prevDevToolsHook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        const hook = {
          supportsFiber: true,
          renderers: new Map(),
          inject(renderer: unknown) {
            const id = this.renderers.size + 1;
            this.renderers.set(id, renderer);
            return id;
          },
          onCommitFiberRoot(_id: number, root: { current: Fiber }) {
            const visit = (fiber?: Fiber) => {
              if (!fiber) return;
              const props = fiber.memoizedProps;
              if (props?.client && typeof props.client.invalidateQueries === 'function') {
                w.__queryClient = props.client;
              }
              if (fiber.child) visit(fiber.child);
              if (fiber.sibling) visit(fiber.sibling);
            };
            visit(root.current);
          },
        };
        w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
      });

      const fixture = await installStabilityFixtures(context);
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      const mapCanvas = await waitForDashboard(page);
      const mapHandle = await mapCanvas.elementHandle();
      expect(mapHandle).not.toBeNull();
      const playerCanvas = page.locator('[data-testid="retained-dashboard"] [data-testid="safe-avatar-container"] canvas').first();
      await expect(playerCanvas).toBeVisible();
      await expect.poll(() => playerCanvas.evaluate(canvas => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement))).toBeGreaterThan(0);
      const playerHandle = await playerCanvas.elementHandle();
      expect(playerHandle).not.toBeNull();
      const retainedIds = await page.evaluate(() => [
        document.querySelector('canvas[data-stability-map="map-1"]')?.getAttribute('data-stability-id'),
        document.querySelector('[data-testid="retained-dashboard"] [data-testid="safe-avatar-container"] canvas')?.getAttribute('data-stability-id'),
      ]);
      expect(retainedIds.every(Boolean) && new Set(retainedIds).size === 2).toBe(true);

      const history: Array<{
        cycle: number;
        contextsCreated: number;
        contextsLost: number;
        contextsRestored: number;
        drawCalls: number;
        mapDraws: number;
        thumbnailDraws: number;
        backgroundReturn: boolean;
        measuredCpuMs: { entry: number; bottom: number; top: number };
      }> = [];

      const checkpoints: Array<{
        cycle: number;
        stage: 'list_entry' | 'bottom' | 'top' | 'return';
        activeContexts: number;
        snapshot: StabilityMetricsSnapshot;
      }> = [];

      let postWarmupReturnContexts: number | undefined;
      const checkpoint = async (cycle: number, stage: 'list_entry' | 'bottom' | 'top' | 'return') => {
        let snapshot = await getStabilitySnapshot(page);
        await expect.poll(async () => {
          snapshot = await getStabilitySnapshot(page);
          return snapshot.activeContexts;
        }, { timeout: 15_000, message: `${stage} cycle ${cycle} : inventaire stabilisé≤4` }).toBeLessThanOrEqual(4);
        if (cycle > WARMUP_CYCLES) checkpoints.push({ cycle, stage, activeContexts: snapshot.activeContexts, snapshot });
        return snapshot;
      };

      for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
        currentCycle = cycle;
        const varied = cycle > 20;

        // Transition cycle 20 -> cycle 21 : 30 profils variés valides
        if (cycle === 21) {
          fixture.setConnections(makeVariedConnections());
          const hasClient = await page.evaluate(() => typeof (window as StabilityWindow).__queryClient?.invalidateQueries === 'function');
          expect(hasClient, 'QueryClient capturé via hook DevTools').toBe(true);

          await page.evaluate(() => (window as StabilityWindow).__queryClient!.invalidateQueries({ queryKey: ['connections'] }));

          const [response] = await Promise.all([
            page.waitForResponse(res => res.url().includes('/auth/connections') && res.status() === 200),
            openConnections(page),
          ]);
          const newConnections = await response.json();
          expect(newConnections).toHaveLength(30);
          expect(newConnections).toEqual(fixture.connections);
          await expect.poll(() => page.evaluate(() => (window as StabilityWindow).__queryClient!.getQueryData(['connections']))).toEqual(fixture.connections);
        } else {
          // 1. Entrée Connexions
          await openConnections(page);
        }
        const thumbnails = page.locator('[data-testid^="avatar-thumb-"]');
        await expect(thumbnails).toHaveCount(30, { timeout: 15_000 });

        const list = page.locator('div.flex-1.overflow-y-auto').first();
        const entry = await centralThumbnail(page, list, `Entrée cycle ${cycle}`);
        await checkpoint(cycle, 'list_entry');

        // 2. Descente au 30e item, vrai candidat central rendu
        const item30 = thumbnails.nth(29);
        await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(item30).toBeInViewport();
        const bottom = await centralThumbnail(page, list, `Bas cycle ${cycle}`);
        const bottomDraws = await bottom.canvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement));
        assertFrames(bottomDraws, `Miniature bas cycle ${cycle}`);
        await checkpoint(cycle, 'bottom');

        // 3. Remonter jusqu'au premier écran, rendu admis 1..2
        const item1 = thumbnails.nth(0);
        await list.evaluate(node => { node.scrollTop = 0; });
        await expect(item1).toBeInViewport();
        const top = await centralThumbnail(page, list, `Haut cycle ${cycle}`);
        const topReadyCount = await list.locator('[data-avatar-framing="ready"] canvas').count();
        expect(topReadyCount, 'Rendu admis 1..2 au premier écran').toBeGreaterThanOrEqual(1);
        expect(topReadyCount, 'Rendu admis 1..2 au premier écran').toBeLessThanOrEqual(2);
        const topDraws = await top.canvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement));
        assertFrames(topDraws, `Miniature haut cycle ${cycle}`);
        await checkpoint(cycle, 'top');

        // 4. Observer compteurs carte et joueur avant retour
        const mapDrawsBeforeReturn = await mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement));
        const playerDrawsBeforeReturn = await playerHandle!.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement));

        // 5. Simulation visibility passage masqué / retour distinct
        let backgroundReturn = false;
        if (cycle === 30) {
          const hiddenOk = await page.evaluate(() => window.__stabilitySetDocumentHidden?.(true));
          expect(hiddenOk).toBe(true);
          await page.waitForTimeout(200);
          const visibleOk = await page.evaluate(() => window.__stabilitySetDocumentHidden?.(false));
          expect(visibleOk).toBe(true);
          await page.waitForTimeout(200);
          backgroundReturn = true;
        }

        // 6. Retour par bouton SPA
        const beforeReturn = await page.evaluate(() => performance.now());
        await backToDashboard(page);

        // 7. Après retour : identité stable et progression
        await expect(page.locator('canvas[data-stability-map="map-1"]')).toHaveCount(1);
        await expect(playerCanvas).toBeVisible({ timeout: 15_000 });
        expect(await mapHandle!.evaluate(canvas => canvas.isConnected && canvas === document.querySelector('canvas[data-stability-map="map-1"]'))).toBe(true);
        expect(await playerHandle!.evaluate(canvas => canvas.isConnected && canvas === document.querySelector('[data-testid="retained-dashboard"] [data-testid="safe-avatar-container"] canvas'))).toBe(true);
        await expect.poll(() => mapHandle!.evaluate(canvas => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)), { timeout: 15_000 }).toBeGreaterThan(mapDrawsBeforeReturn);
        await expect.poll(() => playerHandle!.evaluate(canvas => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)), { timeout: 15_000 }).toBeGreaterThan(playerDrawsBeforeReturn);
        const mapDrawsAfter = await mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement));
        expect(mapDrawsAfter, `Progression carte cycle ${cycle}`).toBeGreaterThan(mapDrawsBeforeReturn);

        await expect.poll(
          () => page.evaluate((after) => {
            const signals = (window as unknown as { __beercall_scene_metrics?: Record<string, { view?: string; generation?: number; timestamp?: number; drawCalls?: number }> }).__beercall_scene_metrics;
            const s = signals?.avatarFrameSubmitted, map = signals?.mapInteractive;
            return Boolean(s && map && s.view === 'dashboard' && Number(s.generation) > 0 && s.generation === map.generation && Number(s.timestamp) > after && Number(map.timestamp) > after && Number(s.drawCalls) > 0);
          }, beforeReturn),
          { timeout: 15_000, message: `Preuve joueur courant generation valide cycle ${cycle}` },
        ).toBe(true);

        await page.screenshot({ path: resolve(resultsDir, `stability-${PHASE}-return-cycle-${cycle}.png`) });

        // 8. Attendre libération asynchrone native et vérifier inventaire au retour
        await expect.poll(async () => (await getStabilitySnapshot(page)).activeContexts,
          { timeout: 15_000, message: `Retour cycle ${cycle} : seuls les deux contextes retenus subsistent` },
        ).toBe(retainedIds.length);
        const metrics = await checkpoint(cycle, 'return');
        const liveIds = metrics.contexts.filter(c => (c.status === 'live' || c.status === 'restored') && !c.contextCollected).map(c => c.canvasId).sort();
        expect(liveIds).toEqual([...retainedIds].sort());
        if (cycle === WARMUP_CYCLES) postWarmupReturnContexts = metrics.activeContexts;
        if (cycle > WARMUP_CYCLES) expect(metrics.activeContexts).toBe(postWarmupReturnContexts);

        history.push({
          cycle,
          contextsCreated: metrics.contextsCreated,
          contextsLost: metrics.contextsLost,
          contextsRestored: metrics.contextsRestored,
          drawCalls: metrics.drawCalls,
          mapDraws: mapDrawsAfter,
          thumbnailDraws: topDraws,
          backgroundReturn,
          measuredCpuMs: { entry: entry.cpuTimeMs, bottom: bottom.cpuTimeMs, top: top.cpuTimeMs },
        });
        console.log(`[Stabilité ${PHASE}] cycle${cycle}/${TOTAL_CYCLES}, actifs=${metrics.activeContexts}, CPU miniature entrée/bas/haut(ms)=${entry.cpuTimeMs.toFixed(1)}/${bottom.cpuTimeMs.toFixed(1)}/${top.cpuTimeMs.toFixed(1)}`);
      }

      await fixture.assertModels();
      fixture.isolation.assertIsolated();
      assertSingleDocument(documentRequests);
      expect(documentRequests, 'Un seul document, aucune navigation complète').toHaveLength(1);
      expect(webglWarnings, 'Aucun warning de quota WebGL').toEqual([]);
      expect(fixture.isolation.pageErrors, 'Aucune erreur de page').toEqual([]);
      const warmupIndex = Math.max(0, Math.min(WARMUP_CYCLES - 1, history.length - 1));
      const afterWarmup = history[warmupIndex].contextsCreated;
      const finalMetrics = await getStabilitySnapshot(page);
      const activeContexts = finalMetrics.activeContexts;
      assertBoundedGrowth(afterWarmup, finalMetrics.contextsCreated, TOTAL_CYCLES - WARMUP_CYCLES);
      assertContextInventory(checkpoints);
      const dom = await page.evaluate(() => ({
        retainedDashboard: document.querySelectorAll('[data-testid="retained-dashboard"]').length,
        canvases: Array.from(document.querySelectorAll('canvas')).map(canvas => ({
          canvasId: canvas.getAttribute('data-stability-id'), connected: canvas.isConnected,
          width: canvas.width, height: canvas.height,
        })),
        rootScroll: { x: window.scrollX, y: window.scrollY },
      }));

      const summary = {
        phase: PHASE,
        qualificationComplete: TOTAL_CYCLES === 40,
        comparison: 'image courante seulement, non comparative faute d’image pré-correctifs',
        cycles: TOTAL_CYCLES,
        warmupCycles: WARMUP_CYCLES,
        gpuMemory: 'inconnue',
        postWarmupReturnContexts,
        finalMetrics,
        activeContexts,
        afterWarmupContexts: afterWarmup,
        documentRequests,
        webglWarnings,
        pageErrors: fixture.isolation.pageErrors,
        modelHits: Object.fromEntries(fixture.modelHits),
        checkpoints,
        series: {
          history,
          checkpoints,
        },
        dom,
        renderer: 'non mesuré : inventaire GPU non exposé par la vue',
        live: finalMetrics,
      };
      const output = resolve(resultsDir, TOTAL_CYCLES === 40 ? `stability-${PHASE}.json` : `stability-smoke-${TOTAL_CYCLES}-${PHASE}.json`);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(summary, null, 2));

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
      await page.evaluate(() => {
        const w = window as StabilityWindow;
        delete w.__queryClient;
        if (w.__hadDevToolsHook) {
          w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = w.__prevDevToolsHook;
        } else {
          delete w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        }
        delete w.__prevDevToolsHook;
        delete w.__hadDevToolsHook;
      }).catch(() => {});
      await teardownStabilityMetrics(page);
      await assertCleanTeardown(page);
    }
  });

  test('perte/restauration volontaire — avatar Profil', async ({ context, page }) => {
    test.setTimeout(120_000);
    await installStabilityMetrics(page);

    try {
      const fixture = await installStabilityFixtures(context);
      await page.goto('/profile');
      await page.waitForLoadState('domcontentloaded');

      const avatarCanvas = page.locator('div[data-testid="safe-avatar-container"] canvas').first();
      await expect(avatarCanvas).toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => avatarCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)),
        { timeout: 30_000 },
      ).toBeGreaterThan(0);

      const result = await loseAndRestore(avatarCanvas);

      if (!result.available) {
        test.info().annotations.push({ type: 'non mesuré', description: result.reason });
        console.log(`[T20 WEBGL_lose_context Profil] non mesuré : ${result.reason}`);
      } else {
        expect(result.lost).toBeGreaterThan(0);
        expect(result.restored).toBeGreaterThan(0);
        expect(result.sameCanvas && result.sameContext).toBe(true);
        expect(result.contextBefore?.id).toBeDefined();
        expect(result.contextLost?.id).toBe(result.contextBefore?.id);
        expect(result.contextRestored?.id).toBe(result.contextBefore?.id);
        expect(result.contextLost?.status).toBe('lost');
        expect(result.contextRestored?.status).toBe('restored');
        await expect(page.locator('div[data-testid="safe-avatar-container"] canvas')).toHaveCount(1);
        await expect.poll(
          () => avatarCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)),
          { timeout: 15_000 },
        ).toBeGreaterThan(result.drawsAtRestored);
        // État HTML seulement fermé après frame/idle correct
        await expect(page.locator('[role="status"][aria-label="Contexte WebGL perdu"]')).toHaveCount(0);
        await expect(page.locator('[role="status"][aria-label="Restauration de l\'affichage"]')).toHaveCount(0);
      }
      expect(result.available, 'Extension absente = sous-critère non mesuré, pas succès').toBe(true);
      expect(fixture.isolation.pageErrors).toEqual([]);
      await mkdir(resultsDir, { recursive: true });
      await writeFile(resolve(resultsDir, `recovery-profile-${PHASE}.json`), JSON.stringify(result, null, 2));
      await fixture.assertModels();
    } finally {
      await teardownStabilityMetrics(page);
    }
  });

  test('perte/restauration volontaire — carte MapLibre', async ({ context, page }) => {
    test.setTimeout(120_000);
    await installStabilityMetrics(page);

    try {
      page.on('pageerror', (error) => console.log('[T20 MapLibre pageerror]', error.stack ?? error.message));
      const fixture = await installStabilityFixtures(context);
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');

      const mapCanvas = page.locator('div.maplibregl-map canvas.maplibregl-canvas').first();
      await expect(mapCanvas).toBeVisible({ timeout: 45_000 });
      await expect.poll(
        () => mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)),
        { timeout: 30_000 },
      ).toBeGreaterThan(0);

      const result = await loseAndRestore(mapCanvas);

      console.log('MapLibre result:', result);

      const mapHtml = await page.evaluate(() => {
        const mapDiv = document.querySelector('div.maplibregl-map');
        return {
          url: window.location.href,
          bodyText: document.body.innerText.slice(0, 300),
          hasMapDiv: Boolean(mapDiv),
          mapChildren: mapDiv ? Array.from(mapDiv.children).map(c => c.className) : [],
          canvases: Array.from(document.querySelectorAll('canvas')).map(c => ({
            className: c.className,
            parentClass: c.parentElement?.className,
          })),
        };
      });
      page.on('pageerror', (error) => console.log('[T20 MapLibre pageerror]', error.stack ?? error.message));
      console.log('Map HTML structure:', JSON.stringify(mapHtml, null, 2));
      console.log('Page errors:', fixture.isolation.pageErrors);

      if (!result.available) {
        test.info().annotations.push({ type: 'non mesuré', description: result.reason });
        console.log(`[T20 WEBGL_lose_context MapLibre] non mesuré : ${result.reason}`);
      } else {
        expect(result.lost).toBeGreaterThan(0);
        // Conserver l'échec brut : un crash n'est jamais une restauration réussie.
        expect(fixture.isolation.pageErrors, 'Aucune erreur pendant la restauration MapLibre').toEqual([]);
        expect(result.restored).toBeGreaterThan(0);
        expect(result.sameCanvas && result.sameContext).toBe(true);
        expect(result.contextBefore?.id).toBeDefined();
        expect(result.contextLost?.id).toBe(result.contextBefore?.id);
        expect(result.contextRestored?.id).toBe(result.contextBefore?.id);
        expect(result.contextLost?.status).toBe('lost');
        expect(result.contextRestored?.status).toBe('restored');
        await expect(page.locator('div.maplibregl-map canvas.maplibregl-canvas')).toHaveCount(1);
        await expect.poll(
          () => mapCanvas.evaluate((canvas) => window.__stabilityCanvasDraws!(canvas as HTMLCanvasElement)),
          { timeout: 15_000 },
        ).toBeGreaterThan(result.drawsAtRestored);
        // État HTML seulement fermé après frame/idle correct
        await expect(page.getByText('Carte momentanément indisponible')).toHaveCount(0);
      }
      expect(result.available, 'Extension absente = sous-critère non mesuré, pas succès').toBe(true);
      await mkdir(resultsDir, { recursive: true });
      await writeFile(resolve(resultsDir, `recovery-maplibre-${PHASE}.json`), JSON.stringify({ ...result, dom: mapHtml, pageErrors: fixture.isolation.pageErrors }, null, 2));
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
      if (!gl) return { supported: false as const, reason: 'WebGL non supporté' };

      const snap1 = window.__getStabilitySnapshot!();
      const initialId = snap1.contexts[0]?.id;
      const initialStatus = snap1.contexts[0]?.status;
      const initialActive = snap1.activeContexts;

      // Draw call
      try { gl.drawArrays(gl.POINTS, 0, 1); } catch (_) {}
      const snapAfterDraw = window.__getStabilitySnapshot!();
      const drawsAfterDraw = snapAfterDraw.drawCalls;

      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) return { supported: false as const, reason: 'WEBGL_lose_context non supporté' };

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
        supported: true as const,
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
