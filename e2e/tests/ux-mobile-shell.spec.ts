import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { installUxFixtures, makeSquads } from './support/uxFixtures';

const isChromium = (page: Page) => page.context().browser()?.browserType().name() === 'chromium';

async function cdpSwipe(page: Page, box: { x: number; y: number; width: number; height: number }, dx: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX + (dx * step) / 8, y: startY + (dy * step) / 8, id: 1 }],
      });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    }
    // Contact immobile réel avant relâchement : Chromium ne doit pas lire le tap
    // suivant comme la fin d'un flick.
    await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 120)));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  } finally {
    await cdp.detach();
  }
}

async function applySafeAreaInsets(context: BrowserContext, top: number, bottom: number) {
  await context.route('**/*.css', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(/env\(\s*safe-area-inset-top(?:\s*,[^)]*)?\s*\)/g, `${top}px`)
      .replace(/env\(\s*safe-area-inset-bottom(?:\s*,[^)]*)?\s*\)/g, `${bottom}px`)
      .replace(/env\(\s*safe-area-inset-left(?:\s*,[^)]*)?\s*\)/g, '0px')
      .replace(/env\(\s*safe-area-inset-right(?:\s*,[^)]*)?\s*\)/g, '0px');
    await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/css; charset=utf-8' } });
  });
}

