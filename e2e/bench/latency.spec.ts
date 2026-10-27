import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { homedir, cpus, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';

test.setTimeout(180_000);

const baseURL = 'http://127.0.0.1:8080';
const password = 'BeerCallE2E123!';
const unique = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const approvedRoot = resolve(homedir(), 'AppData/Local/Temp/opencode');
const latencyProject = 'beercall-usage-latency';
const functionalProject = 'beercall-usage-e2e';
const repoRoot = resolve(__dirname, '../..');
const frontendRoot = resolve(repoRoot, '../beercall-frontend');
const backendRoot = resolve(repoRoot, '../beercall-backend');
const COUNTS = { 'cold-image': 3, 'process-restart': 10, warm: 20 } as const;
type Kind = 'drink' | 'no_drink';
type Category = 'cold-image' | 'process-restart' | 'warm';
// Même ordonnanceur que T41, local pour conserver la collecte CJS Playwright
// sans charger le CLI ESM ni changer package.json (hors périmètre T42).
function makeSchedule(): Array<{ category: Category; repetition: number; kind: Kind }> {
  let state = 20261025 >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  return Object.entries(COUNTS).flatMap(([category, count]) => {
    const kinds: Kind[] = Array.from({ length: count }, (_, index) => index < Math.ceil(count / 2) ? 'drink' : 'no_drink');
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    return kinds.map((kind, index) => ({ category: category as Category, repetition: index + 1, kind }));
  });
}
type JsonObject = Record<string, unknown>;
interface Photo { name: string; mimeType: string; buffer: Buffer; hash: string }
interface CorpusEntry { sha256: string; mimeType: string; width: number; height: number; authorization: string }
interface Container {
  id: string; project: string; service: string; image: string; running: boolean;
  mode: string; appEnv: string; hostPid: number; startedAt: string;
  nanoCpus: number; memory: number; publishes8080: boolean;
}
interface Operator {
  schemaVersion: 2; variant: 'A' | 'B'; protocol: { seed: number; counts: typeof COUNTS; timingPrecisionMs: number };
  metadata: JsonObject & { corpus: Record<Kind, CorpusEntry> };
  selection: { category: Category; repetition: number; kind: Kind };
  run: { epoch: string; attempt: number; startupMs: number; firstJobOfProcess: boolean;
    process: { hostPid: number; startedAt: string }; weightsInitiallyPresent: boolean };
}

function guard(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Précontrôle latence refusé : ${label}`);
}
function record(value: unknown, label: string): JsonObject {
  guard(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value as JsonObject;
}
function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw new Error(`Précontrôle latence refusé : ${label}`); }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function utc(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validateOrigin(value: string): void {
  guard(value === baseURL, 'origine locale exacte requise');
}
function validateResults(value: string | undefined, root = approvedRoot): string {
  guard(nonempty(value) && isAbsolute(value), 'BEERCALL_USAGE_RESULTS absolu requis');
  const tail = relative(root, resolve(value));
  guard(tail !== '' && !tail.startsWith('..') && !isAbsolute(tail), 'résultats hors Temp/opencode');
  return resolve(value);
}
function command(program: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(program, args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    // Ne jamais propager stderr/config/env Docker (secrets potentiels).
    throw new Error(`Précontrôle latence refusé : observation ${program === 'docker' ? 'Docker' : 'locale'} indisponible`);
  }
}
function loadOperator(path: string | undefined, env: NodeJS.ProcessEnv): Operator {
  guard(nonempty(path) && isAbsolute(path), 'fichier opérateur V53 absolu requis');
  validateResults(realpathSync(path));
  const raw = record(parseJson(readFileSync(path, 'utf8'), 'JSON opérateur'), 'opérateur');
  guard(raw.schemaVersion === 2 && ['A', 'B'].includes(String(raw.variant)), 'schéma opérateur v2');
  const protocol = record(raw.protocol, 'protocole');
  guard(protocol.seed === 20261025 && stable(protocol.counts) === stable(COUNTS), 'protocole seed/comptages');
  guard(finite(protocol.timingPrecisionMs) && protocol.timingPrecisionMs > 0 && protocol.timingPrecisionMs <= 1, 'précision des mesures');
  record(raw.metadata, 'métadonnées requises');
  const selection = record(raw.selection, 'sélection opérateur');
  guard(env.BEERCALL_LATENCY_CATEGORY === selection.category && env.BEERCALL_LATENCY_KIND === selection.kind &&
    String(selection.repetition) === env.BEERCALL_LATENCY_REPETITION, 'catégorie/répétition/kind explicites requis');
  guard(makeSchedule().some((slot: { category: string; repetition: number; kind: string }) =>
    slot.category === selection.category && slot.repetition === selection.repetition && slot.kind === selection.kind), 'sélection contraire au seed');
  const run = record(raw.run, 'identité de démarrage');
  const worker = record(run.process, 'identité processus');
  guard(nonempty(run.epoch) && Number.isSafeInteger(run.attempt) && Number(run.attempt) > 0 && finite(run.startupMs), 'epoch/attempt/startup');
  guard(Number.isSafeInteger(worker.hostPid) && Number(worker.hostPid) > 0 && utc(worker.startedAt), 'hostPID/StartedAt');
  guard(run.firstJobOfProcess === (selection.category !== 'warm') && typeof run.weightsInitiallyPresent === 'boolean', 'premier job et état initial des poids');
  return raw as unknown as Operator;
}
function validateStack(containers: Container[]): Record<'api' | 'worker' | 'frontend' | 'proxy', Container> {
  const active = containers.filter(c => c.running);
  guard(!active.some(c => c.project === functionalProject), 'stack C encore active');
  const project = active.filter(c => c.project === latencyProject);
  const one = (service: string): Container => {
    const found = project.filter(c => c.service === service);
    guard(found.length === 1, 'service L absent ou dupliqué');
    return found[0];
  };
  const api = one('backend_e2e');
  const worker = one('beer_worker_e2e');
  const frontend = one('frontend_e2e');
  const proxy = one('proxy_e2e');
  guard(project.filter(c => c.service.startsWith('beer_worker')).length === 1, 'un seul worker beer et zéro worker2 requis');
  guard([api, worker].every(c => c.mode === 'yolo' && c.appEnv === 'test'), 'API/worker doivent employer YOLO en test');
  guard([api, worker, frontend].every(c => /^sha256:[a-f0-9]{64}$/.test(c.image)), 'identité des images');
  const owners = active.filter(c => c.publishes8080);
  guard(owners.length === 1 && owners[0].id === proxy.id, 'port8080 hors proxy L');
  return { api, worker, frontend, proxy };
}
function observeContainers(): Container[] {
  const ids = command('docker', ['ps', '-q']).split(/\s+/).filter(Boolean);
  guard(ids.length > 0, 'aucun conteneur actif');
  const raw = parseJson(command('docker', ['inspect', ...ids]), 'inspection Docker');
  guard(Array.isArray(raw), 'inspection Docker');
  return raw.map((item: unknown) => {
    const c = record(item, 'conteneur');
    const config = record(c.Config, 'Config');
    const labels = record(config.Labels ?? {}, 'labels');
    const state = record(c.State, 'State');
    const host = record(c.HostConfig, 'HostConfig');
    const ports = record(record(c.NetworkSettings, 'réseau').Ports ?? {}, 'ports');
    const env = Array.isArray(config.Env) ? config.Env.filter((s): s is string => typeof s === 'string') : [];
    const envValue = (key: string) => env.find(s => s.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
    return {
      id: String(c.Id), project: String(labels['com.docker.compose.project'] ?? ''), service: String(labels['com.docker.compose.service'] ?? ''),
      image: String(c.Image), running: state.Running === true, mode: envValue('PHOTO_DETECTOR_MODE'), appEnv: envValue('APP_ENV'),
      hostPid: Number(state.Pid), startedAt: new Date(String(state.StartedAt)).toISOString(), nanoCpus: Number(host.NanoCpus), memory: Number(host.Memory),
      publishes8080: Object.values(ports).some(bindings => Array.isArray(bindings) && bindings.some(b => record(b, 'binding').HostPort === '8080')),
    };
  });
}
function fingerprint(entries: Array<[string, string]>): string {
  guard(entries.length > 0, 'empreinte vide');
  return sha256(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
function trackedFiles(root: string, paths: string[]): string[] {
  const files = command('git', ['ls-files', '-z', '--', ...paths], root).split('\0').filter(Boolean);
  guard(files.every(p => !isAbsolute(p) && !p.startsWith('..')), 'chemins sources');
  return files;
}
function localFingerprint(root: string, files: string[]): string {
  return fingerprint(files.map(file => [file.replaceAll('\\', '/'), sha256(readFileSync(join(root, file)))]));
}
function listFiles(root: string, prefix = ''): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listFiles(join(root, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
}
function backendObservation(container: Container, files: string[]): JsonObject {
  // importlib.metadata ne charge ni PyTorch ni YOLO et ne préchauffe pas le modèle.
  const python = `import hashlib,json,pathlib,sys,platform,importlib.metadata as m
files=json.loads(sys.argv[1])
entries=sorted([[p,hashlib.sha256(pathlib.Path('/app',p).read_bytes()).hexdigest()] for p in files])
w=pathlib.Path('/app/yolov8n.pt')
print(json.dumps({'entries':entries,'python':platform.python_version(),'pytorch':m.version('torch'),'ultralytics':m.version('ultralytics'),'weights':hashlib.sha256(w.read_bytes()).hexdigest() if w.exists() else None}))`;
  return record(parseJson(command('docker', ['exec', container.id, 'python', '-c', python, JSON.stringify(files)]), 'observation API/worker'), 'observation API/worker');
}
function validateCorpus(corpus: Record<Kind, CorpusEntry>): void {
  for (const kind of ['drink', 'no_drink'] as const) {
    const photo = corpus[kind];
    guard(photo && /^[a-f0-9]{64}$/.test(photo.sha256) && ['image/jpeg', 'image/png'].includes(photo.mimeType), 'SHA/MIME réel du corpus');
    guard(Number.isSafeInteger(photo.width) && photo.width > 1 && Number.isSafeInteger(photo.height) && photo.height > 1, 'image décodable et dimensions>1x1');
    guard(nonempty(photo.authorization), 'autorisation du corpus requise');
  }
  guard(corpus.drink.sha256 !== corpus.no_drink.sha256, 'deux photos distinctes requises');
}
function validateMetadata(actual: JsonObject, declared: JsonObject): void {
  for (const field of ['sources', 'images', 'versions', 'resources', 'weightsSha256', 'corpus']) {
    guard(stable(actual[field]) === stable(declared[field]) && actual[field] !== undefined, `métadonnées ${field} non conformes aux observations`);
  }
}
function getPhoto(kind: Kind, env: NodeJS.ProcessEnv): Photo {
  const path = kind === 'drink' ? env.BEERCALL_LATENCY_DRINK_PHOTO : env.BEERCALL_LATENCY_NO_DRINK_PHOTO;
  guard(nonempty(path) && isAbsolute(path), 'deux chemins photo existants absolus requis');
  let buffer: Buffer;
  try {
    guard(statSync(path).isFile(), 'fichier photo requis');
    buffer = readFileSync(path);
  } catch { throw new Error('Précontrôle latence refusé : photo absente ou illisible'); }
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  guard(png || jpeg, 'magic bytes JPEG/PNG requis');
  return { name: `${kind}.${png ? 'png' : 'jpg'}`, mimeType: png ? 'image/png' : 'image/jpeg', buffer, hash: sha256(buffer) };
}
async function qualify(browser: Browser, origin: string) {
  validateOrigin(origin);
  const resultsDir = validateResults(process.env.BEERCALL_USAGE_RESULTS);
  guard(validateResults(realpathSync(resultsDir)) === resultsDir, 'répertoire résultats redirigé');
  const operator = loadOperator(process.env.BEERCALL_LATENCY_OPERATOR_JSON, process.env);
  // Lecture des deux fichiers avant tout accès applicatif, jamais de fallback.
  const photos = { drink: getPhoto('drink', process.env), no_drink: getPhoto('no_drink', process.env) };
  const stack = validateStack(observeContainers());
  const proxyConfigHash = command('docker', ['exec', stack.proxy.id, 'sha256sum', '/etc/nginx/conf.d/default.conf']).split(/\s+/)[0];
  guard(proxyConfigHash === sha256(readFileSync(join(repoRoot, 'nginx/default.conf'))), 'configuration proxy non conforme au checkout O');
  const corpus = record(operator.metadata.corpus, 'métadonnées corpus');
  const decoded = {} as Record<Kind, CorpusEntry>;
  const decoder = await browser.newPage();
  try {
    for (const kind of ['drink', 'no_drink'] as const) {
      const dimensions = await decoder.evaluate(async ({ bytes, mime }) => {
        try {
          const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return size;
        } catch { return null; }
      }, { bytes: [...photos[kind].buffer], mime: photos[kind].mimeType });
      guard(dimensions, 'image non décodable');
      const declared = record(corpus[kind], 'description corpus');
      decoded[kind] = { sha256: photos[kind].hash, mimeType: photos[kind].mimeType, ...dimensions, authorization: String(declared.authorization ?? '') };
      guard(stable(decoded[kind]) === stable(declared), 'corpus différent des métadonnées');
    }
  } finally { await decoder.close(); }
  validateCorpus(decoded);
  const heads = Object.fromEntries([['F', frontendRoot], ['B', backendRoot], ['O', repoRoot]].map(([key, root]) => {
    guard(command('git', ['status', '--porcelain', '--untracked-files=no'], root) === '', 'sources suivies non figées');
    return [key, command('git', ['rev-parse', 'HEAD'], root)];
  }));
  const backendFiles = trackedFiles(backendRoot, ['*.py', 'requirements.txt']).filter(p => !p.startsWith('tests/'));
  const api = backendObservation(stack.api, backendFiles);
  const worker = backendObservation(stack.worker, backendFiles);
  guard(Array.isArray(api.entries) && Array.isArray(worker.entries), 'empreintes backend');
  const backendHash = localFingerprint(backendRoot, backendFiles);
  guard(fingerprint(api.entries as Array<[string, string]>) === backendHash && fingerprint(worker.entries as Array<[string, string]>) === backendHash, 'sources API/worker différentes du checkout B');
  const frontendListing = command('docker', ['exec', stack.frontend.id, 'sh', '-c', 'cd /usr/share/nginx/html && find . -type f -exec sha256sum {} \\;']);
  const frontendEntries: Array<[string, string]> = frontendListing.split('\n').map(line => {
    const match = /^([a-f0-9]{64})\s+\.\/(.+)$/.exec(line.trim());
    guard(match, 'empreinte frontend');
    return [match[2], match[1]];
  });
  const frontendHash = fingerprint(frontendEntries);
  guard(frontendHash === localFingerprint(join(frontendRoot, 'dist'), listFiles(join(frontendRoot, 'dist'))), 'assets servis différents du build F local');
  const engine = record(parseJson(command('docker', ['info', '--format', '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}']), 'limites Docker'), 'limites Docker');
  const pkgVersion = (path: string): unknown => record(parseJson(readFileSync(path, 'utf8'), 'version package'), 'package').version;
  const actual: JsonObject = {
    sources: { F: { head: heads.F, servedSha256: frontendHash }, B: { head: heads.B, servedSha256: backendHash }, O: { head: heads.O, servedSha256: localFingerprint(repoRoot, trackedFiles(repoRoot, ['e2e'])) } },
    images: { frontend: stack.frontend.image, api: stack.api.image, worker: stack.worker.image },
    versions: { node: process.versions.node, python: worker.python, playwright: pkgVersion(require.resolve('@playwright/test/package.json')), three: pkgVersion(join(frontendRoot, 'node_modules/three/package.json')), pytorch: worker.pytorch, ultralytics: worker.ultralytics },
    resources: { hardware: { cpu: cpus()[0].model, ramBytes: totalmem(), gpu: 'inconnue' }, docker: engine, workers: 1,
      containerLimits: Object.fromEntries(Object.entries(stack).map(([key, c]) => [key, { nanoCpus: c.nanoCpus, memoryBytes: c.memory }])) },
    weightsSha256: sha256(readFileSync(join(backendRoot, 'yolov8n.pt'))), corpus: decoded,
  };
  validateMetadata(actual, operator.metadata);
  guard(api.python === worker.python && api.pytorch === worker.pytorch && api.ultralytics === worker.ultralytics, 'versions API/worker divergentes');
  guard(stable(operator.run.process) === stable({ hostPid: stack.worker.hostPid, startedAt: stack.worker.startedAt }), 'epoch/processus différent du worker actif');
  guard(operator.run.weightsInitiallyPresent === (worker.weights !== null), 'état initial des poids non conforme');
  guard(worker.weights === actual.weightsSha256 || (operator.selection.category === 'cold-image' && worker.weights === null), 'poids worker incompatibles');
  guard(api.weights === null || api.weights === actual.weightsSha256, 'poids API incompatibles');
  return { resultsDir, operator: { ...operator, metadata: actual }, photos, stack };
}

interface Actor {
  context: BrowserContext;
  page: Page;
  username: string;
  token: string;
}

interface LatencyMeasurement {
  attempt: number;
  kind: 'drink' | 'no_drink';
  photoHash: string;
  jobId: string;
  verdict: string;
  clickToPostMs: number;
  postToAcceptedMs: number;
  acceptedToResultMs: number;
  totalDurationMs: number;
  timestampUtc: string;
}

async function registerActor(browser: Browser): Promise<Actor> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ['geolocation'],
  });

  // Les requêtes applicatives et leurs redirections ne peuvent pas sortir du
  // proxy qualifié. Seuls les GET publics de tuiles/styles Carto sont externes.
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const local = url.origin === baseURL;
    const carto = url.protocol === 'https:' && (url.hostname === 'basemaps.cartocdn.com' || url.hostname.endsWith('.basemaps.cartocdn.com'));
    const publicMap = carto && request.method() === 'GET' && !request.isNavigationRequest() && !request.headers().authorization;
    if ((!local && !publicMap) || ((request.isNavigationRequest() || url.pathname.startsWith('/api/')) && request.redirectedFrom())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  const catalogue = await context.request.get('/api/auth/profile/', { maxRedirects: 0 });
  expect(catalogue.status()).toBe(200);
  const items = (await catalogue.json() as { shop_items: { id: string; category: string; gender: string }[] }).shop_items;
  const avatar: Record<string, string> = { gender: 'Men' };
  for (const category of ['head', 'body', 'legs', 'feet', 'accessory', 'animation']) {
    avatar[category] = items.find(item => item.category === category && ['Men', 'Unisex'].includes(item.gender) && item.id.endsWith('_0'))?.id ?? 'none';
  }
  avatar.accessory = 'none';
  avatar.animation = 'Idle';

  const username = unique();
  const registered = await context.request.post('/api/auth/signup/', { data: { username, password, avatar }, maxRedirects: 0 });
  expect(registered.status()).toBe(200);
  const token = (await registered.json() as { access_token: string }).access_token;

  const page = await context.newPage();
  await page.goto('/login');
  await page.getByPlaceholder('Ton Pseudo', { exact: true }).fill(username);
  await page.getByPlaceholder('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'SE CONNECTER', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Attendre la carte utilisable avant toute mesure
  const mapContainer = page.locator('div.maplibregl-map, div[aria-label="Carte des apéros"]');
  await expect(mapContainer.first()).toBeVisible({ timeout: 10_000 });

  return { context, page, username, token };
}

test.describe('Banc de mesure de latence réelle (PERF-01 / T07a)', () => {
  test('mesure chronométrée de bout en bout clic -> 202 -> résultat', async ({ browser, baseURL: configuredOrigin }) => {
    // Tous les gardes passent avant registerActor, donc avant la première écriture API.
    const qualified = await qualify(browser, configuredOrigin ?? '');
    const resultsDir = qualified.resultsDir;

    const runs: LatencyMeasurement[] = [];
    const kinds: Array<'drink' | 'no_drink'> = ['drink', 'no_drink'];

    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const photo = qualified.photos[kind];
      const actor = await registerActor(browser);

      try {
        // Créer une squad neuve pour cet essai
        const squadName = `Squad Latency ${unique()}`;
        const createdSquad = await actor.context.request.post('/api/squads/', {
          headers: { Authorization: `Bearer ${actor.token}` },
          data: { name: squadName, icon: 'beer', color: '#F59E0B' },
          maxRedirects: 0,
        });
        expect(createdSquad.status()).toBe(200);
        const squad = await createdSquad.json() as { id: number };

        // Aller sur la squad
        await actor.page.goto(`/squad/${squad.id}`);
        const squadHeading = actor.page.getByRole('heading', { name: squadName, exact: true });
        await expect(squadHeading).toBeVisible({ timeout: 15_000 });
        // Clic sur l'en-tête pour déclencher la première interaction utilisateur qui démarre le GPS (watchPosition)
        await squadHeading.click();

        // Attendre que le marqueur joueur « Créer un Beer Call » soit actif (position GPS fixée)
        const createButton = actor.page.getByRole('button', { name: 'Créer un Beer Call', exact: true });
        await expect(createButton).toBeVisible({ timeout: 15_000 });

        // Préparer le fichier photo
        const fileChooserPromise = actor.page.waitForEvent('filechooser');
        await createButton.click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
          name: photo.name,
          mimeType: photo.mimeType,
          buffer: photo.buffer,
        });

        const locationName = `Bar ${unique()}`;
        await actor.page.getByPlaceholder('Ex: Bar Le Central...').fill(locationName);

        // Promesses de chronométrage
        let tPostSent = 0;
        let tPostReceived = 0;
        let tCompleted = 0;

        const acceptedPromise = actor.page.waitForResponse(response => {
          if (response.url().endsWith(`/api/squads/${squad.id}/beer-calls/`) && response.request().method() === 'POST') {
            tPostSent = performance.now();
            return true;
          }
          return false;
        });

        const terminalPromise = actor.page.waitForResponse(async response => {
          if (response.url().includes(`/api/squads/${squad.id}/beer-calls/jobs/`) && response.status() === 200) {
            try {
              const body = await response.json() as { status: string };
              if (body.status === 'succeeded' || body.status === 'rejected' || body.status === 'failed') {
                tCompleted = performance.now();
                return true;
              }
            } catch {
              return false;
            }
          }
          return false;
        });

        // Début chronométrage clic
        const tClick = performance.now();
        await actor.page.getByRole('button', { name: "LANCER L'APPEL", exact: true }).click();

        const acceptedResponse = await acceptedPromise;
        tPostReceived = performance.now();
        expect(acceptedResponse.status()).toBe(202);
        const jobData = await acceptedResponse.json() as { job_id: string; status: string };

        const terminalResponse = await terminalPromise;
        const terminalData = await terminalResponse.json() as { id: string; status: string };

        const measurement: LatencyMeasurement = {
          attempt: i + 1,
          kind,
          photoHash: photo.hash,
          jobId: jobData.job_id,
          verdict: terminalData.status,
          clickToPostMs: Math.round(tPostSent - tClick),
          postToAcceptedMs: Math.round(tPostReceived - tPostSent),
          acceptedToResultMs: Math.round(tCompleted - tPostReceived),
          totalDurationMs: Math.round(tCompleted - tClick),
          timestampUtc: new Date().toISOString(),
        };

        runs.push(measurement);
        console.log(`[T07a Latence] Essai ${i + 1} (${kind}): Total=${measurement.totalDurationMs}ms, Post202=${measurement.postToAcceptedMs}ms, JobAI=${measurement.acceptedToResultMs}ms, Verdict=${measurement.verdict}`);
      } finally {
        await actor.context.close();
      }
    }

    const outputPath = resolve(resultsDir, 'latency-runs.json');
    writeFileSync(outputPath, JSON.stringify({ runs }, null, 2), 'utf-8');
    console.log(`[T07a Latence] Données de banc enregistrées sous ${outputPath}`);
  });

  test('contrôles d’entrée — sans navigateur ni backend', async () => {
    expect(() => validateOrigin(baseURL)).not.toThrow();
    for (const origin of ['https://beercall.fr', 'http://localhost:8080', `${baseURL}/`, 'https://127.0.0.1:8080']) {
      expect(() => validateOrigin(origin)).toThrow(/origine/);
    }
    for (const path of [undefined, 'test-results', resolve(approvedRoot, '../outside'), approvedRoot]) {
      expect(() => validateResults(path)).toThrow();
    }
    expect(() => validateResults(join(approvedRoot, 'v53-test'))).not.toThrow();
    const container = (service: string): Container => ({ id: service, project: latencyProject, service, running: true,
      image: `sha256:${'a'.repeat(64)}`, mode: 'yolo', appEnv: 'test', hostPid: 123, startedAt: '2026-10-27T00:00:00.000Z', nanoCpus: 0, memory: 0, publishes8080: service === 'proxy_e2e' });
    const valid = ['backend_e2e', 'beer_worker_e2e', 'frontend_e2e', 'proxy_e2e'].map(container);
    expect(() => validateStack(valid)).not.toThrow();
    for (const invalid of [
      valid.map(c => ({ ...c, project: functionalProject })),
      [...valid, { ...container('frontend_e2e'), project: functionalProject }],
      [...valid, container('beer_worker_e2e_2')], [...valid, container('beer_worker_e2e')],
      valid.filter(c => c.service !== 'beer_worker_e2e'),
      valid.map(c => c.service === 'backend_e2e' ? { ...c, mode: 'always_accept' } : c),
      valid.map(c => c.service === 'beer_worker_e2e' ? { ...c, mode: 'always_accept' } : c),
      [...valid, { ...container('foreign'), project: 'foreign', publishes8080: true }],
    ]) expect(() => validateStack(invalid)).toThrow(/Précontrôle/);
    const photo = (char: string): CorpusEntry => ({ sha256: char.repeat(64), mimeType: 'image/jpeg', width: 640, height: 480, authorization: 'contrôle synthétique' });
    const corpus = { drink: photo('a'), no_drink: photo('b') };
    expect(() => validateCorpus(corpus)).not.toThrow();
    for (const invalid of [
      { ...corpus, no_drink: corpus.drink },
      { ...corpus, drink: { ...corpus.drink, width: 1 } },
      { ...corpus, drink: { ...corpus.drink, mimeType: 'text/plain' } },
      { ...corpus, drink: { ...corpus.drink, authorization: '' } },
    ]) expect(() => validateCorpus(invalid)).toThrow(/Précontrôle/);
    const metadata: JsonObject = { sources: { F: 'synthétique' }, images: { worker: 'synthétique' }, versions: { python: 'synthétique' }, resources: { workers: 1 }, weightsSha256: 'a'.repeat(64), corpus };
    expect(() => validateMetadata(metadata, structuredClone(metadata))).not.toThrow();
    for (const field of Object.keys(metadata)) {
      expect(() => validateMetadata(metadata, { ...metadata, [field]: 'autre observation' })).toThrow(/métadonnées/);
    }
  });
});
