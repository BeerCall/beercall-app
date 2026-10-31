import {test, expect} from '@playwright/test';
import {avatarFixture, avatarsVisible, connectionsAtTop, threeConnectionsVisible, measureNavigation, p95, THUMBNAILS, PROFILE, SCIFI, WORKER} from './support/avatarGraphics';

test('entrée avant le warmup : navigation non bloquée, puis toutes les cellules visibles progressent', async ({context, page}) => {
    const fixture = await avatarFixture(context, {delayModels: true});
    try {
        await page.goto('/squad/900001');
        await page.getByRole('button', {name: 'Connexions', exact: true}).click();
        await expect(page).toHaveURL(/\/connections$/);
        await expect(page.getByTestId('avatar-thumb-900006')).toBeVisible();
        expect(await page.locator('[data-avatar-preparation-ready="true"]').count()).toBe(0);
        fixture.releaseModels();
        await connectionsAtTop(page);
        await threeConnectionsVisible(page);
        await fixture.finish(page);
    } finally {fixture.releaseModels();}
});

test('dix ouvertures préparées de Connexions : tous les visibles présents en p95≤150ms', async ({context, page}) => {
    const fixture = await avatarFixture(context);
    await page.goto('/squad/900001');
    await page.locator('[data-avatar-preparation-ready="true"]').waitFor({state: 'attached'});
    const requests = fixture.controls.requests.length;
    const contexts = await page.evaluate(() => window.__avatarGraphics.metrics().created);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
        console.log(JSON.stringify({series: 'connections', opening: i + 1, phase: 'start'}));
        samples.push(await measureNavigation(page, page.getByRole('button', {name: 'Connexions', exact: true}), THUMBNAILS));
        console.log(JSON.stringify({series: 'connections', opening: i + 1, ms: samples[i]}));
        if (i === 9) await avatarsVisible(page, THUMBNAILS);
        await page.goBack();
    }
    await test.info().attach('connections-prepared-latency', {body: JSON.stringify({samples, p95: p95(samples), convention: 'nearest-rank; maximum for n=10; software proxy'}), contentType: 'application/json'});
    expect(fixture.controls.requests.length).toBe(requests);
    expect(await page.evaluate(() => window.__avatarGraphics.metrics().created)).toBe(contexts);
    expect(p95(samples)).toBeLessThanOrEqual(150);
    await fixture.finish(page);
});

test('dix ouvertures du profil préparé : p95≤200ms, sans redemande des modèles prêts', async ({context, page}) => {
    const fixture = await avatarFixture(context);
    await page.goto('/squad/900001');
    await page.locator('[data-avatar-preparation-ready="true"]').waitFor({state: 'attached'});
    const requests = fixture.controls.requests.length;
    const contexts = await page.evaluate(() => window.__avatarGraphics.metrics().created);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
        console.log(JSON.stringify({series: 'profile', opening: i + 1, phase: 'start'}));
        samples.push(await measureNavigation(page, page.getByRole('button', {name: 'Profil', exact: true}), PROFILE));
        console.log(JSON.stringify({series: 'profile', opening: i + 1, ms: samples[i]}));
        if (i === 9) await avatarsVisible(page, PROFILE);
        await page.goBack();
    }
    await test.info().attach('profile-prepared-latency', {body: JSON.stringify({samples, p95: p95(samples), convention: 'nearest-rank; maximum for n=10; software proxy'}), contentType: 'application/json'});
    expect(fixture.controls.requests.length).toBe(requests);
    expect(await page.evaluate(() => window.__avatarGraphics.metrics().created)).toBe(contexts);
    expect(p95(samples)).toBeLessThanOrEqual(200);
    await fixture.finish(page);
});