test.describe('Mobile Shell & Confinement des gestes (UX-03)', () => {
  test('drag vers le bas sur la barre de navigation : window.scrollY reste à 0, aucun reload ni pull-to-refresh', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(3) });

    await page.goto('/squad/900001');

    const bottomNav = page.locator('[data-bottom-nav]');
    await expect(bottomNav).toBeVisible();

    // 1. Détection des rechargements et requêtes document après navigation initiale
    let pageReloads = 0;
    page.on('load', () => { pageReloads++; });
    let documentRequests = 0;
    page.on('request', request => { if (request.resourceType() === 'document') documentRequests++; });

    // 2. Vérification des classes de protection sur la barre
    const navClasses = (await bottomNav.getAttribute('class')) ?? '';
    expect(navClasses, 'touch-none présent sur la barre').toContain('touch-none');
    expect(navClasses, 'overscroll-none présent sur la barre').toContain('overscroll-none');

    // 3. Confinement initial du document racine
    expect(await page.evaluate(() => window.scrollY), 'Scroll initial à 0').toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollTop), 'scrollTop initial à 0').toBe(0);

    const box = await bottomNav.boundingBox();
    expect(box, 'Bounding box de data-bottom-nav disponible').not.toBeNull();

    // 4. Dix glissements tactiles réels vers le bas.
    // Chromium : Input.dispatchTouchEvent (confiance navigateur). WebKit : aucun
    // équivalent CDP dans Playwright ; limite annoncée, geste natif laissé à T13.
    if (isChromium(page)) {
      for (let cycle = 0; cycle < 10; cycle++) {
        await cdpSwipe(page, box!, 0, 180);
        expect(await page.evaluate(() => window.scrollY), `cycle ${cycle + 1} confiné`).toBe(0);
      }
    } else {
      test.info().annotations.push({
        type: 'limite WebKit',
        description: 'Pas de CDP Input.dispatchTouchEvent : le scroll natif iOS n\'est pas simulé ici (T13).',
      });
    }

    // Attente brève de stabilisation
    await page.waitForTimeout(100);

    // 5. Assertions de non-débordement et d'absence de reload
    expect(await page.evaluate(() => window.scrollY), 'window.scrollY confiné à 0 après 10 drags').toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollTop), 'document.documentElement.scrollTop confiné à 0').toBe(0);

    const docMetrics = await page.evaluate(() => ({
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.clientHeight,
    }));
    // Tolérance d'un pixel pour les arrondis subpixel des viewports à densité d'affichage élevée
    expect(docMetrics.scrollHeight, 'scrollHeight confiné dans la hauteur client').toBeLessThanOrEqual(docMetrics.clientHeight + 1);

    expect(pageReloads, 'Aucun rechargement de document provoqué par les drags').toBe(0);
    expect(documentRequests, 'Aucune requête document après la navigation initiale').toBe(0);
  });

  test('taps de navigation : parcours Connexions / Profil et retour fonctionnels', async ({ context, page }) => {
    await installUxFixtures(context, {
      profileMode: 'own',
      squads: makeSquads(2),
      simulations: [
        {
          method: 'GET',
          path: '/api/auth/connections/',
          respond: async (route) => {
            const friends = Array.from({ length: 10 }, (_, i) => ({
              id: `friend_${i + 1}`,
              username: `Ami ${i + 1}`,
              caps: 100,
              score: 42,
              title: 'Pilier',
              avatar: { head: 'none', body: 'none', legs: 'none', feet: 'none', accessory: 'none', gender: 'Men' as const },
            }));
            await route.fulfill({ status: 200, json: friends });
          },
        },
      ],
    });

    await page.goto('/squad/900001');

    // 1. Navigation vers Connexions
    const connectionsBtn = page.getByRole('button', { name: /Connexions/i });
    await expect(connectionsBtn).toBeVisible();
    await connectionsBtn.tap();

    await expect(page).toHaveURL(/\/connections/);
    await expect(page.getByRole('heading', { name: /Connexions/i })).toBeVisible();

    // Retour via le bouton arrière
    const backBtnConnections = page.locator('header button').first();
    await expect(backBtnConnections).toBeVisible();
    await backBtnConnections.tap();

    await expect(page).toHaveURL(/\/squad\/900001/);

    // 2. Navigation vers Profil
    const profileBtn = page.getByRole('button', { name: /Profil/i });
    await expect(profileBtn).toBeVisible();
    await profileBtn.tap();

    await expect(page).toHaveURL(/\/profile/);
    await expect(page.getByText(/FixtureUser/i).first()).toBeVisible();
    // Le contenu du profil reste dans la largeur utile, sans scroll horizontal.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Retour depuis le profil via le bouton chevron gauche
    const backBtnProfile = page.locator('button').filter({ has: page.locator('svg.lucide-chevron-left') }).first();
    await expect(backBtnProfile).toBeVisible();
    await backBtnProfile.tap();

    await expect(page).toHaveURL(/\/squad\/900001/);
  });

  test('scroll interne : la liste des connexions défile sans rompre le confinement racine', async ({ context, page }) => {
    await installUxFixtures(context, {
      squads: makeSquads(2),
      simulations: [
        {
          method: 'GET',
          path: '/api/auth/connections/',
          respond: async (route) => {
            const friends = Array.from({ length: 25 }, (_, i) => ({
              id: `friend_${i + 1}`,
              username: `Compagnon ${i + 1}`,
              caps: 120,
              score: 50,
              title: 'Pilier',
              avatar: { head: 'none', body: 'none', legs: 'none', feet: 'none', accessory: 'none', gender: 'Men' as const },
            }));
            await route.fulfill({ status: 200, json: friends });
          },
        },
      ],
    });

    await page.goto('/connections');
    await expect(page.getByRole('heading', { name: /Connexions/i })).toBeVisible();

    const scrollableList = page.locator('div.overflow-y-auto');
    await expect(scrollableList).toBeVisible();

    // Vérifier que le contenu déborde la zone scrollable interne
    const initialMetrics = await scrollableList.evaluate(el => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    }));
    expect(initialMetrics.scrollHeight, 'Liste scrollable plus haute que le conteneur').toBeGreaterThan(initialMetrics.clientHeight);
    expect(initialMetrics.scrollTop, 'scrollTop initial à 0').toBe(0);

    // Défiler vers le bas à l'intérieur du conteneur
    await scrollableList.evaluate(el => {
      el.scrollTop = 200;
      el.dispatchEvent(new Event('scroll'));
    });

    const scrolledTop = await scrollableList.evaluate(el => el.scrollTop);
    expect(scrolledTop, 'Défilement interne réussi').toBeGreaterThan(0);

    // Le document racine ne doit pas avoir bougé d'un seul pixel
    expect(await page.evaluate(() => window.scrollY), 'window.scrollY reste absolument à 0').toBe(0);
  });

  test('swipe de la roulette : transition de page tactile (CDP Chromium) ou commandes utilisables (WebKit)', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(6) });
    await page.goto('/squad/900001');

    const dragLocator = page.locator('[data-wheel-drag]');
    await expect(dragLocator).toBeVisible();

    await expect(page.getByText(/Page 1\/2/)).toBeVisible();

    const box = await dragLocator.boundingBox();
    expect(box).not.toBeNull();

    if (isChromium(page)) {
      // Le conteneur motion mesure 288px mais sa moitié basse est clippée par la
      // bande de 118px : le geste doit partir dans la partie réellement visible.
      const visibleBand = { x: box!.x, y: box!.y + 30, width: box!.width, height: 58 };
      // Glissement vers la gauche pour passer à la page 2 : geste navigateur réel.
      await cdpSwipe(page, visibleBand, -220, 0);
      await expect(page.getByText(/Page 2\/2/)).toBeVisible();

      // Glissement inverse vers la droite pour revenir à la page 1.
      await cdpSwipe(page, visibleBand, 220, 0);
      await expect(page.getByText(/Page 1\/2/)).toBeVisible();
    } else {
      test.info().annotations.push({
        type: 'limite WebKit',
        description: 'Pas de CDP touch : le swipe natif de la roue n\'est pas rejoué ici (T13). Les commandes restent actionnables au tap.',
      });
      await page.getByRole('button', { name: 'Page suivante', exact: true }).tap();
      await expect(page.getByText(/Page 2\/2/)).toBeVisible();
      await page.getByRole('button', { name: 'Page précédente', exact: true }).tap();
      await expect(page.getByText(/Page 1\/2/)).toBeVisible();
    }

    // La navigation de page ne recharge ni ne fait défiler le document.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page).toHaveURL('/squad/900001');
  });

  test('clavier et saisie modale : focus, saisie et fermeture sans rupture de layout', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(2) });
    await page.goto('/squad/900001');

    // Ouverture de la modale Nouvelle Squad au tap réel
    const createBtn = page.getByRole('button', { name: 'Créer', exact: true });
    await expect(createBtn).toBeVisible();
    await createBtn.tap();

    await expect(page.getByRole('heading', { name: 'Nouvelle Squad' })).toBeVisible();

    const input = page.getByPlaceholder('Nom de la Squad...');
    await expect(input).toBeVisible();

    // Focus et saisie au clavier
    await input.focus();
    await input.fill('Squad Mobile Test');
    await page.keyboard.type(' !');

    await expect(input).toHaveValue('Squad Mobile Test !');

    // Confinement strict maintenu pendant la saisie
    expect(await page.evaluate(() => window.scrollY), 'window.scrollY reste à 0').toBe(0);

    // Fermeture de la modale via un tap réel sur la croix
    const closeBtn = page.getByRole('button', { name: 'Fermer', exact: true });
    await expect(closeBtn).toBeVisible();
    const closeBox = await closeBtn.boundingBox();
    expect(closeBox, 'Croix mesurable').not.toBeNull();
    expect(closeBox!.width, 'Cible de fermeture >=44px').toBeGreaterThanOrEqual(44);
    expect(closeBox!.height, 'Cible de fermeture >=44px').toBeGreaterThanOrEqual(44);
    expect(closeBox!.x).toBeGreaterThanOrEqual(0);
    expect(closeBox!.y).toBeGreaterThanOrEqual(0);
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 0.5);
    await closeBtn.tap();

    await expect(page.getByRole('heading', { name: 'Nouvelle Squad' })).toHaveCount(0);
  });

  test('matrice des insets : barre 58+bas, identité sous le haut, Profil dans la bande', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(2) });
    const matrices = [
      { label: 'portrait 47/34', top: 47, bottom: 34, width: 390, height: 844 },
      { label: 'portrait 44/34', top: 44, bottom: 34, width: 390, height: 844 },
      { label: 'aucun inset', top: 0, bottom: 0, width: 390, height: 844 },
      { label: 'paysage 0/21', top: 0, bottom: 21, width: 844, height: 390 },
    ];

    for (const [index, matrix] of matrices.entries()) {
      if (index > 0) await context.unroute('**/*.css');
      await applySafeAreaInsets(context, matrix.top, matrix.bottom);
      await page.setViewportSize({ width: matrix.width, height: matrix.height });
      await page.goto('/squad/900001');

      const nav = page.locator('[data-bottom-nav]');
      await expect(nav, matrix.label).toBeVisible();
      const navBox = await nav.boundingBox();
      expect(navBox, `Barre mesurable (${matrix.label})`).not.toBeNull();
      expect(navBox!.height, `Hauteur 58+bas (${matrix.label})`).toBeCloseTo(58 + matrix.bottom, 0);
      expect(navBox!.y + navBox!.height, `Barre dans l'écran (${matrix.label})`)
        .toBeLessThanOrEqual(matrix.height + 0.5);

      const profile = page.getByRole('button', { name: 'Profil', exact: true });
      await expect(profile, matrix.label).toBeVisible();
      const profileBox = await profile.boundingBox();
      expect(profileBox, `Profil mesurable (${matrix.label})`).not.toBeNull();
      expect(profileBox!.width, `Profil 56px (${matrix.label})`).toBeCloseTo(56, 0);
      expect(profileBox!.height, `Profil 56px (${matrix.label})`).toBeCloseTo(56, 0);
      expect(profileBox!.y, `Profil dans la barre (${matrix.label})`).toBeGreaterThanOrEqual(navBox!.y - 0.5);
      expect(profileBox!.y + profileBox!.height, `Profil au-dessus de l'inset bas (${matrix.label})`)
        .toBeLessThanOrEqual(navBox!.y + 58 + 0.5);

      const identity = page.locator('[data-dashboard-identity]');
      await expect(identity, matrix.label).toBeVisible();
      const identityBox = await identity.boundingBox();
      expect(identityBox, `Identité mesurable (${matrix.label})`).not.toBeNull();
      expect(identityBox!.y, `Identité sous l'inset haut (${matrix.label})`)
        .toBeLessThanOrEqual(8 + matrix.top + 1);
      expect(identityBox!.y, `Identité pas trop haute (${matrix.label})`)
        .toBeGreaterThanOrEqual(8 + matrix.top - 1);

      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        scrollY: window.scrollY,
      }));
      expect(metrics.scrollWidth, `Aucun débordement horizontal (${matrix.label})`).toBeLessThanOrEqual(metrics.innerWidth);
      expect(metrics.scrollY, `Document confiné (${matrix.label})`).toBe(0);
    }

    await context.unroute('**/*.css');
  });

  test('chat : header et bouton Envoyer complets avant, pendant et après le focus', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(1) });
    await page.goto('/squad/900001/beer-call/bc_900001/chat');

    const back = page.getByRole('button', { name: 'Retour', exact: true });
    const send = page.getByRole('button', { name: 'Envoyer', exact: true });
    const textarea = page.getByPlaceholder('Écris un message...', { exact: true });
    await expect(back).toBeVisible();
    await expect(send).toBeVisible();
    await expect(textarea).toBeVisible();

    const fontSize = await textarea.evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize, 'Saisie à 16px pour empêcher le zoom iOS').toBeGreaterThanOrEqual(16);

    const viewport = page.viewportSize()!;
    const assertComposerInside = async (phase: string) => {
      const sendBox = await send.boundingBox();
      const backBox = await back.boundingBox();
      expect(sendBox, `Envoyer mesurable (${phase})`).not.toBeNull();
      expect(backBox, `Retour mesurable (${phase})`).not.toBeNull();
      expect(sendBox!.x, `Envoyer à gauche (${phase})`).toBeGreaterThanOrEqual(0);
      expect(sendBox!.y, `Envoyer en haut (${phase})`).toBeGreaterThanOrEqual(0);
      expect(sendBox!.x + sendBox!.width, `Envoyer à droite (${phase})`).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(sendBox!.y + sendBox!.height, `Envoyer dans l'écran (${phase})`).toBeLessThanOrEqual(viewport.height + 0.5);
      expect(backBox!.y, `Header en haut (${phase})`).toBeGreaterThanOrEqual(0);
      expect(backBox!.y + backBox!.height, `Header visible (${phase})`).toBeLessThanOrEqual(viewport.height + 0.5);
    };

    await assertComposerInside('avant focus');
    await textarea.focus();
    await assertComposerInside('pendant focus');
    await textarea.blur();
    await assertComposerInside('après blur');

    // Limite honnête : le clavier natif iOS n'est pas simulable ici (T13).
    test.info().annotations.push({
      type: 'limite clavier',
      description: 'Focus/blur DOM seulement : la réduction réelle du visualViewport par le clavier iOS reste à T13.',
    });
    expect(await page.evaluate(() => window.scrollY), 'Chat sans scroll racine').toBe(0);
  });

  test.describe('bannière push et pile haute', () => {
    for (const visibleBanner of [true, false]) {
      test(`bannière ${visibleBanner ? 'présente sans recouvrir l identité' : 'absente quand la permission est accordée'}`, async ({ context, page }) => {
        await context.addInitScript(granted => {
          if (!('Notification' in window)) return;
          Object.defineProperty(Notification, 'permission', {
            configurable: true,
            get: () => granted ? 'granted' : 'default',
          });
        }, !visibleBanner);
        await installUxFixtures(context, { squads: makeSquads(2) });
        await page.goto('/squad/900001');

        const identity = page.locator('[data-dashboard-identity]');
        await expect(identity).toBeVisible();
        const identityBox = await identity.boundingBox();
        expect(identityBox, 'Identité mesurable').not.toBeNull();

        const banner = page.locator('[data-push-banner]');
        if (!visibleBanner) {
          await expect(banner).toHaveCount(0);
          return;
        }

        if (!isChromium(page)) {
          // WebKit headless n'expose pas Notification.permission simulable :
          // la bannière ne peut pas être rendue ici. Limite annoncée, pas de faux
          // objet global injecté dans l'application.
          test.info().annotations.push({
            type: 'limite WebKit',
            description: 'Notification indisponible/non simulable dans WebKit headless : bannière push à vérifier sur Safari réel (T13).',
          });
          await expect(banner).toHaveCount(0);
          return;
        }

        await expect(banner).toBeVisible();
        const bannerBox = await banner.boundingBox();
        expect(bannerBox, 'Bannière mesurable').not.toBeNull();
        const overlap = !(
          bannerBox!.x + bannerBox!.width <= identityBox!.x ||
          identityBox!.x + identityBox!.width <= bannerBox!.x ||
          bannerBox!.y + bannerBox!.height <= identityBox!.y ||
          identityBox!.y + identityBox!.height <= bannerBox!.y
        );
        expect(overlap, 'Bannière sous l identité, jamais superposée').toBe(false);
        expect(bannerBox!.y, 'Bannière après l identité').toBeGreaterThanOrEqual(identityBox!.y + identityBox!.height - 1);

        // La bannière reste hors de la colonne des commandes carte (à droite).
        const geoloc = page.getByRole('button', { name: /Relancer la localisation|Me recentrer/ });
        const geolocBox = await geoloc.boundingBox();
        expect(geolocBox, 'Commande géoloc mesurable').not.toBeNull();
        expect(bannerBox!.x + bannerBox!.width, 'Aucun chevauchement avec la géoloc')
          .toBeLessThanOrEqual(geolocBox!.x + 0.5);
      });
    }
  });
});
