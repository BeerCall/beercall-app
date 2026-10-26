import { test, expect, type Browser, type BrowserContext, type Page, type Locator, type WebSocket as BrowserSocket } from '@playwright/test';

test.setTimeout(180_000);

const baseURL = 'http://127.0.0.1:8080';
const password = 'BeerCallE2E123!';
const unique = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SUBMISSION_STAGES = /^(ANALYSE IA EN COURS|PRÉPARATION DE LA PHOTO|ENVOI DE LA PHOTO|PHOTO EN ATTENTE DE VÉRIFICATION|VÉRIFICATION DE LA PHOTO)(\.\.\.|…)$/;

interface Actor {
  context: BrowserContext;
  page: Page;
  username: string;
  token: string;
}

async function actor(browser: Browser): Promise<Actor> {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, geolocation: { latitude: 48.8, longitude: 2.3 }, permissions: ['geolocation'] });
  const catalogue = await context.request.get('/api/auth/profile/');
  expect(catalogue.status()).toBe(200);
  const items = (await catalogue.json() as { shop_items: { id: string; category: string; gender: string }[] }).shop_items;
  const avatar: Record<string, string> = { gender: 'Men' };
  for (const category of ['head', 'body', 'legs', 'feet', 'accessory', 'animation']) {
    avatar[category] = items.find(item => item.category === category && ['Men', 'Unisex'].includes(item.gender) && item.id.endsWith('_0'))?.id ?? 'none';
  }
  avatar.accessory = 'none';
  avatar.animation = 'Idle';
  const username = unique();
  const registered = await context.request.post('/api/auth/signup/', { data: { username, password, avatar } });
  expect(registered.status()).toBe(200);
  const token = (await registered.json() as { access_token: string }).access_token;
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByPlaceholder('Ton Pseudo', { exact: true }).fill(username);
  await page.getByPlaceholder('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'SE CONNECTER', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page, username, token };
}

async function squadContext(browser: Browser) {
  // Prérequis via les vrais endpoints ; le job, la participation et le jeu sont pilotés dans l'UI.
  const creator = await actor(browser);
  const member = await actor(browser);
  const name = `Squad ${unique()}`;
  const created = await creator.context.request.post('/api/squads/', {
    headers: { Authorization: `Bearer ${creator.token}` }, data: { name, icon: 'beer', color: '#F59E0B' },
  });
  expect(created.status()).toBe(200);
  const squad = await created.json() as { id: number; invite_code: string };
  const joined = await member.context.request.post('/api/squads/join', {
    headers: { Authorization: `Bearer ${member.token}` }, data: { invite_code: squad.invite_code },
  });
  expect(joined.status()).toBe(200);
  const ticketResponse = member.page.waitForResponse(response => response.url().endsWith(`/api/squads/${squad.id}/ws-ticket`));
  const socketPromise = member.page.waitForEvent('websocket');
  await member.page.goto(`/squad/${squad.id}`);
  const ticket = (await (await ticketResponse).json() as { ticket: string }).ticket;
  const socket = await socketPromise;
  await expect(member.page.getByRole('heading', { name, exact: true })).toBeVisible();
  await member.page.getByRole('heading', { name, exact: true }).click();
  await creator.page.goto(`/squad/${squad.id}`);
  await creator.page.getByRole('heading', { name, exact: true }).click();
  return { creator, member, squad, name, socket, ticket };
}

