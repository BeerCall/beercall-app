import { test, expect, type Page, type Locator } from '@playwright/test';
import { installUxFixtures, makeSquads } from './support/uxFixtures';

test.use({ trace: 'off' });
const viewports = [
  { width: 320, height: 568 }, { width: 375, height: 812 }, { width: 390, height: 844 },
  { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1280, height: 800 },
];

async function navigateToPage(page: Page, index: number) {
  for (let i = 0; i < index; i++) await page.getByRole('button', { name: 'Page suivante' }).tap();
}

async function assertWheelGeometry(wheel: Locator) {
  await expect.poll(() => wheel.evaluate(region => {
    const issues: string[] = [];
    const band = region.getBoundingClientRect();
    const buttons = [...region.querySelectorAll<HTMLButtonElement>('button')];
    const labels = [...region.querySelectorAll<HTMLElement>('[data-wheel-label]')];
    const zones = [...region.querySelectorAll<HTMLElement>('[data-wheel-active], [data-wheel-controls]')];
    const rect = (el: Element) => el.getBoundingClientRect();
    const intersection = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    for (const el of [...buttons, ...labels]) {
      const r = rect(el);
      if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight ||
          r.left < band.left || r.right > band.right || r.top < band.top || r.bottom > band.bottom) issues.push(`Hors bande : ${el.textContent || el.getAttribute('aria-label')}`);
    }
    for (const button of buttons) {
      const r = rect(button);
      if (!button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) issues.push(`Bouton masqué : ${button.getAttribute('aria-label')}`);
    }
    labels.forEach((label, i) => {
      for (const other of [...labels.slice(i + 1), ...buttons, ...zones]) {
        if (intersection(rect(label), rect(other)) > 0) issues.push(`Collision du label : ${label.textContent}`);
      }
    });
    const counter = region.querySelector('[data-wheel-controls] span');
    if (counter) {
      const r = rect(counter);
      if (!counter.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) issues.push(`Compteur de page masqué : ${counter.textContent}`);
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('Overflow horizontal document');
    return issues;
  }), 'Géométrie au repos : boutons, labels et compteur réellement visibles').toEqual([]);
}

for (const viewport of viewports) {
  for (const count of [0, 1, 3, 8, 12]) {
    const pageCount = Math.max(1, Math.ceil(count / 3));
    for (let index = 0; index < pageCount; index++) {
      test(`géométrie ${count} squads ${viewport.width}×${viewport.height} page ${index + 1} et Créer`, async ({ context, page }) => {
        await page.setViewportSize(viewport);
        const isolation = await installUxFixtures(context, { squads: makeSquads(count) });
        await page.goto(count ? '/squad/900001' : '/dashboard');
        const wheel = page.getByRole('region', { name: 'Navigation des squads' });
        await expect(wheel.getByRole('button', { name: 'Créer', exact: true })).toBeVisible();
        if (count) await expect(wheel.getByRole('button', { name: makeSquads(count)[0].name, exact: true })).toBeVisible();
        await navigateToPage(page, index);
        await assertWheelGeometry(wheel);
        if (pageCount > 1) await expect(wheel.getByText(`Page ${index + 1}/${pageCount}`, { exact: true })).toBeVisible();
        else await expect(wheel.getByRole('button', { name: 'Page suivante' })).toHaveCount(0);
        await wheel.getByRole('button', { name: 'Créer', exact: true }).tap();
        await expect(page.getByRole('heading', { name: 'Nouvelle Squad', exact: true })).toBeVisible();
        isolation.assertIsolated();
      });

      test(`Rejoindre ${count} squads ${viewport.width}×${viewport.height} page ${index + 1}`, async ({ context, page }) => {
        await page.setViewportSize(viewport);
        const isolation = await installUxFixtures(context, { squads: makeSquads(count) });
        await page.goto(count ? '/squad/900001' : '/dashboard');
        const wheel = page.getByRole('region', { name: 'Navigation des squads' });
        await expect(wheel.getByRole('button', { name: 'Rejoindre', exact: true })).toBeVisible();
        if (count) await expect(wheel.getByRole('button', { name: makeSquads(count)[0].name, exact: true })).toBeVisible();
        await navigateToPage(page, index);
        await wheel.getByRole('button', { name: 'Rejoindre', exact: true }).tap();
        await expect(page.getByRole('heading', { name: 'Rejoindre', exact: true })).toBeVisible();
        await expect(page.getByPlaceholder('CODE...', { exact: true })).toBeVisible();
        isolation.assertIsolated();
      });
    }
  }
}

async function touchSwipe(page: Page, direction: 'next' | 'previous') {
  const wheel = await page.getByRole('region', { name: 'Navigation des squads' }).boundingBox();
  expect(wheel).not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  const start = wheel!.x + wheel!.width / 2 + (direction === 'next' ? 60 : -60);
  const y = wheel!.y + 100;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y, id: 1 }] });
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (direction === 'next' ? -1 : 1) * step * 20, y, id: 1 }] });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }
    // A frame count depends on scheduling. Keep contact stationary for a real 200ms
    // before release so Chromium does not consume the next tap as the end of a flick.
    const settleUntil = performance.now() + 200;
    do {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (direction === 'next' ? -120 : 120), y, id: 1 }] });
    } while (performance.now() < settleUntil);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}

