import { resolve } from 'node:path';
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
      if (label.scrollWidth > Math.ceil(label.clientWidth) + 1) {
        issues.push(`ScrollWidth caché dans label : ${label.textContent}`);
      }
      const style = getComputedStyle(label);
      // Nouvelle direction v5.2 : plus aucun fond opaque blanc, la lisibilité vient
      // de la couleur calculée et de l'ombre, pas d'un rectangle.
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        issues.push(`Fond non transparent sur label : ${label.textContent} (${style.backgroundColor})`);
      }
      const identityLabel = document.querySelector<HTMLElement>('[data-dashboard-identity] h2');
      const expected = identityLabel ? getComputedStyle(identityLabel).color : null;
      if (expected ? style.color !== expected : !['rgb(16, 24, 40)', 'rgb(251, 191, 36)'].includes(style.color)) {
        issues.push(`Couleur de label désynchronisée du badge : ${label.textContent} (${style.color})`);
      }
      if (style.textShadow === 'none' && style.filter === 'none') {
        issues.push(`Halo/ombre manquant sur label : ${label.textContent}`);
      }
      for (const other of [...labels.slice(i + 1), ...buttons, ...zones]) {
        if (intersection(rect(label), rect(other)) > 0) issues.push(`Collision du label : ${label.textContent}`);
      }
    });
    const counter = region.querySelector('[data-wheel-controls] span');
    if (counter) {
      const r = rect(counter);
      if (!counter.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) issues.push(`Compteur de page masqué : ${counter.textContent}`);
    }
    const bar = region.nextElementSibling;
    if (bar) {
      const barRect = bar.getBoundingClientRect();
      const gapWheelBar = Math.abs(barRect.top - band.bottom);
      if (gapWheelBar > 1) issues.push(`Gap roue/barre anormal : ${gapWheelBar.toFixed(1)} px (attendu 0 px ±1)`);
    }
    const timeline = region.parentElement?.previousElementSibling;
    if (timeline && timeline.clientHeight > 0) {
      const timelineRect = timeline.getBoundingClientRect();
      const gapCardsWheel = Math.abs(band.top - timelineRect.bottom - 4);
      if (gapCardsWheel > 1) issues.push(`Gap cartes/roue anormal : ${(band.top - timelineRect.bottom).toFixed(1)} px (attendu 4 px ±1)`);
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('Overflow horizontal document');
    return issues;
  }), 'Géométrie au repos : boutons, labels et compteur réellement visibles').toEqual([]);
}

for (const viewport of viewports) {
  for (const count of [0, 1, 3, 4, 8, 12]) {
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
  const dragLocator = page.locator('[data-wheel-drag], div.top-\\[28px\\]\\.h-\\[288px\\], div.top-\\[36px\\]\\.h-\\[288px\\]').first();
  await expect(dragLocator).toBeVisible();
  const wheel = await page.getByRole('region', { name: 'Navigation des squads' }).boundingBox();
  expect(wheel).not.toBeNull();
  const box = await dragLocator.boundingBox();
  expect(box).not.toBeNull();

  // Attendre la stabilisation avant de démarrer le contact
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

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
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
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
      await expect(trigger).toHaveAttribute('aria-label', squad.name);
      await trigger.tap();
      await expect(page).toHaveURL(`/squad/${squad.id}`);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      isolation.assertIsolated();
    });
  }
}

