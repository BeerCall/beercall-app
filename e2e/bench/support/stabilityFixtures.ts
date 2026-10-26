import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type BrowserContext, type Route } from '@playwright/test';
import {
  ANIMATIONS_SHA256,
  installUxFixtures,
  type ApiSimulation,
} from '../../tests/support/uxFixtures';
import type { UserProfile } from '../../../beercall-frontend/src/hooks/useProfile';
import type { Squad } from '../../../beercall-frontend/src/types/api';

export interface StabilityAvatar {
  head: string;
  body: string;
  legs: string;
  feet: string;
  accessory: string;
  animation: string;
  gender: 'Men' | 'Women';
}

export interface StabilityConnection {
  id: string;
  username: string;
  caps: number;
  score: number;
  title: string;
  avatar: StabilityAvatar;
}

export const SAME_AVATAR: StabilityAvatar = {
  head: 'Men_head_Worker_0',
  body: 'Men_body_Worker_0',
  legs: 'Men_legs_Worker_0',
  feet: 'Men_feet_Worker_0',
  accessory: 'none',
  animation: 'Idle',
  gender: 'Men',
};

const VARIED_AVATARS: StabilityAvatar[] = [
  { ...SAME_AVATAR, accessory: 'Men_accessory_Kart_3000' },
  { ...SAME_AVATAR, accessory: 'Men_accessory_RacingBulls_5000' },
  { ...SAME_AVATAR, accessory: 'Men_accessory_Backpack_0' },
  {
    head: 'Women_head_SciFi_150',
    body: 'Women_body_SciFi_300',
    legs: 'Women_legs_SciFi_200',
    feet: 'Women_feet_SciFi_100',
    accessory: 'none',
    animation: 'Idle',
    gender: 'Women',
  },
  {
    head: 'Women_head_SciFi_150',
    body: 'Women_body_SciFi_300',
    legs: 'Women_legs_SciFi_200',
    feet: 'Women_feet_SciFi_100',
    accessory: 'Women_accessory_Charmander_2000',
    animation: 'Idle',
    gender: 'Women',
  },
  {
    head: 'Women_head_Worker_0',
    body: 'Women_body_Worker_0',
    legs: 'Women_legs_Worker_0',
    feet: 'Women_feet_Worker_0',
    accessory: 'Women_accessory_Beer_500',
    animation: 'Idle',
    gender: 'Women',
  },
  {
    head: 'Men_head_Suit_150',
    body: 'Men_body_Suit_300',
    legs: 'Men_legs_Suit_200',
    feet: 'Men_feet_Suit_100',
    accessory: 'Men_accessory_Beer_500',
    animation: 'Idle',
    gender: 'Men',
  },
  {
    head: 'Men_head_Swat_150',
    body: 'Men_body_Swat_300',
    legs: 'Men_legs_Swat_200',
    feet: 'Men_feet_Swat_100',
    accessory: 'none',
    animation: 'Idle',
    gender: 'Men',
  },
];

export const STABILITY_SQUAD: Squad = {
  id: 900001,
  name: 'Squad stabilité',
  icon: 'beer',
  color: '#F59E0B',
  invite_code: 'STAB01',
};

export function makeStabilityConnections(): StabilityConnection[] {
  return Array.from({ length: 30 }, (_, index) => {
    const avatar = index < 10
      ? { ...SAME_AVATAR }
      : { ...VARIED_AVATARS[(index - 10) % VARIED_AVATARS.length] };
    return {
      id: `conn_${index + 1}`,
      username: `Camarade_${index + 1}`,
      caps: (index + 1) * 10,
      score: (index + 1) * 100,
      title: index % 2 === 0 ? 'Vétéran du Bar' : 'Novice de l’Apéro',
      avatar,
    };
  });
}

export function avatarModelNames(avatar: StabilityAvatar): string[] {
  return [avatar.head, avatar.body, avatar.legs, avatar.feet, avatar.accessory]
    .filter(part => part && part !== 'none')
    .map(part => `${part}.fbx`);
}

export function assertModelWhitelist(allowed: ReadonlySet<string>, requested: readonly string[]): void {
  const unknown = requested.filter(name => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(`Modèle(s) hors whitelist : ${unknown.join(', ')}`);
  }
}

export function assertSingleDocument(documents: readonly string[]): void {
  if (documents.length !== 1) {
    throw new Error(`Le document a été rechargé : ${documents.length} requêtes document`);
  }
}

