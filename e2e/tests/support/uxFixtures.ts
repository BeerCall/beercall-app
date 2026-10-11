import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type BrowserContext, type Route } from '@playwright/test';
import type { BeerCall, Squad, SquadDetails } from '../../../../beercall-frontend/src/types/api';
import type { ShopItem, UserProfile } from '../../../../beercall-frontend/src/hooks/useProfile';

export const ANIMATIONS_SHA256 = 'b455d642cd874130c3aba3ae03b207cc67c1817af3881cfbc3877e0921748d6e';
export const fixtureAvatar: UserProfile['avatar'] = {
  head: 'none', body: 'none', legs: 'none', feet: 'none', accessory: 'none',
  animation: 'Idle', gender: 'Men',
};
export const fixtureCatalogue: ShopItem[] = [
  { id: 'none', name: 'Sans couvre-chef', category: 'head', gender: 'Men', price: 0, is_owned: true },
  { id: 'owned-test', name: 'Article possédé test', category: 'head', gender: 'Men', price: 0, is_owned: true },
];
export const fixtureCall: BeerCall = {
  id: 'bc_900001', creator_name: 'FixtureUser', creator_id: 900001,
  location_name: 'Lieu test', longitude: 2.3522, latitude: 48.8566,
  status: 'active', started_at: new Date().toISOString(), participants_count: 1,
  has_responded: false, user_status: null, can_start: false,
};
export function makeSquads(count: number): Squad[] {
  const names = ['Les amis du quartier — équipe du vendredi', 'Les amis du quartier — équipe du samedi', 'S'.repeat(120)];
  return Array.from({ length: count }, (_, i) => ({
    id: 900001 + i, name: names[i] ?? `Squad test ${i + 1}`,
    icon: 'beer', color: '#F59E0B', invite_code: `TEST${i}`,
  }));
}

type FixtureProfile = Omit<UserProfile, 'avatar'> & { avatar: UserProfile['avatar'] | null };
export interface ApiSimulation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string | RegExp;
  respond: (route: Route) => Promise<void>;
}
export interface UxOptions {
  authenticated?: boolean;
  profileMode?: 'dashboard' | 'own' | 'readonly';
  assets?: boolean;
  catalogue?: 'ready' | 'delayed' | 'error';
  catalogueDelayMs?: number;
  shopItems?: ShopItem[];
  squads?: Squad[];
  currentSquadId?: number;
  calls?: BeerCall[];
  simulations?: ApiSimulation[];
}

const firebaseHost = /(^|\.)(firebaseio\.com|firebasedatabase\.app|googleapis\.com|firebaseapp\.com|gstatic\.com)$/;

