import { test, expect } from '@playwright/test';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function verifyPngBuffer(buf: Buffer, expectedSize: number) {
  expect(buf.length, 'Taille de fichier PNG non vide').toBeGreaterThan(33);
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'Signature magique PNG valide').toBe(true);

  const ihdrLength = buf.readUInt32BE(8);
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  expect(ihdrLength, 'Longueur chunk IHDR').toBe(13);
  expect(ihdrType, 'Nom de chunk IHDR').toBe('IHDR');

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];

  expect(width, `Largeur attendue ${expectedSize}`).toBe(expectedSize);
  expect(height, `Hauteur attendue ${expectedSize}`).toBe(expectedSize);
  expect([2, 6], 'Type de couleur RGB (2) ou RGBA (6)').toContain(colorType);
  expect(bitDepth, 'Profondeur de bits').toBe(8);
}

test.describe('PWA & Métadonnées iOS (UI-05)', () => {
  test('HTML d’entrée : référence exactement un manifeste webmanifest et les métadonnées iOS canoniques', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), 'Statut HTTP 200 sur le point d’entrée').toBe(200);
    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType, 'Content-Type HTML sur /').toContain('text/html');

    const html = await res.text();

    // 1. Exactement un lien manifest vers /manifest.webmanifest
    const manifestLinks = html.match(/<link[^>]+rel=["']manifest["'][^>]*>/gi) ?? [];
    expect(manifestLinks, 'Exactement un lien <link rel="manifest"> dans le HTML').toHaveLength(1);
    expect(manifestLinks[0], 'Le lien cible manifest.webmanifest').toMatch(/href=["'][^"']*manifest\.webmanifest["']/i);

    // 2. Aucun lien vers l'ancien manifest.json
    expect(html, 'Aucune référence à manifest.json dans le HTML').not.toContain('manifest.json');

    // 3. Apple touch icon 180x180 PNG
    const appleIconLinks = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]*>/gi) ?? [];
    expect(appleIconLinks, 'Exactement un lien <link rel="apple-touch-icon">').toHaveLength(1);
    expect(appleIconLinks[0], 'Apple touch icon cible apple-touch-icon-180.png').toContain('/apple-touch-icon-180.png');
    expect(appleIconLinks[0], 'Sizes="180x180" spécifié').toContain('sizes="180x180"');

    // 4. Métadonnées Apple web app
    expect(html).toMatch(/<meta[^>]+name=["']apple-mobile-web-app-capable["'][^>]+content=["']yes["']/i);
    expect(html).toMatch(/<meta[^>]+name=["']apple-mobile-web-app-status-bar-style["'][^>]+content=["']black-translucent["']/i);
    expect(html).toMatch(/<meta[^>]+name=["']apple-mobile-web-app-title["'][^>]+content=["']BeerCall["']/i);

    // 5. Thème et viewport adaptés mobile
    expect(html).toMatch(/<meta[^>]+name=["']theme-color["'][^>]+content=["']#0F081C["']/i);
    expect(html).toMatch(/<meta[^>]+name=["']viewport["'][^>]+content=["'][^"']*viewport-fit=cover[^"']*["']/i);
  });

  test('Manifeste PWA : servi en HTTP avec Content-Type valide et structure canonique', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status(), 'Statut HTTP 200 sur manifest.webmanifest').toBe(200);

    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType, 'Content-Type application/manifest+json').toContain('application/manifest+json');

    const manifest = await res.json();
    expect(manifest.name, 'Nom dans le manifeste').toBe('BeerCall');
    expect(manifest.short_name, 'Nom court dans le manifeste').toBe('BeerCall');
    expect(manifest.start_url, 'start_url racine').toBe('/');
    expect(manifest.scope, 'scope racine').toBe('/');
    expect(manifest.display, 'Affichage standalone').toBe('standalone');
    expect(manifest.orientation, 'Orientation portrait').toBe('portrait');
    expect(manifest.background_color, 'Fond opaque #0F081C').toBe('#0F081C');
    expect(manifest.theme_color, 'Thème #0F081C').toBe('#0F081C');

    // Vérification des icônes obligatoires du manifeste
    const icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> = manifest.icons ?? [];
    expect(icons.length, 'Au moins 4 entrées d’icônes (any et maskable)').toBeGreaterThanOrEqual(4);

    const icon192Any = icons.find(i => i.src === '/pwa-192x192.png' && i.sizes === '192x192' && i.type === 'image/png' && i.purpose === 'any');
    const icon192Maskable = icons.find(i => i.src === '/pwa-192x192.png' && i.sizes === '192x192' && i.type === 'image/png' && i.purpose === 'maskable');
    const icon512Any = icons.find(i => i.src === '/pwa-512x512.png' && i.sizes === '512x512' && i.type === 'image/png' && i.purpose === 'any');
    const icon512Maskable = icons.find(i => i.src === '/pwa-512x512.png' && i.sizes === '512x512' && i.type === 'image/png' && i.purpose === 'maskable');

    expect(icon192Any, 'Icône 192x192 purpose any présente').toBeDefined();
    expect(icon192Maskable, 'Icône 192x192 purpose maskable présente').toBeDefined();
    expect(icon512Any, 'Icône 512x512 purpose any présente').toBeDefined();
    expect(icon512Maskable, 'Icône 512x512 purpose maskable présente').toBeDefined();
  });

  test('Icônes raster : servies en HTTP avec MIME image/png, signature et dimensions exactes sans fallback HTML', async ({ request }) => {
    const targets = [
      { path: '/apple-touch-icon-180.png', size: 180 },
      { path: '/pwa-192x192.png', size: 192 },
      { path: '/pwa-512x512.png', size: 512 },
    ];

    for (const target of targets) {
      const res = await request.get(target.path);
      expect(res.status(), `Statut 200 pour ${target.path}`).toBe(200);

      const contentType = res.headers()['content-type'] ?? '';
      expect(contentType, `Content-Type image/png strict pour ${target.path}`).toBe('image/png');
      expect(contentType, `Jamais de fallback HTML pour ${target.path}`).not.toContain('text/html');

      const buf = await res.body();
      verifyPngBuffer(buf, target.size);
    }
  });

  test('Ancien manifeste : /manifest.json retourne HTTP 404 sans fallback silencieux vers index.html', async ({ request }) => {
    const res = await request.get('/manifest.json');
    expect(res.status(), 'Statut 404 sur l’ancien manifeste supprimé').toBe(404);

    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType, 'Aucun fallback HTML sur le 404').not.toContain('text/html');
  });
});
