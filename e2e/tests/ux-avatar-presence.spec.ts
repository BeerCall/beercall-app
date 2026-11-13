import {test, expect} from '@playwright/test';
import {avatarFixture, avatarsVisible, connectionsAtTop, threeConnectionsVisible, assertRealAvatar, THUMBNAILS, HEADS, PLAYER, PROFILE, WORKER} from './support/avatarGraphics';

test('première carte et toutes les cartes intersectant réellement le scrollport ont leurs pixels', async ({context, page}) => {
    const fixture = await avatarFixture(context);
    await page.goto('/connections');
    await page.locator('[data-avatar-preparation-ready="true"]').waitFor({state: 'attached'});
    await connectionsAtTop(page);
    await expect(page.getByTestId('avatar-thumb-900006').locator('[data-avatar-state]')).toHaveAttribute('data-avatar-state', 'frame-ready');
    await expect(page.getByTestId('connections-scrollport')).toHaveJSProperty('scrollTop', 0);
    expect((await threeConnectionsVisible(page)).length).toBeGreaterThanOrEqual(3);
    await expect(page.getByLabel(/^Avatar de AvatarFixture/)).toHaveCount(0);
    expect(await page.evaluate(() => window.__avatarGraphics.metrics().sources)).toBe(1);
    await fixture.finish(page);
});

test('scroll bas puis haut conserve les frames de toutes les cellules visibles', async ({context, page}) => {
    const fixture = await avatarFixture(context);
    await page.goto('/connections');
    await connectionsAtTop(page);
    await threeConnectionsVisible(page);
    await page.getByTestId('connections-scrollport').evaluate(node => {node.scrollTop = node.scrollHeight;});
    await avatarsVisible(page, THUMBNAILS, 2);
    await page.getByTestId('connections-scrollport').evaluate(node => {node.scrollTop = 0;});
    await connectionsAtTop(page);
    expect(await page.evaluate(() => window.__avatarGraphics.metrics().sources)).toBe(1);
    await fixture.finish(page);
});

test('trente vrais messages React de trois profils partagent une seule source et leurs portraits ne sont pas vides', async ({context, page}) => {
    const fixture = await avatarFixture(context);
    await page.goto('/squad/900001/beer-call/bc_900001/chat');
    await fixture.seedChat(page);
    await expect(page.locator(HEADS)).toHaveCount(30);
    const bottom = await avatarsVisible(page, HEADS, 3);
    expect(bottom.every(proof => proof.parts.length === 1 && proof.parts[0] === 'head')).toBe(true);
    await page.locator('textarea').evaluate(node => {const list = node.closest('footer')?.previousElementSibling; if (list) list.scrollTop = 0;});
    await avatarsVisible(page, HEADS, 3);
    expect(await page.evaluate(() => window.__avatarGraphics.metrics().sources)).toBe(1);
    await page.getByPlaceholder('Écris un message...').fill('Synthetic draft, never sent');
    await expect(page.getByPlaceholder('Écris un message...')).toHaveValue('Synthetic draft, never sent');
    await fixture.finish(page);
});

test('carte→Connexions→profil→chat→carte, masquage et restauration native ne créent pas de moteur supplémentaire', async ({context, page}) => {
    const fixture = await avatarFixture(context);
    await page.goto('/squad/900001');
    await avatarsVisible(page, PLAYER);
    await page.getByRole('button', {name: 'Connexions', exact: true}).click();
    await connectionsAtTop(page);
    await threeConnectionsVisible(page);
    await page.getByText('AvatarFixture900006', {exact: true}).click();
    await avatarsVisible(page, PROFILE);
    await page.goBack(); await page.goBack();
    await page.getByRole('button', {name: 'Chat', exact: true}).click();
    await fixture.seedChat(page); await avatarsVisible(page, HEADS, 3);
    await page.getByRole('button', {name: 'Retour', exact: true}).click();
    await avatarsVisible(page, PLAYER);
    const before = await page.evaluate(() => window.__avatarGraphics.metrics());
    await page.evaluate(() => {window.__avatarGraphics.hide(true);});
    await page.evaluate(() => {window.__avatarGraphics.hide(false);});
    await avatarsVisible(page, PLAYER);
    const native = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-avatar-source] canvas');
        const extension = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!extension) return false;
        (window as unknown as {__restoreAvatar: () => void}).__restoreAvatar = () => extension.restoreContext();
        extension.loseContext(); return true;
    });
    if (native) {
        await page.locator('[data-avatar-view-name="dashboard"][data-avatar-state="context-lost"]').waitFor();
        const retained = await page.evaluate(selector => window.__avatarGraphics.read(selector), PLAYER);
        expect(retained.every(proof => proof.opaque > 10 && proof.colors > 2)).toBe(true);
        await page.evaluate(() => (window as unknown as {__restoreAvatar: () => void}).__restoreAvatar());
        await avatarsVisible(page, PLAYER);
    } else test.info().annotations.push({type: 'capability', description: 'Native WEBGL_lose_context unavailable; no native restoration claimed'});
    const after = await page.evaluate(() => window.__avatarGraphics.metrics());
    expect(after.created).toBe(before.created); expect(after.live).toBeLessThanOrEqual(3); expect(after.sources).toBe(1);
    await fixture.finish(page);
});

test('une config absente possède un fallback et un canvas vide ne satisfait jamais la preuve 3D', async ({context, page}) => {
    const fixture = await avatarFixture(context, {contacts: [{...WORKER, head: 'none', body: 'none', legs: 'none', feet: 'none', accessory: 'none'}]});
    await page.goto('/connections');
    await expect(page.getByLabel('Avatar de AvatarFixture900006')).toHaveText('A');
    await expect(page.getByTestId('avatar-thumb-900006').locator('canvas')).toHaveCount(0);
    await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 36;
        canvas.id = 'empty-negative-avatar'; canvas.style.cssText = 'position:fixed;top:0;left:0;width:36px;height:36px;z-index:999'; document.body.append(canvas);
    });
    const empty = await page.evaluate(() => window.__avatarGraphics.read('#empty-negative-avatar'));
    expect(empty[0].opaque).toBe(0); expect(empty[0].meshes).toBe(0);
    expect(() => assertRealAvatar(empty[0])).toThrow();
    await page.evaluate(() => document.getElementById('empty-negative-avatar')?.remove());
    await fixture.finish(page);
});
