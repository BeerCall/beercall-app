import { test, expect, type Locator } from '@playwright/test';
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
    const border = await heading.evaluate(el => getComputedStyle(el.parentElement!.parentElement!).borderTopColor);
    expect(border).toBe(`rgba(${rgb.join(', ')}, 0.25)`);
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
