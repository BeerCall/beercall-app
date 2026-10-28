import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { installUxFixtures, type InstalledFixtures } from './support/uxFixtures';

const MEN = {
  gender: 'Men',
  head: 'Men_head_Worker_0',
  body: 'Men_body_Worker_0',
  legs: 'Men_legs_Worker_0',
  feet: 'Men_feet_Worker_0',
  accessory: 'none',
  animation: 'Idle',
};
const MEN_KART = { ...MEN, accessory: 'Men_accessory_Kart_3000' };
const MEN_BULLS = { ...MEN, accessory: 'Men_accessory_RacingBulls_5000' };

const WOMEN = {
  gender: 'Women',
  head: 'Women_head_SciFi_150',
  body: 'Women_body_SciFi_300',
  legs: 'Women_legs_SciFi_200',
  feet: 'Women_feet_SciFi_100',
  accessory: 'none',
  animation: 'Idle',
};
const WOMEN_CHARMANDER = { ...WOMEN, accessory: 'Women_accessory_Charmander_2000' };

const OUTFITS = [MEN, MEN_KART, MEN_BULLS, WOMEN, WOMEN_CHARMANDER];

const HASHES: Record<string, string> = {
  Men_head_Worker_0: '12f57b247785740196717060cf3d9c26cd901a79b3bc77c40bc3bf7f91cd883e',
  Men_body_Worker_0: '069ab65c35f3d2ea7a46b84fbec97025d3f5312893c8061779a516836112ab48',
  Men_legs_Worker_0: '812c4123fb4087eed0cd5d8f7df16b6a6fc678ec3b6f4edfec0e35e5f51ab464',
  Men_feet_Worker_0: 'a4fc307ed84819bbbedaa5a8e8226505dbe585d8f97aee2e29c3f0b1c3e9e28f',
  Men_accessory_Kart_3000: '543d1fa1e9a098dd6bea74621b180b12d9dc996b299a6414a2fae65a2f7b97ad',
  Men_accessory_RacingBulls_5000: 'f2946881c7b0ce86ee946351857fc82188c96362526a0234fb698fae5e7f3304',
  Women_head_SciFi_150: '9f2ffe15e2cc7f6b7928207937c106340469a58dc2a6d949de147865d398797b',
  Women_body_SciFi_300: '595097187fcd89bfbf8dd2e06eecb932e2c8f9ded42864c8ce0691102c1097a1',
  Women_legs_SciFi_200: '9700b8acf04e710b6eae7bf62ddc763badfb6c53b053611a5d496773e2e01dfe',
  Women_feet_SciFi_100: '7e10a8cea954417fd3f7ad3c174ed636803e9a73d73782068aea6f3a92c8304e',
  Women_accessory_Charmander_2000: 'b3306b9f8646890f21916c41de2b0a653fae66ff500216a53601f069ea482a58',
};

export type Sample = {
  meshes: { skinned: boolean; min: number[]; max: number[]; corners: number[][] }[];
  totalMeshes: number;
  partKeys: string[];
  min: number[];
  max: number[];
  center: number[];
  camera: number[];
  view: number[];
  projection: number[];
  calls: number;
  frame: number;
  elapsed: number;
  frameloop?: string;
};