test('ID courant en page 4, navigation clavier directe sans dialogue', async ({ context, page }) => {
  const squads = makeSquads(12);
  const isolation = await installUxFixtures(context, { squads, currentSquadId: 900012 });
  await page.goto('/squad/900012');
  const wheel = page.getByRole('region');
  await expect(wheel.getByText('Page 4/4', { exact: true })).toBeVisible();
  const trigger = wheel.getByRole('button', { name: squads[11].name, exact: true });
  await expect(trigger).toHaveAttribute('aria-current', 'page');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/squad/900012');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(wheel.getByText('Page 3/4', { exact: true })).toBeVisible();
  const next = wheel.getByRole('button', { name: squads[6].name, exact: true });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/squad/${squads[6].id}`);
  await expect(page.getByRole('dialog')).toHaveCount(0);
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

test('rendering complet du mot de 120 caractères et des initiales longues sans troncature ni scrollWidth caché', async ({ context, page }) => {
  const squads = makeSquads(3);
  const isolation = await installUxFixtures(context, { squads });
  await page.goto('/squad/900001');
  const wheel = page.getByRole('region', { name: 'Navigation des squads' });
  await expect(wheel).toBeVisible();

  // Mot long de 120 caractères
  const longWord = 'S'.repeat(120);
  const longLabel = wheel.locator('[data-wheel-label][data-squad-id="900003"]');
  await expect(longLabel).toBeVisible();
  await expect(longLabel).toHaveText(longWord);

  // Initiales longues d\'équipe multi-mots
  const initialsLabel = wheel.locator('[data-wheel-label][data-squad-id="900001"]');
  await expect(initialsLabel).toBeVisible();
  await expect(initialsLabel).toHaveText('LADQ—ÉDV');

  // Aucun scrollWidth caché
  const scrollIssues = await wheel.evaluate(el => {
    const labels = el.querySelectorAll<HTMLElement>('[data-wheel-label]');
    const bad: string[] = [];
    for (const l of labels) {
      if (l.scrollWidth > Math.ceil(l.clientWidth) + 1) {
        bad.push(`${l.textContent}: scrollWidth=${l.scrollWidth} > clientWidth=${l.clientWidth}`);
      }
    }
    return bad;
  });
  expect(scrollIssues).toEqual([]);
  isolation.assertIsolated();
});

test('gaps réels cartes/roue/barre et fond opaque en jour/nuit avec captures', async ({ context, page }) => {
  const squads = makeSquads(3);
  const isolation = await installUxFixtures(context, { squads });
  const resultsDir = process.env.BEERCALL_USAGE_RESULTS ?? resolve(__dirname, '../../../temp/usage-results');

  // 1. Thème Jour (14h)
  await page.clock.install({ time: new Date('2026-10-25T14:00:00') });
  await page.goto('/squad/900001');
  const wheel = page.getByRole('region', { name: 'Navigation des squads' });
  await expect(wheel).toBeVisible();
  await assertWheelGeometry(wheel);
  const dayLabel = await wheel.locator('[data-wheel-label]').first().evaluate(el => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      background: style.backgroundColor,
      decorated: style.textShadow !== 'none' || style.filter !== 'none',
    };
  });
  const dayIdentityColor = await page.locator('[data-dashboard-identity] h2').evaluate(el => getComputedStyle(el).color);
  expect(dayLabel.color, 'label jour synchronisé avec le badge').toBe(dayIdentityColor);
  await expect(wheel.locator('[data-wheel-label]').first()).toHaveClass(/text-gray-900/);
  expect(dayLabel.background, 'aucun rectangle opaque de jour').toBe('rgba(0, 0, 0, 0)');
  expect(dayLabel.decorated, 'halo clair de jour').toBe(true);

  // Mesurer cartes/roue=4 px ±1 et roue/barre=0 px
  const gaps = await wheel.evaluate(el => {
    const band = el.getBoundingClientRect();
    const bar = el.nextElementSibling;
    const barRect = bar ? bar.getBoundingClientRect() : null;
    const timeline = el.parentElement?.previousElementSibling;
    const timelineRect = timeline ? timeline.getBoundingClientRect() : null;
    return {
      cardsWheelGap: timelineRect ? band.top - timelineRect.bottom : null,
      wheelBarGap: barRect ? barRect.top - band.bottom : null,
    };
  });
  expect(gaps.cardsWheelGap).not.toBeNull();
  expect(Math.abs(gaps.cardsWheelGap! - 4)).toBeLessThanOrEqual(1);
  expect(gaps.wheelBarGap).not.toBeNull();
  expect(Math.abs(gaps.wheelBarGap!)).toBeLessThanOrEqual(1);

  // Capture jour
  await page.screenshot({ path: resolve(resultsDir, 'wheel-day.png') });

  // 2. Thème Nuit (23h)
  await page.clock.setFixedTime(new Date('2026-10-25T23:00:00'));
  await page.reload();
  await expect(wheel).toBeVisible();
  await assertWheelGeometry(wheel);
  const nightLabel = await wheel.locator('[data-wheel-label]').first().evaluate(el => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      background: style.backgroundColor,
      decorated: style.textShadow !== 'none' || style.filter !== 'none',
    };
  });
  const nightIdentityColor = await page.locator('[data-dashboard-identity] h2').evaluate(el => getComputedStyle(el).color);
  expect(nightLabel.color, 'label nuit synchronisé avec le badge').toBe(nightIdentityColor);
  await expect(wheel.locator('[data-wheel-label]').first()).toHaveClass(/text-beer-light/);
  expect(nightLabel.color, 'label nuit en beer-light (#FBBF24)').toBe('rgb(251, 191, 36)');
  expect(nightLabel.background, 'aucun rectangle opaque de nuit').toBe('rgba(0, 0, 0, 0)');
  expect(nightLabel.decorated, 'ombre sombre de nuit').toBe(true);

  // Capture nuit
  await page.screenshot({ path: resolve(resultsDir, 'wheel-night.png') });
  isolation.assertIsolated();
});

for (const count of [0, 1, 3, 4, 12]) {
  test(`cas ${count} squads : pagination et retour sur page active`, async ({ context, page }) => {
    const squads = makeSquads(count);
    const targetSquad = count > 0 ? squads[count - 1] : null;
    const pageCount = Math.max(1, Math.ceil(count / 3));
    const isolation = await installUxFixtures(context, { squads, currentSquadId: targetSquad?.id });

    await page.goto(targetSquad ? `/squad/${targetSquad.id}` : '/dashboard');
    const wheel = page.getByRole('region', { name: 'Navigation des squads' });
    await expect(wheel).toBeVisible();

    if (count > 0 && pageCount > 1) {
      // Directement sur la page de la squad active
      await expect(wheel.getByText(`Page ${pageCount}/${pageCount}`, { exact: true })).toBeVisible();
      await expect(wheel.getByRole('button', { name: targetSquad!.name, exact: true })).toBeVisible();

      // Naviguer vers la première page
      for (let p = pageCount; p > 1; p--) {
        await wheel.getByRole('button', { name: 'Page précédente' }).tap();
      }
      await expect(wheel.getByText(`Page 1/${pageCount}`, { exact: true })).toBeVisible();

      // Retour sur la page active par navigation
      await page.goto(`/squad/${targetSquad!.id}`);
      await expect(wheel.getByText(`Page ${pageCount}/${pageCount}`, { exact: true })).toBeVisible();
      await expect(wheel.getByRole('button', { name: targetSquad!.name, exact: true })).toBeVisible();
    } else if (count > 0) {
      await expect(wheel.getByRole('button', { name: targetSquad!.name, exact: true })).toBeVisible();
    } else {
      await expect(wheel.getByRole('button', { name: 'Créer', exact: true })).toBeVisible();
      await expect(wheel.getByRole('button', { name: 'Rejoindre', exact: true })).toBeVisible();
    }
    await assertWheelGeometry(wheel);
    isolation.assertIsolated();
  });
}
