import { test, expect } from '@playwright/test';
import { installUxFixtures } from './support/uxFixtures';

test.use({ viewport: { width: 390, height: 844 } });

test('tap central Chat navigue vers la conversation du Beer Call', async ({ context, page }) => {
  const isolation = await installUxFixtures(context);
  await page.goto('/squad/900001');
  await expect(page.getByRole('heading', { name: 'Lieu test', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).tap();
  await expect(page).toHaveURL('/squad/900001/beer-call/bc_900001/chat');
  isolation.assertIsolated();
});

test('tap central Répondre ouvre la modale sans mutation', async ({ context, page }) => {
  const isolation = await installUxFixtures(context);
  await page.goto('/squad/900001');
  await page.getByRole('button', { name: /Répondre/ }).tap();
  await expect(page.getByRole('heading', { name: 'Appel aux armes !' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Je Passe' })).toBeVisible();
  await expect(page).toHaveURL('/squad/900001');
  isolation.assertIsolated();
});