// Observation du renderer via le hook global DevTools standard sans fortes références
// aux groupes démontés. Restauration de l'état d'origine au teardown.
async function observeRenderer(page: Page) {
  await page.addInitScript(() => {
    type Vector = { x: number; y: number; z: number; clone(): Vector; applyMatrix4(m: unknown): Vector; project(c: unknown): Vector; toArray(): number[] };
    type Box = { min: Vector; max: Vector; clone(): Box; applyMatrix4(m: unknown): Box; union(b: Box): Box; isEmpty(): boolean };
    type Object3D = {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      visible: boolean;
      userData?: { partKey?: string };
      matrixWorld: unknown;
      boundingBox?: Box;
      geometry?: { boundingBox?: Box; computeBoundingBox(): void };
      computeBoundingBox?(): void;
      updateMatrixWorld(force: boolean): void;
      traverse(fn: (o: Object3D) => void): void;
      __r3f?: { root: { getState(): State } };
    };
    type State = {
      frameloop: string;
      gl: { domElement: HTMLCanvasElement; info: { render: { calls: number; frame: number } } };
      camera: { position: Vector; matrixWorldInverse: { toArray(): number[] }; projectionMatrix: { toArray(): number[] } };
      clock: { elapsedTime: number };
    };
    type Fiber = {
      child?: Fiber;
      sibling?: Fiber;
      memoizedProps?: {
        config?: any;
        groupRef?: { current?: Object3D };
        client?: { invalidateQueries: Function };
      };
      memoizedState?: any;
      type?: any;
    };

    const canvasToGroup = new WeakMap<HTMLCanvasElement, Object3D>();
    const activeGroups = new Set<Object3D>();

    // Conserver l'éventuel hook préexistant
    (window as any).__prevDevToolsHook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;

    const hook = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: unknown) {
        const id = this.renderers.size + 1;
        this.renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        const visit = (fiber: any) => {
          if (!fiber) return;
          const props = fiber.memoizedProps;
          // Capture non intrusive de QueryClient pour invalidation en place
          if (props?.client && typeof props.client.invalidateQueries === 'function') {
            (window as any).__queryClient = props.client;
          }
          if (props?.config?.head && props.groupRef?.current) {
            const group = props.groupRef.current;
            activeGroups.add(group);
            const state = group.__r3f?.root?.getState?.();
            if (state?.gl?.domElement) {
              canvasToGroup.set(state.gl.domElement, group);
            }
          }
          if (fiber.child) visit(fiber.child);
          if (fiber.sibling) visit(fiber.sibling);
        };
        visit(root.current);
      },
      onCommitFiberUnmount(fiber: any) {
        const group = fiber?.memoizedProps?.groupRef?.current;
        if (group) {
          activeGroups.delete(group);
        }
      },
    };

    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

    (window as any).__readFraming = (canvas: HTMLCanvasElement): Sample | null => {
      let group = canvasToGroup.get(canvas);
      if (!group) {
        for (const g of activeGroups) {
          const state = g.__r3f?.root?.getState?.();
          if (state?.gl?.domElement === canvas) {
            group = g;
            canvasToGroup.set(canvas, g);
            break;
          }
        }
      }
      if (!group) return null;
      const state = group.__r3f?.root?.getState?.();
      if (!state || state.gl.domElement !== canvas) return null;

      group.updateMatrixWorld(true);
      let union: Box | undefined;
      const meshes: { skinned: boolean; min: number[]; max: number[]; corners: number[][] }[] = [];
      const partKeys = new Set<string>();
      let totalMeshes = 0;

      group.traverse((obj: Object3D) => {
        if (obj.userData?.partKey && typeof obj.userData.partKey === 'string') {
          partKeys.add(obj.userData.partKey);
        }
        if (!obj.isMesh || !obj.visible) return;
        totalMeshes++;
        if (obj.isSkinnedMesh) obj.computeBoundingBox?.();
        else if (!obj.geometry?.boundingBox) obj.geometry?.computeBoundingBox();
        const local = obj.isSkinnedMesh ? obj.boundingBox : obj.geometry?.boundingBox;
        if (!local || local.isEmpty()) return;
        const box = local.clone().applyMatrix4(obj.matrixWorld);
        if (union) union.union(box); else union = box.clone();
        const corners: number[][] = [];
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              const p = box.min.clone();
              Object.assign(p, { x, y, z });
              corners.push(p.project(state.camera).toArray());
            }
          }
        }
        meshes.push({
          skinned: Boolean(obj.isSkinnedMesh),
          min: box.min.toArray(),
          max: box.max.toArray(),
          corners,
        });
      });

      if (!union) return null;
      const center = union.min.clone();
      Object.assign(center, {
        x: (union.min.x + union.max.x) / 2,
        y: (union.min.y + union.max.y) / 2,
        z: (union.min.z + union.max.z) / 2,
      });

      return {
        meshes,
        totalMeshes,
        partKeys: Array.from(partKeys),
        min: union.min.toArray(),
        max: union.max.toArray(),
        center: center.project(state.camera).toArray(),
        camera: state.camera.position.toArray(),
        view: state.camera.matrixWorldInverse.toArray(),
        projection: state.camera.projectionMatrix.toArray(),
        ...state.gl.info.render,
        elapsed: state.clock.elapsedTime,
        frameloop: state.frameloop,
      };
    };
  });
}