async function image(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#F59E0B';
    context.fillRect(0, 0, 16, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'drink.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

function refreshed(page: Page, socket: BrowserSocket, action: string) {
  // Suivre aussi les reconnexions réelles du hook, pas seulement le premier socket.
  return new Promise<void>(resolve => {
    const attach = (current: BrowserSocket) => current.on('framereceived', frame => {
      const text = frame.payload.toString();
      if (text === 'PONG') return;
      let payload: { type: string; action: string };
      try {
        payload = JSON.parse(text) as { type: string; action: string };
      } catch {
        return;
      }
      if (payload.type === 'REFRESH_SQUAD' && payload.action === action) {
        page.off('websocket', attach);
        resolve();
      }
    });
    attach(socket);
    page.on('websocket', attach);
  });
}

function visibleBeerCallResponse(page: Page, squadId: number, location: string) {
  return page.waitForResponse(async response => {
    if (!response.url().endsWith(`/api/squads/${squadId}`) || response.status() !== 200) return false;
    const details = await response.json() as { active_beer_call: { location_name: string }[] };
    return details.active_beer_call.some(call => call.location_name === location);
  });
}

function gameActionResponse(page: Page, aperoId: string) {
  return page.waitForResponse(response => response.url().endsWith(`/api/aperos/${aperoId}/game/action`) && response.request().method() === 'POST');
}

async function visibleState(locator: Locator) {
  await locator.waitFor({ state: 'visible' });
  await expect(locator).toBeVisible();
}

async function createBeerCall(page: Page, squadId: number, location: string) {
  const file = await image(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Créer un Beer Call', exact: true }).click();
  await (await chooser).setFiles(file);
  await page.getByPlaceholder('Ex: Bar Le Central...').fill(location);
  const accepted = page.waitForResponse(response => response.url().endsWith(`/api/squads/${squadId}/beer-calls/`) && response.request().method() === 'POST');
  const succeeded = page.waitForResponse(async response => response.url().includes(`/api/squads/${squadId}/beer-calls/jobs/`) && response.status() === 200 && (await response.json() as { status: string }).status === 'succeeded');
  await page.getByRole('button', { name: "LANCER L'APPEL", exact: true }).click();
  const stageButton = page.getByRole('button', { name: SUBMISSION_STAGES });
  const modalHeading = page.getByRole('heading', { name: "Valider l'Apéro" });
  await expect.poll(async () => {
    const isModalOpen = await modalHeading.isVisible().catch(() => false);
    if (!isModalOpen) return true;
    return await stageButton.isDisabled().catch(() => false);
  }, { message: 'Bouton de soumission désactivé pendant le traitement ou modale déjà fermée' }).toBe(true);
  const response = await accepted;
  expect(response.status()).toBe(202);
  const job = await response.json() as { job_id: string; status: string };
  expect(job.status).toBe('processing');
  const terminal = await (await succeeded).json() as { id: string; status: string };
  expect(terminal.id).toBe(job.job_id);
  expect(terminal.status).toBe('succeeded');
  await visibleState(page.getByRole('heading', { name: location, exact: true }));
}

test('job durable 202, progression, succès, rafraîchissement WebSocket et ticket non rejouable', async ({ browser }) => {
  const setup = await squadContext(browser);
  try {
    const location = `Bar ${unique()}`;
    const realtime = refreshed(setup.member.page, setup.socket, 'CREATE');
    const visible = visibleBeerCallResponse(setup.member.page, setup.squad.id, location);
    await createBeerCall(setup.creator.page, setup.squad.id, location);
    await realtime;
    await visible;
    await visibleState(setup.member.page.getByRole('heading', { name: location, exact: true }));
    await expect(setup.member.page.getByRole('button', { name: 'Répondre 📸' })).toBeVisible();
    const replay = await setup.member.page.evaluate(({ id, ticket }) => new Promise<string>(resolve => {
      const socket = new WebSocket(`ws://${window.location.host}/api/squads/${id}/ws`, ['beercall', `ticket.${ticket}`]);
      socket.onopen = () => { resolve('opened'); socket.close(); };
      socket.onerror = () => resolve('rejected');
      socket.onclose = () => resolve('rejected');
    }), { id: setup.squad.id, ticket: setup.ticket });
    expect(replay).toBe('rejected');
  } finally {
    await setup.creator.page.close().catch(() => {});
    await setup.creator.context.close().catch(() => {});
    await setup.member.page.close().catch(() => {});
    await setup.member.context.close().catch(() => {});
  }
});

test('participation réelle puis démarrage et fin du mini-jeu déterministe', async ({ browser }) => {
  const setup = await squadContext(browser);
  try {
    const location = `Bar ${unique()}`;
    const realtime = refreshed(setup.member.page, setup.socket, 'CREATE');
    const visible = visibleBeerCallResponse(setup.member.page, setup.squad.id, location);
    await createBeerCall(setup.creator.page, setup.squad.id, location);
    await realtime;
    await visible;
    await setup.member.page.getByRole('button', { name: 'Répondre 📸' }).click();
    const chooser = setup.member.page.waitForEvent('filechooser');
    await setup.member.page.getByRole('button', { name: "J'y Vais !", exact: true }).click();
    await (await chooser).setFiles(await image(setup.member.page));
    const joined = setup.member.page.waitForResponse(response => /\/beer-calls\/bc_\d+\/join\/$/.test(response.url()) && response.request().method() === 'POST');
    await setup.member.page.getByRole('button', { name: 'VALIDATION IA', exact: true }).click();
    const participation = await joined;
    expect(participation.status()).toBe(200);
    const aperoId = /\/beer-calls\/bc_(\d+)\/join\/$/.exec(participation.url())![1];
    await expect(setup.member.page.getByText('2 Participants', { exact: true })).toBeVisible();
    const worlds = setup.member.page.waitForResponse(response => response.url().endsWith(`/api/squads/${setup.squad.id}/beer-calls/bc_${aperoId}/worlds`));
    await setup.member.page.getByRole('button', { name: 'Mondes 🌍' }).click({ force: true });
    expect((await worlds).status()).toBe(200);
    // Le levier 3D reste le contrôle visuel ; le bouton masqué accessible permet
    // un lancement déterministe sans attendre le chargement des modèles FBX.
    const startButton = setup.member.page.getByRole('button', { name: 'Démarrer la partie' });
    await expect(startButton).toBeEnabled({ timeout: 30_000 });
    const started = setup.member.page.waitForResponse(response => response.url().endsWith(`/api/aperos/${aperoId}/game/start`));
    await startButton.dispatchEvent('click');
    expect((await (await started).json() as { game_id: string }).game_id).toBe('TURN_TRANSITION');
    const selected = gameActionResponse(setup.member.page, aperoId);
    await setup.member.page.getByRole('button', { name: 'Je suis prêt !', exact: true }).click();
    const selectedResponse = await selected;
    expect(selectedResponse.status()).toBe(200);
    expect((await selectedResponse.json() as { game_id: string }).game_id).toBe('BRAIN_DUEL');
    await visibleState(setup.member.page.getByRole('heading', { name: 'Duel de Réflexes ⚡', exact: true }));
    const duel = gameActionResponse(setup.member.page, aperoId);
    await setup.member.page.getByRole('button', { name: 'Prêts ? Démarrer !', exact: true }).click();
    expect((await duel).status()).toBe(200);
    // Le jeu donne le signal après 2 à 6 s : attendre son état, pas une durée fixe.
    await visibleState(setup.member.page.getByRole('heading', { name: 'TAPEZ !', exact: true }).first());
    const finished = setup.member.page.waitForResponse(async response => response.url().endsWith(`/api/aperos/${aperoId}/game/action`) && (await response.json() as { instruction_header: string }).instruction_header === 'Résultat');
    await setup.member.page.getByRole('heading', { name: 'TAPEZ !', exact: true }).first().click();
    expect((await (await finished).json() as { game_id: string }).game_id).toBe('BRAIN_DUEL');
    await visibleState(setup.member.page.getByRole('heading', { name: /l'emporte !$/ }));
    const next = gameActionResponse(setup.member.page, aperoId);
    await setup.member.page.getByRole('button', { name: 'On passe à la suite', exact: true }).click();
    const nextResponse = await next;
    expect(nextResponse.status()).toBe(200);
    expect((await nextResponse.json() as { game_id: string }).game_id).toBe('TURN_TRANSITION');
    await visibleState(setup.member.page.getByRole('heading', { name: 'Nouveau défi ! 🔥', exact: true }));
  } finally {
    await setup.creator.page.close().catch(() => {});
    await setup.creator.context.close().catch(() => {});
    await setup.member.page.close().catch(() => {});
    await setup.member.context.close().catch(() => {});
  }
});
