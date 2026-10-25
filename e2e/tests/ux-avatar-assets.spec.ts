import { test, expect } from '@playwright/test';
import { ANIMATIONS_SHA256, getAnimationProtocol, getHdrExpectation, installUxFixtures } from './support/uxFixtures';

test.use({ viewport: { width: 390, height: 844 } });

test('profil propre : vestiaire et Idle provenant du protocole configuré', async ({ context, page }) => {
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

  const protocol = getAnimationProtocol();
  if (protocol === 'legacy') {
    await expect.poll(() => isolation.assetHits.rawFbx).toBeGreaterThan(0);
  } else {
    await expect.poll(() => isolation.assetHits.manifest).toBeGreaterThan(0);
    await expect.poll(() => isolation.assetHits.idle).toBeGreaterThan(0);
  }
  await isolation.assertHdr();
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

  const protocol = getAnimationProtocol();
  if (protocol === 'legacy') {
    await expect.poll(() => isolation.assetHits.rawFbx).toBeGreaterThan(0);
  } else {
    await expect.poll(() => isolation.assetHits.manifest).toBeGreaterThan(0);
    await expect.poll(() => isolation.assetHits.idle).toBeGreaterThan(0);
  }
  await isolation.assertHdr();
  isolation.assertAssets();
  isolation.assertIsolated();
});

test('fixtures : manifeste et packs d\'animation accessibles et conformes aux hashes', async ({ context, page }) => {
  const isolation = await installUxFixtures(context, { assets: true });
  await page.goto('/profile');
  const manifestData = await page.evaluate(async () => {
    const res = await fetch('/animations/manifest.json');
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return res.json();
  });
  expect(manifestData.formatVersion).toBe(1);
  expect(manifestData.sourceHash).toBe(ANIMATIONS_SHA256);
  expect(isolation.assetHits.manifest).toBeGreaterThan(0);

  const criticalOk = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.ok;
  }, manifestData.critical.url);
  expect(criticalOk).toBe(true);
  expect(isolation.assetHits.idle).toBeGreaterThan(0);

  const deferredOk = await page.evaluate(async (url) => {
    const res = await fetch(url);
    return res.ok;
  }, manifestData.deferred.url);
  expect(deferredOk).toBe(true);
  expect(isolation.assetHits.deferred).toBeGreaterThan(0);
});

test('validation protocole : seules les valeurs legacy ou packs sont acceptées', () => {
  const prev = process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL;
  try {
    process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL = 'invalid_protocol';
    expect(() => getAnimationProtocol()).toThrow(/Protocole d'animation inconnu/);

    process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL = 'legacy';
    expect(getAnimationProtocol()).toBe('legacy');

    process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL = 'packs';
    expect(getAnimationProtocol()).toBe('packs');

    delete process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL;
    expect(getAnimationProtocol()).toBe('packs');
  } finally {
    if (prev !== undefined) process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL = prev;
    else delete process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL;
  }
});

test('validation HDR : absence explicite optimisée, présence historique et refus des valeurs inconnues', () => {
  const previous = process.env.BEERCALL_EXPECT_HDR;
  try {
    process.env.BEERCALL_EXPECT_HDR = 'absent';
    expect(getHdrExpectation()).toBe('absent');
    process.env.BEERCALL_EXPECT_HDR = 'required';
    expect(getHdrExpectation()).toBe('required');
    process.env.BEERCALL_EXPECT_HDR = 'ignore';
    expect(() => getHdrExpectation()).toThrow(/Protocole HDR inconnu/);
    delete process.env.BEERCALL_EXPECT_HDR;
    expect(getHdrExpectation()).toBe('required');
  } finally {
    if (previous === undefined) delete process.env.BEERCALL_EXPECT_HDR;
    else process.env.BEERCALL_EXPECT_HDR = previous;
  }
});