async function teardownObserver(page: Page) {
  await page.evaluate(() => {
    delete (window as any).__readFraming;
    delete (window as any).__queryClient;
    if ('__prevDevToolsHook' in window) {
      (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = (window as any).__prevDevToolsHook;
      delete (window as any).__prevDevToolsHook;
    }
  }).catch(() => {});
}

let cachedModels: Map<string, Buffer> | null = null;
async function getCachedModels(): Promise<Map<string, Buffer>> {
  if (cachedModels) return cachedModels;
  const models = new Map<string, Buffer>();
  const root = resolve(process.env.BEERCALL_WORKSPACE_BACKEND!, 'static/models');
  for (const [name, hash] of Object.entries(HASHES)) {
    const file = resolve(root, `${name}.fbx`);
    const rel = relative(root, file);
    expect(isAbsolute(rel) || rel.startsWith('..')).toBe(false);
    const buffer = await readFile(file);
    expect(createHash('sha256').update(buffer).digest('hex'), name).toBe(hash);
    models.set(`${name}.fbx`, buffer);
  }
  cachedModels = models;
  return models;
}

interface HarnessState {
  models: Map<string, Buffer>;
  hits: Set<string>;
  failures: string[];
  isolation: InstalledFixtures;
  setFriends: (friends: any[]) => void;
}

async function setupHarness(context: BrowserContext, page: Page, initialFriends?: any[]): Promise<HarnessState> {
  await observeRenderer(page);
  const models = await getCachedModels();
  const hits = new Set<string>();
  const failures: string[] = [];
  const preparedMode = process.env.BEERCALL_PREPARED_THUMBNAILS === '1';
  const preparedModels = new Map<string, { name: string; buffer: Buffer }>();
  const preparedManifest: { version: number; threeRevision: string; models: Record<string, { file: string; sha256: string; bytes: number; sourceSha256: string }> } = {
    version: 1, threeRevision: '183', models: {},
  };
  if (preparedMode) {
    const root = resolve(process.env.BEERCALL_WORKSPACE_BACKEND!, 'static/models/prepared');
    const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')) as typeof preparedManifest;
    for (const [name, hash] of Object.entries(HASHES)) {
      const entry = manifest.models[`${name}.fbx`];
      expect(entry.sourceSha256, 'prepared asset matches the unchanged FBX fixture').toBe(hash);
      const file = resolve(root, entry.file);
      expect(relative(root, file).startsWith('..') || isAbsolute(relative(root, file))).toBe(false);
      const buffer = await readFile(file);
      expect(createHash('sha256').update(buffer).digest('hex')).toBe(entry.sha256);
      preparedManifest.models[`${name}.fbx`] = entry;
      preparedModels.set(entry.file, { name: `${name}.fbx`, buffer });
    }
  }

  let currentFriends = initialFriends ?? Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1),
    username: `Cadre${i + 1}`,
    caps: 123,
    score: 456,
    title: 'Pilier',
    avatar: OUTFITS[i % OUTFITS.length],
  }));

  const isolation = await installUxFixtures(context, {
    assets: true,
    simulations: [
      {
        method: 'GET',
        path: '/api/auth/connections',
        respond: route => route.fulfill({ json: currentFriends }),
      },
      {
        method: 'GET',
        path: /^\/api\/auth\/profile(?:\/\d+)?$/,
        respond: route => route.fulfill({
          json: {
            id: 900001,
            username: 'FixtureUser',
            caps: 100,
            score: 42,
            title: 'Pilier',
            avatar: MEN,
            shop_items: [],
            squads: [],
            unlocked_badges: [],
            stats: {},
          },
        }),
      },
    ],
  });

  await context.route('**/models/**', async (route: any) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/models/prepared/manifest.json') {
      return route.fulfill({ json: preparedManifest });
    }
    if (preparedMode && path.startsWith('/models/prepared/')) {
      const model = preparedModels.get(path.slice('/models/prepared/'.length));
      if (!model || route.request().method() !== 'GET') {
        failures.push(path);
        return route.abort();
      }
      hits.add(model.name);
      return route.fulfill({ contentType: 'application/octet-stream', body: model.buffer });
    }
    const name = decodeURIComponent(path.slice('/models/'.length));
    const buffer = models.get(name);
    if (!buffer || route.request().method() !== 'GET') {
      failures.push(path);
      return route.abort();
    }
    hits.add(name);
    return route.fulfill({ contentType: 'application/octet-stream', body: buffer });
  });

  await context.route('https://basemaps.cartocdn.com/**', (route: any) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e5e7eb' } }],
      },
    })
  );

  await context.grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:8080' });
  await context.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });

  return {
    models,
    hits,
    failures,
    isolation,
    setFriends: (newFriends: any[]) => { currentFriends = newFriends; },
  };
}

