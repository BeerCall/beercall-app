import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type BrowserContext, type Route } from '@playwright/test';
import type { BeerCall, Squad, SquadDetails } from '../../../beercall-frontend/src/types/api';
import type { ShopItem, UserProfile } from '../../../beercall-frontend/src/hooks/useProfile';

export const ANIMATIONS_SHA256 = 'b455d642cd874130c3aba3ae03b207cc67c1817af3881cfbc3877e0921748d6e';

export type AnimationProtocol = 'legacy' | 'packs';

export function getHdrExpectation(): 'required' | 'absent' {
  const value = process.env.BEERCALL_EXPECT_HDR ?? 'absent';
  if (value !== 'required' && value !== 'absent') throw new Error(`Protocole HDR inconnu : ${value}`);
  return value;
}

export function getAnimationProtocol(): AnimationProtocol {
  const envVal = process.env.BEERCALL_EXPECT_ANIMATION_PROTOCOL;
  if (!envVal) return 'packs';
  if (envVal === 'legacy' || envVal === 'packs') return envVal;
  throw new Error(`Protocole d'animation inconnu : "${envVal}". Valeurs acceptées : "legacy" ou "packs"`);
}
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
  let rawFbxHits = 0;
  let manifestHits = 0;
  let idleHits = 0;
  let deferredHits = 0;
  let hdrHits = 0;

  let fbxHash = '';
  let manifestHash = '';
  let idleHash = '';
  let deferredHash = '';

  const assetHits = {
    get fbx() {
      const protocol = getAnimationProtocol();
      if (protocol === 'legacy') return rawFbxHits;
      return rawFbxHits > 0 ? rawFbxHits : idleHits;
    },
    set fbx(val: number) {
      rawFbxHits = val;
    },
    get rawFbx() {
      return rawFbxHits;
    },
    get manifest() {
      return manifestHits;
    },
    set manifest(val: number) {
      manifestHits = val;
    },
    get idle() {
      return idleHits;
    },
    set idle(val: number) {
      idleHits = val;
    },
    get deferred() {
      return deferredHits;
    },
    set deferred(val: number) {
      deferredHits = val;
    },
    get hdr() {
      return hdrHits;
    },
    set hdr(val: number) {
      hdrHits = val;
    },
    get hash() {
      return fbxHash;
    },
    set hash(val: string) {
      fbxHash = val;
    },
    get manifestHash() {
      return manifestHash;
    },
    get idleHash() {
      return idleHash;
    },
    get deferredHash() {
      return deferredHash;
    },
  };
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
  let manifestBuffer: Buffer | undefined;
  let idleBuffer: Buffer | undefined;
  let deferredBuffer: Buffer | undefined;
  let manifest: {
    formatVersion: number;
    sourceHash: string;
    critical: { file: string; url: string; sha256: string; byteLength: number };
    deferred: { file: string; url: string; sha256: string; byteLength: number };
  } | undefined;

  if (options.assets) {
    const backendRoot = process.env.BEERCALL_WORKSPACE_BACKEND ?? resolve(process.cwd(), '../beercall-backend');
    const backendFbx = resolve(backendRoot, 'static/models/Animations.fbx');
    animations = await readFile(backendFbx);
    fbxHash = createHash('sha256').update(animations).digest('hex');
    expect(fbxHash, 'FBX local vérifié, sans téléchargement').toBe(ANIMATIONS_SHA256);

    const frontendRoot = process.env.BEERCALL_WORKSPACE_FRONTEND ?? resolve(process.cwd(), '../beercall-frontend');
    const animDir = resolve(frontendRoot, 'public/animations');
    manifestBuffer = await readFile(resolve(animDir, 'manifest.json'));
    manifestHash = createHash('sha256').update(manifestBuffer).digest('hex');
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
    expect(manifest.formatVersion, 'Format version du manifeste').toBe(1);
    expect(manifest.sourceHash, 'Source hash du manifeste').toBe(ANIMATIONS_SHA256);

    idleBuffer = await readFile(resolve(animDir, manifest.critical.file));
    idleHash = createHash('sha256').update(idleBuffer).digest('hex');
    expect(idleHash, 'Hash pack critique').toBe(manifest.critical.sha256);
    expect(idleBuffer.byteLength, 'Taille pack critique').toBe(manifest.critical.byteLength);

    deferredBuffer = await readFile(resolve(animDir, manifest.deferred.file));
    deferredHash = createHash('sha256').update(deferredBuffer).digest('hex');
    expect(deferredHash, 'Hash pack différé').toBe(manifest.deferred.sha256);
    expect(deferredBuffer.byteLength, 'Taille pack différé').toBe(manifest.deferred.byteLength);
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
    // 8080 = stack Docker E2E (CI), 4173 = preview Vite local (playwright.ux.config.ts).
    if (!['8080', '4173'].includes(window.location.port)) return;
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
      if (getHdrExpectation() === 'absent') {
        failures.push('HDR interdit dans le build optimisé');
        return route.abort();
      }
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: hdr });
    }
    if (path.startsWith('/models/')) {
      if (path === '/models/Animations.fbx' && animations && method === 'GET') {
        rawFbxHits++;
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: animations });
      }
      failures.push(`Modèle non autorisé : ${request.url()}`);
      return route.abort();
    }
    if (path.startsWith('/animations/')) {
      if (options.assets && method === 'GET') {
        if (path === '/animations/manifest.json' && manifestBuffer) {
          manifestHits++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: manifestBuffer });
        }
        if (manifest && path === manifest.critical.url && idleBuffer) {
          idleHits++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: idleBuffer });
        }
        if (manifest && path === manifest.deferred.url && deferredBuffer) {
          deferredHits++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: deferredBuffer });
        }
      }
      failures.push(`Animation non autorisée : ${request.url()}`);
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
    async assertHdr() {
      if (getHdrExpectation() === 'required') await expect.poll(() => hdrHits).toBeGreaterThan(0);
      else expect(hdrHits, 'Aucun HDR dans le build optimisé').toBe(0);
    },
    assertAssets(expectedProtocol?: AnimationProtocol) {
      const protocol = expectedProtocol ?? getAnimationProtocol();
      if (getHdrExpectation() === 'required') expect(hdrHits, 'HDR mémoire intercepté').toBeGreaterThan(0);
      else expect(hdrHits, 'Aucun HDR dans le build optimisé').toBe(0);
      if (protocol === 'legacy') {
        expect(fbxHash, 'Hash FBX vérifié').toBe(ANIMATIONS_SHA256);
        expect(rawFbxHits, 'Animations FBX interceptées (protocole legacy)').toBeGreaterThan(0);
        expect(manifestHits, 'Aucun manifeste attendu en protocole legacy').toBe(0);
        expect(idleHits, 'Aucun pack critique attendu en protocole legacy').toBe(0);
        expect(deferredHits, 'Aucun pack différé attendu en protocole legacy').toBe(0);
      } else if (protocol === 'packs') {
        expect(rawFbxHits, "Absence totale d'Animations.fbx en protocole packs").toBe(0);
        expect(manifestHits, "Manifeste d'animation intercepté").toBeGreaterThan(0);
        expect(idleHits, 'Pack critique Idle intercepté').toBeGreaterThan(0);
        expect(manifestHash, "Hash manifeste d'animation vérifié").toMatch(/^[0-9a-f]{64}$/);
        expect(idleHash, 'Hash pack critique').toBe(manifest?.critical.sha256);
        if (deferredHits > 0) {
          expect(deferredHash, 'Hash pack différé').toBe(manifest?.deferred.sha256);
        }
      }
    },
  };
}