export function assertFrames(drawCalls: number, label: string): void {
  if (!Number.isFinite(drawCalls) || drawCalls <= 0) {
    throw new Error(`${label} : aucune frame réelle (draw calls = ${drawCalls})`);
  }
}

export function assertBoundedGrowth(
  warmupCreated: number,
  finalCreated: number,
  measuredCycles: number,
  maxPerCycle = 6,
): void {
  const growth = finalCreated - warmupCreated;
  if (!Number.isFinite(growth) || growth < 0 || growth > measuredCycles * maxPerCycle) {
    throw new Error(
      `Croissance des contextes non bornée : ${growth} sur ${measuredCycles} cycles (max ${measuredCycles * maxPerCycle})`,
    );
  }
}

export interface StabilityFixtureOptions {
  avatar?: StabilityAvatar;
  connections?: StabilityConnection[];
}

export async function installStabilityFixtures(
  context: BrowserContext,
  options: StabilityFixtureOptions = {},
) {
  const avatar = options.avatar ?? SAME_AVATAR;
  const connections = options.connections ?? makeStabilityConnections();
  const modelNames = new Set<string>(['Animations.fbx']);
  for (const config of [avatar, ...connections.map(connection => connection.avatar)]) {
    for (const name of avatarModelNames(config)) modelNames.add(name);
  }

  const backendRoot = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(process.cwd(), '../beercall-backend');
  const modelRoot = resolve(backendRoot, 'static/models');
  const models = new Map<string, { buffer: Buffer; sha256: string }>();
  for (const name of modelNames) {
    const buffer = await readFile(resolve(modelRoot, name));
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    expect(buffer.byteLength, `${name} non vide`).toBeGreaterThan(0);
    models.set(name, { buffer, sha256 });
  }
  expect(models.get('Animations.fbx')?.sha256, 'Hash Animations.fbx').toBe(ANIMATIONS_SHA256);

  const modelHits = new Map<string, number>();
  const modelFailures: string[] = [];
  const profile: UserProfile = {
    id: 900001,
    username: 'FixtureUser',
    caps: 100,
    score: 42,
    title: 'Rang test',
    avatar,
    shop_items: [],
    squads: [STABILITY_SQUAD],
    unlocked_badges: [],
    stats: {
      aperos_created: 1,
      aperos_joined: 2,
      aperos_declined: 3,
      aperos_missed: 0,
      fraud_count: 0,
    },
  };

  const simulations: ApiSimulation[] = [
    {
      method: 'GET',
      path: '/api/auth/profile',
      respond: async route => {
        await route.fulfill({ status: 200, json: profile });
      },
    },
    {
      method: 'GET',
      path: '/api/auth/connections',
      respond: async route => {
        await route.fulfill({ status: 200, json: connections });
      },
    },
  ];

  const isolation = await installUxFixtures(context, {
    profileMode: 'own',
    assets: true,
    squads: [STABILITY_SQUAD],
    simulations,
  });

  await context.route('https://basemaps.cartocdn.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/style.json')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          name: 'stability-local',
          sources: {},
          layers: [
            {
              id: 'background',
              type: 'background',
              paint: { 'background-color': '#e5e7eb' },
            },
          ],
        }),
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await context.route('**/models/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/models/prepared/manifest.json') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: 1, threeRevision: '183', models: {} }),
      });
    }
    if (!path.startsWith('/models/')) {
      modelFailures.push(`Chemin modèle inattendu : ${path}`);
      return route.abort();
    }
    const name = decodeURIComponent(path.slice('/models/'.length));
    const model = models.get(name);
    if (!model) {
      modelFailures.push(`Modèle non autorisé : ${name}`);
      return route.abort();
    }
    modelHits.set(name, (modelHits.get(name) ?? 0) + 1);
    return route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: model.buffer,
    });
  });

  await context.grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:8080' });
  await context.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });

  return {
    avatar,
    connections,
    isolation,
    models,
    modelHits,
    modelFailures,
    assertModels() {
      expect(modelFailures, 'Aucun modèle hors whitelist').toEqual([]);
      expect(modelHits.size, 'Au moins un modèle réel servi').toBeGreaterThan(0);
      for (const [name, model] of models) {
        expect(model.sha256, `Hash ${name}`).toMatch(/^[0-9a-f]{64}$/);
      }
    },
  };
}