/** Install on the context before navigation so popups/new pages cannot bypass isolation. */
export async function installUxFixtures(context: BrowserContext, options: UxOptions = {}) {
  const failures: string[] = [];
  const pageErrors: string[] = [];
  const assetHits = { fbx: 0, hdr: 0, hash: '' };
  const blockedFirebase: string[] = [];
  const squads = options.squads ?? makeSquads(1);
  const selectedId = options.currentSquadId ?? squads[0]?.id ?? 900001;
  const catalogue = options.shopItems ?? fixtureCatalogue;
  const profile: FixtureProfile = {
    id: 900001, username: 'FixtureUser', caps: 100, score: 42, title: 'Rang test',
    avatar: options.profileMode === 'dashboard' || !options.profileMode ? null : { ...fixtureAvatar },
    shop_items: catalogue, squads, unlocked_badges: [],
    stats: { aperos_created: 1, aperos_joined: 2, aperos_declined: 3, aperos_missed: 0, fraud_count: 0 },
  };
  let animations: Buffer | undefined;
  if (options.assets) {
    animations = await readFile(resolve(process.cwd(), '../../beercall-backend/static/models/Animations.fbx'));
    assetHits.hash = createHash('sha256').update(animations).digest('hex');
    expect(assetHits.hash, 'FBX local vérifié, sans téléchargement').toBe(ANIMATIONS_SHA256);
  }
  const hdr = Buffer.concat([
    Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n', 'ascii'),
    Buffer.from([128, 128, 128, 129]),
  ]);
  const attachPage = (page: import('@playwright/test').Page) => {
    page.on('pageerror', error => pageErrors.push(error.message));
  };
  context.pages().forEach(attachPage);
  context.on('page', attachPage);
  await context.addInitScript(({ authenticated }) => {
    if (window.location.origin !== 'http://127.0.0.1:4173') return;
    localStorage.clear();
    if (authenticated) {
      localStorage.setItem('user-storage', JSON.stringify({ state: { isAuthenticated: true, username: 'FixtureUser' }, version: 0 }));
      localStorage.setItem('token', 'ux-fixture-token-not-valid');
    }
  }, { authenticated: options.authenticated ?? true });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (firebaseHost.test(url.hostname)) blockedFirebase.push(socket.url());
    else failures.push(`WebSocket non simulé : ${socket.url()}`);
    socket.close();
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/$/, '');
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (url.port === '8000') {
      failures.push(`Backend interdit : ${request.url()}`);
      return route.abort();
    }
    if (path.endsWith('/potsdamer_platz_1k.hdr') && options.assets) {
      assetHits.hdr++;
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: hdr });
    }
    if (path.startsWith('/models/')) {
      if (path === '/models/Animations.fbx' && animations && method === 'GET') {
        assetHits.fbx++;
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: animations });
      }
      failures.push(`Modèle non autorisé : ${request.url()}`);
      return route.abort();
    }
    if (firebaseHost.test(url.hostname)) {
      blockedFirebase.push(request.url());
      return route.abort();
    }
    if (path.startsWith('/api/')) {
      const simulation = options.simulations?.find(s => s.method === method &&
        (typeof s.path === 'string' ? s.path.replace(/\/$/, '') === path : s.path.test(path)));
      if (simulation) return simulation.respond(route);
      if (method === 'POST' && /^\/api\/squads\/\d+\/ws-ticket$/.test(path)) {
        return json({ detail: 'WebSocket désactivé dans le harnais isolé' }, 403);
      }
      if (method === 'GET') {
        if (/^\/api\/auth\/profile(?:\/\d+)?$/.test(path)) {
          if (!options.authenticated && options.authenticated !== undefined) {
            if (options.catalogue === 'delayed') await new Promise(resolveDelay => setTimeout(resolveDelay, options.catalogueDelayMs ?? 4000));
            if (options.catalogue === 'error') return json({ detail: 'Catalogue indisponible' }, 500);
          }
          return json(profile);
        }
        if (path === '/api/squads') return json(squads);
        if (/^\/api\/squads\/\d+$/.test(path)) {
          const id = Number(path.split('/').at(-1));
          const squad = squads.find(s => s.id === id);
          if (!squad) return json({ detail: 'Squad introuvable' }, 404);
          const details: SquadDetails = {
            ...squad, id: String(id), invite_code: squad.invite_code ?? 'TEST',
            active_beer_call: options.calls ?? (id === selectedId ? [{ ...fixtureCall }] : []),
            scheduled_beer_calls: [], past_beer_calls: [],
          };
          return json(details);
        }
        if (/^\/api\/squads\/\d+\/beer-calls\/[^/]+\/worlds$/.test(path)) {
          return json({ worlds: { bar: { participants: [] }, piscine: { participants: [] }, dodo: { participants: [] } } });
        }
      }
      failures.push(`API non simulée : ${method} ${path}`);
      return json({ detail: 'Requête bloquée par le harnais UX' }, 403);
    }
    if (!['GET', 'HEAD'].includes(method)) {
      failures.push(`Écriture non autorisée : ${method} ${request.url()}`);
      return route.abort();
    }
    return route.continue();
  });
  return {
    assetHits, failures, pageErrors, blockedFirebase,
    assertIsolated() {
      expect(failures, 'Aucune requête non simulée').toEqual([]);
      expect(pageErrors, 'Aucune erreur applicative').toEqual([]);
    },
    assertAssets() {
      expect(assetHits.hash).toBe(ANIMATIONS_SHA256);
      expect(assetHits.fbx, 'Animations FBX interceptées').toBeGreaterThan(0);
      expect(assetHits.hdr, 'HDR mémoire intercepté').toBeGreaterThan(0);
    },
  };
}
