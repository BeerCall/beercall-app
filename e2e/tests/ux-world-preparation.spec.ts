import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixtureCall, installUxFixtures } from './support/uxFixtures';

const backendWorkspace = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(process.cwd(), '../beercall-backend');

test.use({ viewport: { width: 390, height: 844 } });
const models = ['Bar.fbx', 'Swimming_pool.fbx', 'Floaty_Island.fbx'];

test('trois décors préparés sans Canvas ni jeu, puis une seule scène visible avec vraie frame', async ({ context, page }, info) => {
  test.setTimeout(90_000);
  const prepared = process.env.BEERCALL_EXPECT_WORLD_WARMUP === '1';
  const isolation = await installUxFixtures(context, {
    assets: true,
    calls: [{ ...fixtureCall, has_responded: true, user_status: 'joined' }],
    simulations: [{ method: 'GET', path: '/api/aperos/900001/game/state', respond: route => route.fulfill({ status: 404, json: { detail: 'No game' } }) }],
  });
  const hits = new Map<string, number>();
  for (const name of models) {
    const bytes = await readFile(resolve(backendWorkspace, 'static/models', name));
    await context.route(`**/models/${name}`, route => {
      hits.set(name, (hits.get(name) ?? 0) + 1);
      return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
    });
  }
  const gameRequests: string[] = [];
  const fontRequests: { url: string; startTime: number; responseEnd: number }[] = [];
  page.on('requestfinished', request => {
    if (/font|woff|unicode/i.test(request.url())) {
      const timing = request.timing();
      fontRequests.push({ url: request.url().split('?')[0], startTime: timing.startTime, responseEnd: timing.responseEnd });
    }
  });
  page.on('request', request => { if (request.url().includes('/game/')) gameRequests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.addInitScript(() => {
    const timings = { clicks: {} as Record<string, number>, frames: [] as { tab: string; ms: number; calls: number }[] };
    Object.assign(window, { __worldPreparationTimings: timings });
    document.addEventListener('click', event => {
      const text = (event.target as Element).closest('button')?.textContent?.trim().toLowerCase();
      if (text?.startsWith('mondes')) timings.clicks.bar = performance.now();
      else if (text && ['bar', 'piscine', 'dodo'].includes(text)) timings.clicks[text] = performance.now();
    }, true);
    window.addEventListener('beercall:scene-metric', event => {
      const detail = (event as CustomEvent<{ kind: string; view: string; timestamp: number; drawCalls: number }>).detail;
      if (detail.kind !== 'worldFrameSubmitted') return;
      const tab = detail.view.replace('world-', '');
      if (timings.clicks[tab]) timings.frames.push({ tab, ms: detail.timestamp - timings.clicks[tab], calls: detail.drawCalls });
    });
  });
  await page.goto('/squad/900001');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  if (prepared) {
    await expect.poll(() => page.evaluate(names => names.every(name => performance.getEntriesByName(`beercall:world-model-prepared:/models/${name}`).length === 1), models),
      { timeout: 45_000, message: 'All three real FBX models decoded in the shared foreground cache' }).toBe(true);
    expect([...hits.keys()].sort()).toEqual([...models].sort());
  }
  expect(gameRequests, 'No game queries, actions or starts while preparing static resources').toEqual([]);
  expect(await page.locator('canvas').count(), 'Preparation never creates a world Canvas').toBe(1);
  await page.getByRole('button', { name: /Mondes/ }).tap();
  for (const tab of ['bar', 'piscine', 'dodo']) {
    if (tab !== 'bar') await page.getByRole('button', { name: tab, exact: true }).tap();
    await page.waitForFunction(tabName => {
      const timings = Reflect.get(window, '__worldPreparationTimings') as { frames: { tab: string }[] };
      return timings.frames.some(frame => frame.tab === tabName);
    }, tab);
    await expect(page.locator('canvas')).toHaveCount(2); // retained map + one world
    if (prepared) await expect(page.locator('[data-world-canvas] canvas')).toHaveCount(1);
  }
  expect([...hits.values()], 'Warm-up and actual worlds reuse a single decoded resource per model').toEqual([1, 1, 1]);
  expect(gameRequests.every(request => request === 'GET /api/aperos/900001/game/state')).toBe(true);
  const timings = await page.evaluate(() => Reflect.get(window, '__worldPreparationTimings'));
  console.log(JSON.stringify({ preparedWorlds: prepared, timings, fontRequests }));
  await info.attach('world-preparation-timings', { body: JSON.stringify({ prepared, timings,
    scope: 'Chromium local; frame submission, not physical iPhone display; dynamic participants/GPU compilation are not precreated' }), contentType: 'application/json' });
  isolation.assertIsolated();
});