test('nouvel asset, pack critique et pack différé : erreurs dans la cellule, vrai retry utilisateur et frame correcte', async ({browser}) => {
    const use = test.info().project.use;
    const options = {viewport: use.viewport ?? {width: 390, height: 844}, hasTouch: use.hasTouch, isMobile: use.isMobile,
        serviceWorkers: 'block' as const, baseURL: 'http://127.0.0.1:8080', timezoneId: 'Europe/Paris'};
    const modelContext = await browser.newContext(options);
    const criticalContext = await browser.newContext(options);
    const deferredContext = await browser.newContext(options);
    try {
        const model = await avatarFixture(modelContext, {own: SCIFI});
        const page = await modelContext.newPage();
        await page.goto('http://127.0.0.1:8080/profile');
        await avatarsVisible(page, PROFILE);
        const target = await page.locator(PROFILE).elementHandle();
        expect(model.controls.requests).not.toContain(`${model.newHead}.fbx`);
        model.controls.failedModels.add(`${model.newHead}.fbx`);
        await page.getByText('Fixture new head', {exact: true}).click();
        const cell = page.locator('[data-avatar-view-name="profile"]');
        await expect(cell.getByText('Modèle d’avatar indisponible')).toBeVisible();
        expect(await page.evaluate(selector => window.__avatarGraphics.read(selector)[0].opaque, PROFILE)).toBeGreaterThan(10);
        expect(await page.locator(PROFILE).evaluate((node, target) => node === target, target)).toBe(true);
        const attempts = model.controls.failedRequests.length;
        model.controls.failedModels.delete(`${model.newHead}.fbx`);
        await cell.getByRole('button', {name: 'Réessayer le modèle'}).click();
        await avatarsVisible(page, PROFILE);
        expect(model.controls.requests.filter(name => name === `${model.newHead}.fbx`).length).toBeGreaterThan(1);
        expect(attempts).toBeGreaterThan(0);
        await expect(cell).toHaveAttribute('data-avatar-signature', new RegExp(model.newHead));
        await model.finish(page);
        console.log('avatar-retry: model recovered');
        await page.goto('about:blank');
        await modelContext.close();

        const critical = await avatarFixture(criticalContext);
        critical.controls.criticalFailed = true;
        const criticalPage = await criticalContext.newPage();
        await criticalPage.goto('http://127.0.0.1:8080/profile');
        const criticalCell = criticalPage.locator('[data-avatar-view-name="profile"]');
        await expect(criticalCell.getByText('Erreur de chargement des animations')).toBeVisible();
        expect(await criticalCell.getAttribute('data-avatar-state')).not.toBe('frame-ready');
        critical.controls.criticalFailed = false;
        await criticalCell.getByRole('button', {name: 'Réessayer les animations'}).click();
        await avatarsVisible(criticalPage, PROFILE);
        await critical.finish(criticalPage);
        console.log('avatar-retry: critical pack recovered');
        await criticalPage.goto('about:blank');
        await criticalContext.close();

        const deferred = await avatarFixture(deferredContext, {own: {...WORKER, animation: 'Sitting'}});
        deferred.controls.deferredFailed = true;
        const deferredPage = await deferredContext.newPage();
        await deferredPage.goto('http://127.0.0.1:8080/profile');
        const deferredCell = deferredPage.locator('[data-avatar-view-name="profile"]');
        // This case is specifically a deferred failure AFTER the first Idle
        // copy. Do not spend its error-message assertion on cold FBX loading.
        await deferredPage.waitForFunction(selector => window.__avatarGraphics.read(selector, true, false)
            .some(proof => proof.current && proof.ready && proof.copies > 0 && proof.clips.includes('Idle')), PROFILE);
        await expect(deferredCell.getByText('Animations différées indisponibles')).toBeVisible();
        const idle = await deferredPage.evaluate(selector => window.__avatarGraphics.read(selector)[0], PROFILE);
        expect(idle.opaque).toBeGreaterThan(10); expect(idle.clips).toEqual(['Idle']);
        await deferredCell.getByRole('button', {name: 'Réessayer les animations'}).click();
        // Keep the fault active until the actual user action. Releasing it
        // before click lets another warming subscriber remove the retry button.
        // The launched query keeps its normal one automatic retry (250ms).
        deferred.controls.deferredFailed = false;
        await avatarsVisible(deferredPage, PROFILE);
        await expect.poll(() => deferredPage.evaluate(selector => window.__avatarGraphics.read(selector)[0].clips, PROFILE)).toEqual(['Sitting']);
        await deferred.finish(deferredPage);
        console.log('avatar-retry: deferred pack recovered');
        await deferredPage.goto('about:blank');
    } finally {await Promise.all([modelContext.close(), criticalContext.close(), deferredContext.close()]);}
});