for (const width of [320, 390]) {
  for (const count of [8, 12]) {
    test(`swipes tactiles ${count} squads à ${width}, extrémités et retour`, async ({ context, page }) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      const squads = makeSquads(count);
      const isolation = await installUxFixtures(context, { squads });
      await page.goto('/squad/900001');
      const wheel = page.getByRole('region', { name: 'Navigation des squads' });
      const seen = new Set<string>();
      const pageCount = Math.ceil(count / 3);
      for (let i = 0; i < pageCount; i++) {
        await expect(wheel.getByText(`Page ${i + 1}/${pageCount}`, { exact: true })).toBeVisible();
        await assertWheelGeometry(wheel);
        for (const name of await wheel.getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label') ?? ''))) {
          if (squads.some(s => s.name === name)) seen.add(name);
        }
        if (i < pageCount - 1) await touchSwipe(page, 'next');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page).toHaveURL('/squad/900001');
      }
      expect(seen.size).toBe(count);
      await touchSwipe(page, 'next');
      await expect(wheel.getByText(`Page ${pageCount}/${pageCount}`, { exact: true })).toBeVisible();
      for (let i = pageCount - 1; i > 0; i--) {
        await touchSwipe(page, 'previous');
        await expect(wheel.getByText(`Page ${i}/${pageCount}`, { exact: true })).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page).toHaveURL('/squad/900001');
      }
      await touchSwipe(page, 'previous');
      await expect(wheel.getByText(`Page 1/${pageCount}`, { exact: true })).toBeVisible();
      await assertWheelGeometry(wheel);
      await page.getByRole('button', { name: /Répondre/ }).tap();
      await expect(page.getByRole('heading', { name: 'Appel aux armes !' })).toBeVisible();
      isolation.assertIsolated();
    });
  }

  for (const squad of makeSquads(12)) {
    test(`nom intégral et ID ${squad.id} par tap à ${width}`, async ({ context, page }) => {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      const isolation = await installUxFixtures(context, { squads: makeSquads(12) });
      await page.goto('/squad/900001');
      await expect(page.getByRole('region').getByText('Page 1/4', { exact: true })).toBeVisible();
      await navigateToPage(page, Math.floor((squad.id - 900001) / 3));
      const trigger = page.getByRole('button', { name: squad.name, exact: true });
      await trigger.tap();
      const dialog = page.getByRole('dialog', { name: 'Ouvrir cette squad ?' });
      await expect(dialog.getByText(squad.name, { exact: true })).toBeVisible();
      await expect(page).toHaveURL('/squad/900001');
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.getByRole('button', { name: 'Annuler', exact: true }).tap();
      await expect(trigger).toBeFocused();
      await trigger.tap();
      await dialog.getByText(squad.name, { exact: true }).scrollIntoViewIfNeeded();
      await dialog.getByRole('button', { name: 'Ouvrir la squad', exact: true }).tap();
      await expect(page).toHaveURL(`/squad/${squad.id}`);
      await expect(dialog).toHaveCount(0);
      isolation.assertIsolated();
    });
  }
}

test('ID courant en page 4, navigation clavier, confinement du focus et Escape', async ({ context, page }) => {
  const squads = makeSquads(12);
  const isolation = await installUxFixtures(context, { squads, currentSquadId: 900012 });
  await page.goto('/squad/900012');
  const wheel = page.getByRole('region');
  await expect(wheel.getByText('Page 4/4', { exact: true })).toBeVisible();
  const trigger = wheel.getByRole('button', { name: squads[11].name, exact: true });
  await expect(trigger).toHaveAttribute('aria-current', 'page');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const cancel = page.getByRole('button', { name: 'Annuler', exact: true });
  const confirm = page.getByRole('button', { name: 'Ouvrir la squad', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(wheel.getByText('Page 3/4', { exact: true })).toBeVisible();
  const next = wheel.getByRole('button', { name: squads[6].name, exact: true });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByText(squads[6].name, { exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/squad/${squads[6].id}`);
  isolation.assertIsolated();
});

for (const viewport of viewports) {
  test(`taps carte centrale à ${viewport.width}×${viewport.height}`, async ({ context, page }) => {
    await page.setViewportSize(viewport);
    const isolation = await installUxFixtures(context, { squads: makeSquads(12) });
    await page.goto('/squad/900001');
    await page.getByRole('button', { name: 'Chat', exact: true }).tap();
    await expect(page).toHaveURL('/squad/900001/beer-call/bc_900001/chat');
    await page.goto('/squad/900001');
    await page.getByRole('button', { name: /Répondre/ }).tap();
    await expect(page.getByRole('heading', { name: 'Appel aux armes !' })).toBeVisible();
    isolation.assertIsolated();
  });
}