async function openConnexionsPage(page: Page) {
  await page.goto('/');
  const map = page.locator('.maplibregl-canvas');
  await expect(map).toBeVisible();
  await map.evaluate(element => element.setAttribute('data-framing-map', 'retained'));
  await page.getByRole('button', { name: 'Connexions', exact: true }).click();
  await expect(page.getByTestId('avatar-thumb-1')).toBeVisible();
}

async function readSample(page: Page, id: number, timeoutMs = 45_000): Promise<Sample> {
  const thumb = page.getByTestId(`avatar-thumb-${id}`);
  await thumb.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await expect(thumb.locator('[data-avatar-framing="ready"]')).toBeVisible({ timeout: timeoutMs });
  const canvas = thumb.locator('canvas');
  const sample = await canvas.evaluate(element => {
    const reader = (window as any).__readFraming;
    return reader ? reader(element) : null;
  });
  expect(sample, 'Pose réelle lisible via le reconciler, pas seulement le diagnostic DOM').not.toBeNull();
  return sample!;
}

export function assertFramed(
  sample: Sample,
  expectedConfig: typeof MEN,
  width: number,
  height: number
) {
  // 1. Draw calls de la frame réelle
  expect(sample.calls, 'draw calls de la frame réelle').toBeGreaterThan(0);

  // 2. Meshes et pièces obligatoires
  expect(sample.totalMeshes, 'total meshes > 0').toBeGreaterThan(0);
  expect(sample.meshes.length, 'au moins 4 meshes').toBeGreaterThanOrEqual(4);
  expect(sample.meshes.filter(m => m.skinned).length, 'au moins 4 skinned meshes').toBeGreaterThanOrEqual(4);

  const expectedParts = ['head', 'body', 'legs', 'feet'];
  if (expectedConfig.accessory && expectedConfig.accessory !== 'none') {
    expectedParts.push('accessory');
  }
  for (const part of expectedParts) {
    expect(sample.partKeys, `pièce obligatoire ${part} présente`).toContain(part);
  }

  // 3. NDC <= 0.8 en continu
  for (const mesh of sample.meshes) {
    for (const point of mesh.corners) {
      expect(point.every(Number.isFinite)).toBe(true);
      expect(Math.abs(point[0]), 'marge horizontale 10 % pendant Idle (NDC <= 0.8)').toBeLessThanOrEqual(0.8001);
      expect(Math.abs(point[1]), 'marge verticale 10 % pendant Idle (NDC <= 0.8)').toBeLessThanOrEqual(0.8001);
      expect(Math.abs(point[2]), 'near/far depth NDC').toBeLessThan(1);
    }
  }

  // 4. Centre assemblage +-2px
  expect(Math.abs(sample.center[0]) * width / 2, 'centre assemblage X en pixels').toBeLessThanOrEqual(2);
  expect(Math.abs(sample.center[1]) * height / 2, 'centre assemblage Y en pixels').toBeLessThanOrEqual(2);

  // 5. Matrices 16 éléments finis
  expect(sample.view.length, 'matrice view 16 éléments').toBe(16);
  expect(sample.view.every(Number.isFinite), 'éléments view finis').toBe(true);
  expect(sample.projection.length, 'matrice projection 16 éléments').toBe(16);
  expect(sample.projection.every(Number.isFinite), 'éléments projection finis').toBe(true);
}

export function assertCameraStability(first: Sample, current: Sample) {
  // Delta caméra nul (pas de pompage)
  expect(current.camera, 'caméra sans pompage').toEqual(first.camera);
  expect(current.view, 'matrice view stable').toEqual(first.view);
  expect(current.projection, 'matrice projection stable').toEqual(first.projection);
}

// -----------------------------------------------------------------------------
// TESTS
// -----------------------------------------------------------------------------

