import { test, expect, type Page } from '@playwright/test';

test.setTimeout(90_000);

const password = 'BeerCallE2E123!';
const uniqueUsername = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function signup(page: Page, username: string) {
  await page.goto('/signup');
  await page.getByPlaceholder('Pseudo', { exact: true }).fill(username);
  await page.getByPlaceholder('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: "CRÉER L'AVATAR" }).click();
  await page.getByRole('button', { name: '🧢 Suit Possédé', exact: true }).click();
  const registered = page.waitForResponse(response => response.url().endsWith('/api/auth/signup/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'SAUVEGARDER LE STYLE' }).click();
  expect((await registered).status()).toBe(200);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: `Salut ${username} !`, exact: true })).toBeVisible();
}

test('inscription puis connexion, avec session persistée', async ({ page, browser }) => {
  const username = uniqueUsername();
  await signup(page, username);
  await page.reload();
  await expect(page.getByRole('heading', { name: `Salut ${username} !`, exact: true })).toBeVisible();
  const loginContext = await browser.newContext();
  try {
    const loginPage = await loginContext.newPage();
    await loginPage.goto('http://127.0.0.1:8080/login');
    await loginPage.getByPlaceholder('Ton Pseudo', { exact: true }).fill(username);
    await loginPage.getByPlaceholder('Mot de passe', { exact: true }).fill(password);
    const tokenResponse = loginPage.waitForResponse(response => response.url().endsWith('/api/auth/token/') && response.request().method() === 'POST');
    await loginPage.getByRole('button', { name: 'SE CONNECTER', exact: true }).click();
    expect((await tokenResponse).status()).toBe(200);
    await expect(loginPage).toHaveURL(/\/dashboard$/);
    await loginPage.reload();
    await expect(loginPage.getByRole('heading', { name: `Salut ${username} !`, exact: true })).toBeVisible();
  } finally {
    await loginContext.close();
  }
});

test('création de squad puis adhésion par code d’un second utilisateur', async ({ page, browser }) => {
  await signup(page, uniqueUsername());
  const name = `Squad ${uniqueUsername()}`;
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await page.getByPlaceholder('Nom de la Squad...').fill(name);
  const created = page.waitForResponse(response => response.url().endsWith('/api/squads/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'CRÉER LA SQUAD', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const squad = await response.json() as { id: number; invite_code: string };
  await page.goto(`/squad/${squad.id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: squad.invite_code, exact: true })).toBeVisible();
  const memberContext = await browser.newContext({ baseURL: 'http://127.0.0.1:8080' });
  try {
    const memberPage = await memberContext.newPage();
    await signup(memberPage, uniqueUsername());
    await memberPage.getByRole('button', { name: 'Rejoindre', exact: true }).click();
    await memberPage.getByPlaceholder('CODE...').fill(squad.invite_code);
    const joined = memberPage.waitForResponse(result => result.url().endsWith('/api/squads/join') && result.request().method() === 'POST');
    await memberPage.getByRole('button', { name: 'VALIDER LE CODE', exact: true }).click();
    expect((await joined).status()).toBe(200);
    await expect(memberPage).toHaveURL(new RegExp(`/squad/${squad.id}$`));
    await expect(memberPage.getByRole('heading', { name, exact: true })).toBeVisible();
    await memberPage.reload();
    await expect(memberPage.getByRole('heading', { name, exact: true })).toBeVisible();
  } finally {
    await memberContext.close();
  }
});
