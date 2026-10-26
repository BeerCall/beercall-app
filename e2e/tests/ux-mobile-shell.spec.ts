import { test, expect } from '@playwright/test';
import { installUxFixtures, makeSquads } from './support/uxFixtures';

test.describe('Mobile Shell & Confinement des gestes (UX-03)', () => {
  test('drag vers le bas sur la barre de navigation : window.scrollY reste à 0, aucun reload ni pull-to-refresh', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(3) });

    await page.goto('/squad/900001');

    const bottomNav = page.locator('[data-bottom-nav]');
    await expect(bottomNav).toBeVisible();

    // 1. Détection des rechargements intempestifs de document
    let pageReloads = 0;
    page.on('load', () => { pageReloads++; });

    // 2. Vérification des classes de protection sur la barre
    const navClasses = (await bottomNav.getAttribute('class')) ?? '';
    expect(navClasses, 'touch-none présent sur la barre').toContain('touch-none');
    expect(navClasses, 'overscroll-none présent sur la barre').toContain('overscroll-none');

    // 3. Confinement initial du document racine
    expect(await page.evaluate(() => window.scrollY), 'Scroll initial à 0').toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollTop), 'scrollTop initial à 0').toBe(0);

    const box = await bottomNav.boundingBox();
    expect(box, 'Bounding box de data-bottom-nav disponible').not.toBeNull();

    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    // 4. Dix glissements répétés vers le bas simulant des interactions tactiles accidentelles
    for (let cycle = 0; cycle < 10; cycle++) {
      // Émission d'événements PointerEvent de type touch sur l'élément lui-même
      await page.evaluate(({ startX, startY }) => {
        const el = document.querySelector('[data-bottom-nav]');
        if (!el) return;
        el.dispatchEvent(new PointerEvent('pointerdown', {
          pointerId: 1, pointerType: 'touch', isPrimary: true,
          clientX: startX, clientY: startY, bubbles: true, cancelable: true,
        }));
        for (let step = 1; step <= 5; step++) {
          el.dispatchEvent(new PointerEvent('pointermove', {
            pointerId: 1, pointerType: 'touch', isPrimary: true,
            clientX: startX, clientY: startY + step * 25, bubbles: true, cancelable: true,
          }));
        }
        el.dispatchEvent(new PointerEvent('pointerup', {
          pointerId: 1, pointerType: 'touch', isPrimary: true,
          clientX: startX, clientY: startY + 125, bubbles: true, cancelable: true,
        }));
      }, { startX, startY });

      // Complément via l'API pointer de Playwright sur les coordonnées de la barre
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      for (let step = 1; step <= 4; step++) {
        await page.mouse.move(startX, startY + step * 15);
      }
      await page.mouse.up();
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
    await connectionsBtn.click();

    await expect(page).toHaveURL(/\/connections/);
    await expect(page.getByRole('heading', { name: /Connexions/i })).toBeVisible();

    // Retour via le bouton arrière
    const backBtnConnections = page.locator('header button').first();
    await expect(backBtnConnections).toBeVisible();
    await backBtnConnections.click();

    await expect(page).toHaveURL(/\/squad\/900001/);

    // 2. Navigation vers Profil
    const profileBtn = page.getByRole('button', { name: /Profil/i });
    await expect(profileBtn).toBeVisible();
    await profileBtn.click();

    await expect(page).toHaveURL(/\/profile/);
    await expect(page.getByText(/FixtureUser/i).first()).toBeVisible();

    // Retour depuis le profil via le bouton chevron gauche
    const backBtnProfile = page.locator('button').filter({ has: page.locator('svg.lucide-chevron-left') }).first();
    await expect(backBtnProfile).toBeVisible();
    await backBtnProfile.click();

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

  test('swipe de la roulette : transition de page tactile fonctionnelle', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(6) });
    await page.goto('/squad/900001');

    const dragLocator = page.locator('[data-wheel-drag]');
    await expect(dragLocator).toBeVisible();

    await expect(page.getByText(/Page 1\/2/)).toBeVisible();

    const box = await dragLocator.boundingBox();
    expect(box).not.toBeNull();

    // Glissement vers la gauche pour passer à la page 2
    await dragLocator.hover();
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(box!.x + box!.width / 2 - i * 25, box!.y + box!.height / 2);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();

    await expect(page.getByText(/Page 2\/2/)).toBeVisible();

    // Glissement inverse vers la droite pour revenir à la page 1
    await dragLocator.hover();
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(box!.x + box!.width / 2 + i * 25, box!.y + box!.height / 2);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();

    await expect(page.getByText(/Page 1\/2/)).toBeVisible();
  });

  test('clavier et saisie modale : focus, saisie et fermeture sans rupture de layout', async ({ context, page }) => {
    await installUxFixtures(context, { squads: makeSquads(2) });
    await page.goto('/squad/900001');

    // Ouverture de la modale Nouvelle Squad
    const createBtn = page.getByRole('button', { name: 'Créer', exact: true });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

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

    // Fermeture de la modale via le bouton croix
    const closeBtn = page.locator('div.fixed.bottom-0 button').first();
    await expect(closeBtn).toBeVisible();
    await closeBtn.dispatchEvent('click');

    await expect(page.getByRole('heading', { name: 'Nouvelle Squad' })).toHaveCount(0);
  });
});
