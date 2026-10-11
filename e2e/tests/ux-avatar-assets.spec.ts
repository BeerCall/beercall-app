import { test, expect } from '@playwright/test';
import { installUxFixtures } from './support/uxFixtures';

test.use({ viewport: { width: 390, height: 844 } });

test('profil propre : vestiaire et Idle provenant du FBX local', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { profileMode: 'own', assets: true });
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'FixtureUser' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vestiaire' })).toBeVisible();
  await expect(page.getByText('Équipé', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Anim$/ }).tap();
  const idle = page.getByRole('button', { name: 'Idle', exact: true });
  await expect(idle).toBeVisible();
  await expect(idle).toBeEnabled();
  await expect(idle).toHaveClass(/border-beer/);
  await idle.tap();
  await expect(page.getByRole('button', { name: 'SAUVEGARDER LE STYLE' })).toHaveCount(0);
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('profil tiers : informations sans action vestiaire, assets toujours isolés', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { profileMode: 'readonly', assets: true });
  await page.goto('/profile/900002');
  await expect(page.getByRole('heading', { name: 'FixtureUser' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ses Squads' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Statistiques' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vestiaire' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /SAUVEGARDER|Anim/ })).toHaveCount(0);
  await expect.poll(() => isolation.assetHits.fbx).toBeGreaterThan(0);
  await expect.poll(() => isolation.assetHits.hdr).toBeGreaterThan(0);
  isolation.assertAssets();
  isolation.assertIsolated();
});
