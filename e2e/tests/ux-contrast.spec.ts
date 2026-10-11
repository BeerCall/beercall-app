import { test, expect, type Locator, type Page } from '@playwright/test';
import { installUxFixtures, makeSquads } from './support/uxFixtures';

test.use({ viewport: { width: 390, height: 844 }, trace: 'off' });

async function measurePair(locator: Locator, label: string, allowComposite = false) {
  await expect(locator, `Paire présente : ${label}`).toBeVisible();
  const pair = await locator.evaluate((el, composite) => {
    if (el.closest(':disabled, [aria-disabled="true"]')) throw new Error('Une paire disabled ne certifie pas un état actif');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Conversion sRGB indisponible');
    const rgba = (css: string): [number, number, number, number] => {
      if (!CSS.supports('color', css)) throw new Error(`Couleur CSS inconnue : ${css}`);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const data = ctx.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    };
    const text = getComputedStyle(el);
    const layers: { tag: string; css: string; rgba: [number, number, number, number] }[] = [];
    let cursor: Element | null = el, opacity = 1, opaque = false;
    while (cursor) {
      const style = getComputedStyle(cursor);
      opacity *= Number(style.opacity);
      if (!opaque) {
        if (style.backgroundImage !== 'none') throw new Error('Fond image/gradient non certifié');
        if (cursor.querySelector('canvas')) throw new Error('Composition atteignant un canvas non certifié');
        const color = rgba(style.backgroundColor);
        if (color[3] > 0) {
          if (!composite && color[3] !== 1) throw new Error('Paire non opaque');
          layers.push({ tag: cursor.tagName, css: style.backgroundColor, rgba: color });
        }
        opaque = color[3] === 1;
      }
      cursor = cursor.parentElement;
    }
    if (!opaque) throw new Error('Aucun fond CSS opaque certifié');
    let background: [number, number, number, number] = [0, 0, 0, 0];
    for (const layer of [...layers].reverse()) {
      const source = layer.rgba;
      const alpha = source[3] + background[3] * (1 - source[3]);
      background = [
        (source[0] * source[3] + background[0] * background[3] * (1 - source[3])) / alpha,
        (source[1] * source[3] + background[1] * background[3] * (1 - source[3])) / alpha,
        (source[2] * source[3] + background[2] * background[3] * (1 - source[3])) / alpha,
        alpha,
      ];
    }
    return { foreground: rgba(text.color), background, color: text.color, layers, opacity,
      fontSize: parseFloat(text.fontSize), fontWeight: parseFloat(text.fontWeight) };
  }, allowComposite);
  const luminance = (color: number[]) => {
    const linear = color.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(pair.foreground), b = luminance(pair.background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const threshold = pair.fontSize >= 24 || (pair.fontSize >= 18.67 && pair.fontWeight >= 700) ? 3 : 4.5;
  expect(pair.opacity, `${label} : opacité de toute la chaîne DOM`).toBe(1);
  expect(pair.foreground[3], `${label} : texte opaque`).toBe(1);
  expect(pair.background[3], `${label} : fond certifié opaque`).toBe(1);
  expect(ratio, `${label} : ratio requis ${threshold}`).toBeGreaterThanOrEqual(threshold);
  console.log(JSON.stringify({ label, ratio, threshold, ...pair }));
  return { ratio, ...pair };
}

for (const color of ['#F59E0B', '#EF4444', '#10B981', '#3B82F6', '#8B5CF6', '#EC4899']) {
  test(`titre lisible et couleur de squad conservée ${color}`, async ({ context, page }) => {
    const squads = makeSquads(1);
    squads[0].color = color;
    const isolation = await installUxFixtures(context, { squads });
    await page.goto('/squad/900001');
    const heading = page.getByRole('heading', { name: squads[0].name, exact: true });
    const pair = await measurePair(heading, `Titre ${color}`);
    expect(pair.foreground.slice(0, 3)).toEqual([16, 24, 40]);
    expect(pair.background.slice(0, 3)).toEqual([255, 255, 255]);
    const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
    await expect(heading).toHaveCSS('font-size', '20px');
    await expect(heading.locator('xpath=../..'), 'Couleur API exacte après la transition CSS')
      .toHaveCSS('border-top-color', `rgba(${rgb.join(', ')}, 0.25)`);
    isolation.assertIsolated();
  });
}

test('labels de création sur fond blanc', async ({ context, page }) => {
  const isolation = await installUxFixtures(context);
  await page.goto('/squad/900001');
  await page.getByRole('button', { name: 'Créer', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'Nouvelle Squad' })).toBeVisible();
  await measurePair(page.getByText('Choisir un Emblème', { exact: true }), 'Label emblème');
  await measurePair(page.getByText("Couleur d'Étendard", { exact: true }), 'Label couleur');
  isolation.assertIsolated();
});

test.describe('Navigation au pointeur : états normal et hover réellement actifs', () => {
  test.use({ hasTouch: false });
  test('Connexions et Sign Out', async ({ context, page }) => {
    const isolation = await installUxFixtures(context);
    await page.goto('/squad/900001');
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
    for (const [name, token] of [['Connexions', '--color-amber-800'], ['Sign Out', '--color-red-700']]) {
      const button = page.getByRole('button', { name, exact: true });
      const label = button.locator('span');
      await page.mouse.move(0, 0);
      const normal = await measurePair(label, `${name} normal`);
      await button.hover();
      const target = await page.evaluate(tokenName => {
        const element = document.createElement('span');
        element.style.color = getComputedStyle(document.documentElement).getPropertyValue(tokenName);
        document.body.append(element);
        const color = getComputedStyle(element).color;
        element.remove();
        return color;
      }, token);
      await expect(label).toHaveCSS('color', target);
      const hovered = await measurePair(label, `${name} hover`);
      expect(hovered.foreground).not.toEqual(normal.foreground);
    }
    isolation.assertIsolated();
  });
});

async function measureWardrobe(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  return measurePair(locator, label, true);
}

async function enterSignup(page: Page) {
  await page.goto('/signup');
  await page.getByPlaceholder('Pseudo', { exact: true }).fill('FixtureUser');
  await page.getByPlaceholder('Mot de passe', { exact: true }).fill('Fixture123');
  await page.getByRole('button', { name: "CRÉER L'AVATAR" }).tap();
  await expect(page.getByRole('heading', { name: 'Vestiaire', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Créer mon compte', exact: true })).toBeEnabled();
}

async function loadedIdle(page: Page) {
  const tab = page.getByRole('button', { name: /Anim$/ });
  await tab.scrollIntoViewIfNeeded();
  await tab.focus();
  await tab.press('Enter');
  await expect(tab, 'Onglet Anim réellement sélectionné avant mesure').toHaveClass(/bg-gray-900/);
  const idle = page.getByRole('button', { name: 'Idle', exact: true });
  await expect(idle, 'Animation issue du FBX réel, pas injectée par le test').toBeVisible();
  await expect(idle).toBeEnabled();
  return idle;
}

test('profil propre : sous-titre, article équipé, badges et rang', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { profileMode: 'own', assets: true });
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Vestiaire', exact: true })).toBeVisible();
  await measureWardrobe(page.getByText(/Personnalise ton/), 'Profil sous-titre');
  await measureWardrobe(page.getByText('Sans couvre-chef', { exact: true }), 'Profil article équipé');
  await measureWardrobe(page.getByText('Équipé', { exact: true }), 'Profil Équipé');
  await measureWardrobe(page.getByText('Possédé', { exact: true }), 'Profil Possédé');
  await measurePair(page.getByText('Rang test', { exact: true }), 'Profil rang');
  const idle = await loadedIdle(page);
  await expect(idle).toHaveClass(/border-beer/);
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('profil propre : animation Idle sélectionnée et Aucun', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { profileMode: 'own', assets: true });
  await page.goto('/profile');
  const idle = await loadedIdle(page);
  await expect(idle).toHaveClass(/border-beer/);
  await measureWardrobe(idle.locator('span').first(), 'Profil Idle sélectionné');
  await page.getByRole('button', { name: /Accessoire$/ }).tap();
  await expect(page.getByRole('button', { name: /Aucun/ })).toHaveClass(/border-beer/);
  await measureWardrobe(page.getByText('Aucun', { exact: true }), 'Profil Aucun sélectionné');
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('signup : sous-titre, tenue initiale et article à essayer', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { authenticated: false, assets: true });
  await enterSignup(page);
  await measureWardrobe(page.getByText(/Personnalise ton/), 'Signup sous-titre');
  await measureWardrobe(page.getByText('Sans couvre-chef', { exact: true }), 'Signup article initial');
  await measureWardrobe(page.getByText('Tenue initiale', { exact: true }), 'Signup Tenue initiale');
  await measureWardrobe(page.getByText('À essayer', { exact: true }), 'Signup À essayer');
  await expect(page.getByText('Possédé', { exact: true })).toHaveCount(0);
  await loadedIdle(page);
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('signup : genres sélectionné/inactif, dans les deux états', async ({ context, page }) => {
  // The editable profile has no gender switch; these controls belong to signup.
  const isolation = await installUxFixtures(context, { authenticated: false, assets: true });
  await enterSignup(page);
  const men = page.getByRole('button', { name: 'Homme', exact: true });
  const women = page.getByRole('button', { name: 'Femme', exact: true });
  await expect(men).toHaveClass(/bg-white/);
  await measurePair(men, 'Signup Homme sélectionné');
  await measurePair(women, 'Signup Femme inactive');
  await women.tap();
  await expect(women).toHaveClass(/bg-white/);
  await measurePair(women, 'Signup Femme sélectionnée');
  await measurePair(men, 'Signup Homme inactif');
  await expect(page.getByText('Sans couvre-chef', { exact: true })).toHaveCount(0);
  await loadedIdle(page);
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('signup : Idle choisi depuis le FBX et Aucun', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { authenticated: false, assets: true });
  await enterSignup(page);
  const idle = await loadedIdle(page);
  await idle.tap();
  await expect(idle).toHaveClass(/border-beer/);
  await measureWardrobe(idle.locator('span').first(), 'Signup Idle sélectionné');
  await page.getByRole('button', { name: /Accessoire$/ }).tap();
  await expect(page.getByRole('button', { name: /Aucun/ })).toHaveClass(/border-beer/);
  await measureWardrobe(page.getByText('Aucun', { exact: true }), 'Signup Aucun sélectionné');
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('profil tiers : rang et informations, sans vestiaire fictif', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { profileMode: 'readonly', assets: true });
  await page.goto('/profile/900002');
  await expect(page.getByRole('heading', { name: 'FixtureUser', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Statistiques', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vestiaire', exact: true })).toHaveCount(0);
  await measurePair(page.getByText('Rang test', { exact: true }), 'Profil tiers rang');
  await expect.poll(() => isolation.assetHits.fbx).toBeGreaterThan(0);
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test.describe('Carte vide : lisibilité identique jour et nuit', () => {
  test.use({ timezoneId: 'Europe/Paris' });
  test('surface opaque à 12h et 22h, styles cartographiques distincts', async ({ context, page }) => {
    const isolation = await installUxFixtures(context, { calls: [] });
    const styles: string[] = [];
    context.on('request', request => {
      if (request.url().includes('basemaps.cartocdn.com/gl/') && request.url().endsWith('/style.json')) styles.push(request.url());
    });
    const ratios: number[] = [];
    for (const hour of [12, 22]) {
      await page.clock.setFixedTime(new Date(`2026-10-11T${hour === 12 ? '10' : '20'}:00:00Z`));
      const response = page.waitForResponse(r => /\/api\/squads\/900001\/?$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
      await page.goto('/squad/900001');
      expect((await response).status(), 'Un vrai succès squad précède le vide').toBe(200);
      expect(await page.evaluate(() => new Date().getHours())).toBe(hour);
      const text = page.getByText(/Aucun événement/);
      await expect(text).toBeVisible();
      const surface = await text.evaluate(el => {
        const card = el.parentElement!;
        const style = getComputedStyle(card), r = card.getBoundingClientRect();
        return { opacity: Number(style.opacity), background: style.backgroundColor, width: r.width, height: r.height };
      });
      expect(surface).toEqual({ opacity: 1, background: 'rgb(255, 255, 255)', width: 220, height: 130 });
      const pair = await measurePair(text, `Carte vide ${hour}h`);
      expect(pair.background).toEqual([255, 255, 255, 1]);
      expect(pair.foreground.slice(0, 3)).toEqual([54, 65, 83]);
      ratios.push(pair.ratio);
      const expectedStyle = `https://basemaps.cartocdn.com/gl/${hour === 12 ? 'positron' : 'dark-matter'}-gl-style/style.json`;
      await expect.poll(() => styles.includes(expectedStyle), `Carte ${hour === 12 ? 'diurne' : 'nocturne'} réellement demandée`).toBe(true);
      isolation.assertIsolated();
    }
    expect(ratios[0]).toBe(ratios[1]);
    expect(new Set(styles).size).toBe(2);
    console.log(JSON.stringify({ label: 'Carte vide jour/nuit', ratios, styles }));
  });
});