test.describe('cadrage miniatures 3D (T08/T30c/T37)', () => {
  test('contrôles négatifs du cadrage (zero-mesh, pièce manquante, frame absente, hors marge, caméra mobile)', () => {
    const validSample: Sample = {
      meshes: [
        { skinned: true, min: [-10, 0, -10], max: [10, 50, 10], corners: [[-0.5, -0.5, 0.5], [0.5, 0.5, 0.5]] },
        { skinned: true, min: [-10, 50, -10], max: [10, 100, 10], corners: [[-0.5, -0.5, 0.5], [0.5, 0.5, 0.5]] },
        { skinned: true, min: [-10, 100, -10], max: [10, 150, 10], corners: [[-0.5, -0.5, 0.5], [0.5, 0.5, 0.5]] },
        { skinned: true, min: [-10, 150, -10], max: [10, 180, 10], corners: [[-0.5, -0.5, 0.5], [0.5, 0.5, 0.5]] },
      ],
      totalMeshes: 4,
      partKeys: ['head', 'body', 'legs', 'feet'],
      min: [-10, 0, -10],
      max: [10, 180, 10],
      center: [0, 0, 0],
      camera: [0, 90, 300],
      view: new Array(16).fill(1),
      projection: new Array(16).fill(1),
      calls: 10,
      frame: 1,
      elapsed: 1.0,
    };

    // Cas nominal valide
    expect(() => assertFramed(validSample, MEN, 100, 100)).not.toThrow();

    // 1. Contrôle négatif zero-mesh
    expect(() => assertFramed({ ...validSample, totalMeshes: 0, meshes: [] }, MEN, 100, 100)).toThrow();

    // 2. Contrôle négatif pièce manquante (head manquante, ou accessoire requis manquant)
    expect(() => assertFramed({ ...validSample, partKeys: ['body', 'legs', 'feet'] }, MEN, 100, 100)).toThrow(/head/);
    expect(() => assertFramed(validSample, MEN_KART, 100, 100)).toThrow(/accessory/);

    // 3. Contrôle négatif frame absente
    expect(() => assertFramed({ ...validSample, calls: 0 }, MEN, 100, 100)).toThrow();

    // 4. Contrôle négatif hors marge (NDC > 0.8)
    const outOfMargin = JSON.parse(JSON.stringify(validSample)) as Sample;
    outOfMargin.meshes[0].corners[0][0] = 0.85;
    expect(() => assertFramed(outOfMargin, MEN, 100, 100)).toThrow(/marge/);

    // 5. Contrôle négatif caméra mobile / pompage
    const shifted = { ...validSample, camera: [0, 90, 310] };
    expect(() => assertCameraStability(validSample, shifted)).toThrow(/pompage/);
  });

  test('mesure navigation vers les premières miniatures réellement soumises', async ({ context, page }, info) => {
    await setupHarness(context, page, [1, 2].map(id => ({
      id: String(id), username: `Cadre${id}`, caps: 123, score: 456, title: 'Pilier', avatar: MEN,
    })));
    await page.addInitScript(() => {
      const timings = { started: 0, ready: [] as { id: string; ms: number }[] };
      Object.assign(window, { __thumbnailTimings: timings });
      document.addEventListener('click', event => {
        const button = (event.target as Element).closest('button');
        if (button?.textContent?.trim() === 'Connexions') timings.started = performance.now();
      }, true);
      new MutationObserver(() => {
        if (!timings.started) return;
        for (const avatar of document.querySelectorAll('[data-testid^="avatar-thumb-"]')) {
          const id = avatar.getAttribute('data-testid')!;
          if (avatar.querySelector('[data-avatar-framing="ready"]') && !timings.ready.some(item => item.id === id)) {
            timings.ready.push({ id, ms: performance.now() - timings.started });
          }
        }
      }).observe(document, { subtree: true, attributes: true, childList: true });
    });
    await openConnexionsPage(page);
    for (const id of [1, 2]) await readSample(page, id);
    const timings = await page.evaluate(() => Reflect.get(window, '__thumbnailTimings') as { started: number; ready: { id: string; ms: number }[] });
    expect(timings.started).toBeGreaterThan(0);
    expect(timings.ready).toHaveLength(2);
    await info.attach('navigation-to-submitted-thumbnails', { body: JSON.stringify({
      prepared: process.env.BEERCALL_PREPARED_THUMBNAILS === '1', ...timings,
      limitation: 'Local desktop Chromium, not iPhone. Includes query, module, WebGL and real frame submission.',
    }), contentType: 'application/json' });
    console.log(JSON.stringify({ thumbnailNavigationTimings: timings }));
    await teardownObserver(page);
  });

  test('miniatures préparées en pause : révélation sans recréer les Canvas', async ({ context, page }, info) => {
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await setupHarness(context, page, [1, 2].map(id => ({
        id: String(id), username: `Cadre${id}`, caps: 123, score: 456, title: 'Pilier', avatar: MEN,
      })));
      await page.goto('/squad/900001');
      const retained = page.getByTestId('retained-connections');
      await expect(retained).toHaveAttribute('aria-hidden', 'true');
      await expect.poll(async () => page.locator('[data-testid^="avatar-thumb-"] canvas').evaluateAll(canvases => {
        const reader = Reflect.get(window, '__readFraming') as (canvas: Element) => Sample | null;
        return canvases.length === 2 && canvases.every(canvas => {
          const sample = reader(canvas);
          return sample && sample.calls > 0 && sample.frameloop === 'never';
        });
      }), { timeout: 45_000, message: 'Deux vrais buffers préparés, puis frameloops arrêtées hors route' }).toBe(true);
      const canvases = await page.locator('[data-testid^="avatar-thumb-"] canvas').elementHandles();
      await page.evaluate(() => {
        document.addEventListener('click', event => {
          if ((event.target as Element).closest('button')?.textContent?.trim() === 'Connexions') performance.mark('thumbnail-open');
        }, true);
        const retained = document.querySelector('[data-testid="retained-connections"]')!;
        new MutationObserver(() => {
          if (retained.getAttribute('aria-hidden') === 'false') performance.mark('thumbnail-revealed');
        }).observe(retained, { attributes: true, attributeFilter: ['aria-hidden'] });
      });
      await page.getByRole('button', { name: 'Connexions', exact: true }).click();
      await expect(retained).toHaveAttribute('aria-hidden', 'false');
      for (const canvas of canvases) expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
      const elapsed = await page.evaluate(() => performance.measure('thumbnail-reveal', 'thumbnail-open', 'thumbnail-revealed').duration);
      console.log(JSON.stringify({ preparedRevealMs: elapsed }));
      const revealSamples = [elapsed];
      for (const id of [1, 2]) {
        const sample = await readSample(page, id);
        const box = (await page.getByTestId(`avatar-thumb-${id}`).locator('canvas').boundingBox())!;
        assertFramed(sample, MEN, box.width, box.height);
      }
      await page.screenshot({ path: info.outputPath('prepared-first-opening.png') });
      await page.locator('header button').first().click();
      for (const canvas of canvases) expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
      for (let run = 1; run < 10; run++) {
        await page.getByRole('button', { name: 'Connexions', exact: true }).click();
        await expect(retained).toHaveAttribute('aria-hidden', 'false');
        revealSamples.push(await page.evaluate(() => performance.measure('thumbnail-reveal', 'thumbnail-open', 'thumbnail-revealed').duration));
        for (const canvas of canvases) expect(await canvas.evaluate(node => node.isConnected)).toBe(true);
        await page.locator('header button').first().click();
      }
      console.log(JSON.stringify({ preparedRevealSamplesMs: revealSamples }));
      await info.attach('prepared-reveal', { body: JSON.stringify({ samplesMs: revealSamples,
        scope: 'cached canvas reveal, not cold loading or physical iPhone display' }), contentType: 'application/json' });
    } finally {
      await teardownObserver(page);
    }
  });

  const OUTFIT_CASES = [
    { index: 0, id: 6, label: 'Men de base (Worker)', config: MEN },
    { index: 1, id: 7, label: 'Men + Kart 3000', config: MEN_KART },
    { index: 2, id: 8, label: 'Men + RacingBulls 5000', config: MEN_BULLS },
    { index: 3, id: 9, label: 'Women de base (SciFi)', config: WOMEN },
    { index: 4, id: 10, label: 'Women + Charmander 2000', config: WOMEN_CHARMANDER },
  ];

  for (const outfit of OUTFIT_CASES) {
    test(`tenue ${outfit.label} : cadrage Idle, matrices, NDC <= 0.8 et stabilité caméra (T08/T30c)`, async ({ context, page }, info) => {
      test.setTimeout(120_000);
      try {
        await setupHarness(context, page);
        await openConnexionsPage(page);

        const first = await readSample(page, outfit.id);
        const canvas = page.getByTestId(`avatar-thumb-${outfit.id}`).locator('canvas');
        const rect = (await canvas.boundingBox())!;

        if (process.env.BEERCALL_PREPARED_THUMBNAILS === '1') {
          const framingInfo = JSON.parse((await page.getByTestId(`avatar-thumb-${outfit.id}`)
            .locator('[data-avatar-framing-info]').getAttribute('data-avatar-framing-info'))!) as { cpuTimeMs: number; sampleCount: number };
          expect(framingInfo.sampleCount, 'offline bounds retain the full Idle sampling contract').toBeGreaterThanOrEqual(240);
          expect(framingInfo.cpuTimeMs, 'prepared framing CPU budget, not end-to-end iPhone latency').toBeLessThan(20);
          console.log(JSON.stringify({ outfit: outfit.label, framingInfo }));
          await info.attach('prepared-framing-budget', { body: JSON.stringify(framingInfo), contentType: 'application/json' });
        }

        // 1. Assert initial framing
        assertFramed(first, outfit.config, rect.width, rect.height);

        // 2. Vérifier budget : entre 1 et 2 canvases actifs dans le DOM
        const count = await page.locator('[data-testid^="avatar-thumb-"] canvas').count();
        expect(count, 'budget thumbnails max 2 slots').toBeGreaterThanOrEqual(1);
        expect(count, 'budget thumbnails max 2 slots').toBeLessThanOrEqual(2);

        // 3. Stabilité temporelle sur 3 frames / ticks (delta caméra nul, pose envelope stable)
        for (const moment of [500, 1000]) {
          await page.waitForTimeout(500);
          const current = await readSample(page, outfit.id);
          assertFramed(current, outfit.config, rect.width, rect.height);
          assertCameraStability(first, current);
          await page.screenshot({ path: info.outputPath(`framing-outfit-${outfit.index}-${moment}.png`) });
        }

        // 4. Géométrie de la carte dans le viewport
        const card = page.getByTestId(`avatar-thumb-${outfit.id}`).locator('../..');
        const geometry = await card.evaluate(element => {
          const r = element.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            children: [...element.children].map(child => {
              const b = child.getBoundingClientRect();
              return { left: b.left, right: b.right };
            }),
            rootWidth: document.documentElement.scrollWidth,
            width: innerWidth,
            scrollY,
          };
        });
        const vp = page.viewportSize()!;
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(vp.width);
        for (const child of geometry.children) {
          expect(child.left).toBeGreaterThanOrEqual(geometry.left);
          expect(child.right).toBeLessThanOrEqual(geometry.right);
        }
        expect(geometry.rootWidth).toBeLessThanOrEqual(geometry.width);
        expect(geometry.scrollY).toBe(0);
        await expect(card.getByText('123', { exact: true })).toBeVisible();
        await expect(card.getByText('456', { exact: true })).toBeVisible();
      } finally {
        await teardownObserver(page);
      }
    });
  }

  test('transitions multi-viewports (320, 360, 390, paysage 844x390 et desktop 1280x800)', async ({ context, page }, info) => {
    test.setTimeout(120_000);
    try {
      await setupHarness(context, page);
      await openConnexionsPage(page);

      const VIEWPORTS = [
        { width: 320, height: 568, name: '320p' },
        { width: 360, height: 800, name: '360p' },
        { width: 390, height: 844, name: '390p' },
        { width: 844, height: 390, name: '844l' },
        { width: 1280, height: 800, name: 'desktop' },
      ];

      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(150);

        const sample = await readSample(page, 6);
        const canvas = page.getByTestId('avatar-thumb-6').locator('canvas');
        const rect = (await canvas.boundingBox())!;

        assertFramed(sample, MEN, rect.width, rect.height);

        const card = page.getByTestId('avatar-thumb-6').locator('../..');
        const cardBox = (await card.boundingBox())!;
        expect(cardBox.x).toBeGreaterThanOrEqual(0);
        expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(vp.width + 1);

        await page.screenshot({ path: info.outputPath(`framing-viewport-${vp.name}.png`) });
      }
    } finally {
      await teardownObserver(page);
    }
  });

  test('changement de tenue en place via QueryClient sans démontage de canvas', async ({ context, page }, info) => {
    test.setTimeout(120_000);
    try {
      const friends = Array.from({ length: 30 }, (_, i) => ({
        id: String(i + 1),
        username: `Cadre${i + 1}`,
        caps: 123,
        score: 456,
        title: 'Pilier',
        avatar: OUTFITS[i % OUTFITS.length],
      }));

      const harness = await setupHarness(context, page, friends);
      await openConnexionsPage(page);

      // 1. Lire thumb-6 avant changement (tenue Men de base sans accessoire)
      const thumb = page.getByTestId('avatar-thumb-6');
      await thumb.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await expect(thumb.locator('[data-avatar-framing="ready"]')).toBeVisible({ timeout: 45_000 });

      const canvas = thumb.locator('canvas');
      await canvas.evaluate(el => el.setAttribute('data-canvas-id', 'test-preserved-slot'));

      const initialToken = await thumb.locator('[data-avatar-framing="ready"]').getAttribute('data-avatar-framing-info');
      expect(initialToken, 'initial framing token present').not.toBeNull();

      const initialSample = await readSample(page, 6);
      expect(initialSample.partKeys).not.toContain('accessory');

      // 2. Mettre à jour l'ami 6 avec la tenue Men_KART
      const updatedFriends = friends.map(f => (f.id === '6' ? { ...f, avatar: MEN_KART } : f));
      harness.setFriends(updatedFriends);

      // 3. Invalidation via le QueryClient capturé sur l'arbre de rendu
      const hasClient = await page.evaluate(() => typeof (window as any).__queryClient?.invalidateQueries === 'function');
      expect(hasClient, 'QueryClient capturé via DevTools hook').toBe(true);

      const [response] = await Promise.all([
        page.waitForResponse(res => res.url().includes('/api/auth/connections') && res.status() === 200),
        page.evaluate(() => (window as any).__queryClient.invalidateQueries({ queryKey: ['connections'] })),
      ]);
      expect(response).toBeDefined();

      // 4. Attendre la transition vers ready avec la nouvelle tenue
      await expect(thumb.locator('[data-avatar-framing="ready"]')).toBeVisible({ timeout: 45_000 });

      // 5. Vérifier conservation d'identité du canvas (slot préservé)
      const canvasAttr = await canvas.evaluate(el => el.getAttribute('data-canvas-id'));
      expect(canvasAttr, 'identité DOM du canvas préservée (slot conservé)').toBe('test-preserved-slot');

      // 6. Nouveau token émis et différent du premier
      const newToken = await thumb.locator('[data-avatar-framing="ready"]').getAttribute('data-avatar-framing-info');
      expect(newToken, 'nouveau token émis pour la nouvelle tenue').not.toBeNull();
      expect(newToken, 'token différent après changement de tenue').not.toEqual(initialToken);

      // 7. Vérifier que la nouvelle tenue (avec Kart) est bien rendue
      const newSample = await readSample(page, 6);
      expect(newSample.partKeys, 'accessoire Kart rendu').toContain('accessory');
      const rect = (await canvas.boundingBox())!;
      assertFramed(newSample, MEN_KART, rect.width, rect.height);

      await page.screenshot({ path: info.outputPath('framing-inplace-change.png') });
    } finally {
      await teardownObserver(page);
    }
  });

  test('navigation retour carte et conservation d état (T08/T30c)', async ({ context, page }, info) => {
    test.setTimeout(120_000);
    try {
      let documents = 0;
      page.on('request', request => { if (request.resourceType() === 'document') documents++; });

      const harness = await setupHarness(context, page);
      await openConnexionsPage(page);

      // Scroll aux extrémités pour vérifier le budget de thumbnail
      await page.getByTestId('avatar-thumb-3').evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await expect(page.getByTestId('avatar-thumb-3').locator('[data-avatar-framing="ready"]')).toBeVisible({ timeout: 45_000 });
      await page.getByTestId('avatar-thumb-30').evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await expect(page.getByTestId('avatar-thumb-30').locator('[data-avatar-framing="ready"]')).toBeVisible({ timeout: 45_000 });

      // Retour carte
      await page.locator('header button').first().click();
      await expect(page.locator('canvas[data-framing-map="retained"]')).toBeVisible();

      // Vérifications finales : document unique, whitelist modèles, pas d'erreurs réseau
      expect(documents, 'aucun rechargement de document').toBe(1);
      expect(harness.hits.size, 'tous les modèles whitelistés ont été servis').toBe(Object.keys(HASHES).length);
      expect(harness.failures, 'aucun échec de modèle').toEqual([]);
      harness.isolation.assertAssets();
      harness.isolation.assertIsolated();

      await info.attach('framing-measurements', {
        body: JSON.stringify({
          hashes: HASHES,
          hits: [...harness.hits],
          failures: harness.failures,
          limitations: ['FBX uniquement ; voie bc3d non couverte', 'Playwright ne remplace pas la recette iPhone'],
        }, null, 2),
        contentType: 'application/json',
      });
    } finally {
      await teardownObserver(page);
    }
  });
});
