import { test, expect, type Browser, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, readdirSync, statSync, existsSync, linkSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { homedir, cpus, totalmem } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

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
    process: { hostPid: number; startedAt: string }; weightsInitiallyPresent: boolean; warmupJobId?: string };
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
  guard(selection.category !== 'warm' || isJobId(run.warmupJobId), 'job de chauffe séparé requis pour warm');
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
  const actual: JsonObject & { corpus: Record<Kind, CorpusEntry> } = {
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

type Verdict = 'succeeded' | 'rejected' | 'failed';
interface JobResult { id: string; status: Verdict }
interface DriverMarks { click?: number; request?: number; accepted?: number; terminal?: number; ui?: number }
interface TimingEvent {
  phase: string; job_id: string; pid: number; attempt: number; utc: string;
  duration_ms?: number; status?: string; outcome?: string;
}
const terminalStatuses = ['succeeded', 'rejected', 'failed'];
const phases = ['enqueued', 'claimed', 'file_read', 'detector_total', 'finalization', 'result'] as const;
function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}
function correlateTimeline(marks: DriverMarks, acceptedId: string, terminal: JobResult, ui: JobResult) {
  const values = [marks.click, marks.request, marks.accepted, marks.terminal, marks.ui];
  guard(values.every(finite), 'horloge pilote incomplète/non finie');
  const [click, request, accepted, result, visible] = values as number[];
  guard(request >= click && accepted >= request && result >= accepted && visible >= result, 'ordre clic/request/202/résultat/UI');
  guard(isJobId(acceptedId) && terminal.id === acceptedId && ui.id === acceptedId && ui.status === terminal.status && terminalStatuses.includes(terminal.status), 'corrélation job_id/verdict UI');
  return { clickToPostMs: request - click, postToAcceptedMs: accepted - request, acceptedToResultMs: visible - accepted, totalDurationMs: visible - click };
}
function partialDurations(marks: DriverMarks) {
  const duration = (start: number | undefined, end: number | undefined) => finite(start) && finite(end) && end >= start ? end - start : 'inconnue';
  return { clickToPostMs: duration(marks.click, marks.request), postToAcceptedMs: duration(marks.request, marks.accepted), acceptedToResultMs: duration(marks.accepted, marks.ui), totalDurationMs: duration(marks.click, marks.ui) };
}

function observeJob(page: Page, squadId: number) {
  const endpoint = `${baseURL}/api/squads/${squadId}/beer-calls/`;
  const marks: DriverMarks = {};
  const faults: string[] = [];
  let submitted: Request | undefined;
  let posts = 0;
  let accepted: string | undefined;
  const results = new Map<string, { body: JobResult; at: number }>();
  const pending = new Set<Promise<void>>();
  const onRequest = (request: Request) => {
    if (request.url() !== endpoint || request.method() !== 'POST') return;
    posts++;
    if (posts !== 1) { faults.push('POST dupliqué'); return; }
    submitted = request;
    marks.request = performance.now();
  };
  const onResponse = (response: Response) => {
    const at = performance.now();
    const isAccepted = submitted !== undefined && response.request() === submitted;
    const path = new URL(response.url());
    const getId = path.origin === baseURL && path.pathname.startsWith(`/api/squads/${squadId}/beer-calls/jobs/`)
      ? path.pathname.split('/').filter(Boolean).at(-1) : undefined;
    if (!isAccepted && !(getId && response.request().method() === 'GET' && response.status() === 200)) return;
    if (isAccepted) {
      if (response.status() !== 202) { faults.push('POST non accepté202'); return; }
      // L'instant202 est celui de l'événement response, PAS de la fin de json().
      marks.accepted = at;
    }
    const task = (async () => {
      const body = record(await response.json() as unknown, 'réponse job');
      if (isAccepted) {
        guard(isJobId(body.job_id), 'job_id202 absent');
        accepted = body.job_id;
      } else if (terminalStatuses.includes(String(body.status))) {
        guard(isJobId(getId) && body.id === getId, 'GET job_id incohérent');
        // Ne jamais remplacer la première observation terminale par un GET tardif.
        if (!results.has(getId)) results.set(getId, { body: { id: getId, status: body.status as Verdict }, at });
      }
    })().catch(() => { faults.push('réponse job illisible/incohérente'); }).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    marks, faults,
    get posts() { return posts; },
    get acceptedId() { return accepted; },
    get terminal() { return accepted ? results.get(accepted) : undefined; },
    detach() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
    async drain() { await Promise.allSettled([...pending]); },
  };
}

function parseTimings(log: string): TimingEvent[] {
  const events: TimingEvent[] = [];
  for (const line of log.split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    let value: JsonObject;
    try { value = record(JSON.parse(line.slice(start)) as unknown, 'log'); } catch { continue; }
    if (value.event !== 'beer_job_timing' || !isJobId(value.job_id)) continue;
    guard(typeof value.utc === 'string' && Number.isFinite(Date.parse(value.utc)), 'UTC du log');
    guard(Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 0, 'pid/attempt du log');
    guard(value.duration_ms === undefined || finite(value.duration_ms), 'durée locale du log');
    events.push({ phase: String(value.phase), job_id: value.job_id, pid: Number(value.pid), attempt: Number(value.attempt), utc: new Date(value.utc).toISOString(),
      ...(value.duration_ms === undefined ? {} : { duration_ms: Number(value.duration_ms) }),
      ...(typeof value.status === 'string' ? { status: value.status } : {}), ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
    });
  }
  return events;
}
function readTimings(container: Container): TimingEvent[] {
  // docker logs restitue les logs Python sur stderr. Les deux flux restent en
  // mémoire, filtrés avant export ; aucun stdout/stderr brut n'est imprimé.
  const result = spawnSync('docker', ['logs', '--since', container.startedAt, container.id], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  guard(result.status === 0 && !result.error, 'logs Docker inaccessibles');
  return parseTimings(`${result.stdout}\n${result.stderr}`).filter(e => Date.parse(e.utc) >= Date.parse(container.startedAt));
}
function validateHistory(events: TimingEvent[], operator: Operator): void {
  if (operator.selection.category !== 'warm') {
    guard(events.every(e => e.phase !== 'claimed'), 'cet essai ne serait pas le premier job du processus');
  } else {
    const warmup = events.filter(e => e.job_id === operator.run.warmupJobId);
    guard(warmup.some(e => e.phase === 'result' && ['succeeded', 'rejected'].includes(e.outcome ?? '')) &&
      warmup.some(e => e.phase === 'detector_total' && finite(e.duration_ms) && ['success', 'rejected'].includes(e.status ?? '')), 'chauffe terminale réellement inférée non observable');
  }
}
function correlateLogs(api: TimingEvent[], worker: TimingEvent[], jobId: string, verdict: Verdict) {
  const events = [...api, ...worker].filter(e => e.job_id === jobId);
  const byPhase = Object.fromEntries(phases.map(phase => {
    const rows = events.filter(e => e.phase === phase);
    return [phase, rows.length ? rows : 'inconnue'];
  }));
  const missing = phases.filter(phase => !events.some(e => e.phase === phase));
  const enqueued = api.find(e => e.job_id === jobId && e.phase === 'enqueued');
  const claimed = worker.find(e => e.job_id === jobId && e.phase === 'claimed');
  const queueMs = enqueued && claimed ? Date.parse(claimed.utc) - Date.parse(enqueued.utc) : undefined;
  const terminal = worker.filter(e => e.job_id === jobId && e.phase === 'result' && e.outcome === verdict).at(-1);
  const attempts = [...new Set(worker.filter(e => e.job_id === jobId).map(e => e.attempt))];
  const pids = [...new Set(worker.filter(e => e.job_id === jobId).map(e => e.pid))];
  const finalAttempt = terminal ? worker.filter(e => e.job_id === jobId && e.attempt === terminal.attempt && e.pid === terminal.pid) : [];
  const finalAttemptComplete = ['claimed', 'file_read', 'detector_total', 'finalization', 'result'].every(phase => finalAttempt.some(e => e.phase === phase)) &&
    ['file_read', 'detector_total', 'finalization'].every(phase => finalAttempt.some(e => e.phase === phase && finite(e.duration_ms)));
  const complete = missing.length === 0 && finite(queueMs) && terminal !== undefined && pids.length === 1 && finalAttemptComplete && enqueued?.attempt === 0;
  return { phases: byPhase, missing, finalAttemptComplete, queueUtcMs: finite(queueMs) ? queueMs : 'inconnue', queueClock: 'UTC corrélées API/worker, pas une durée monotone inter-processus', pids, attempts, complete };
}
function atomicWriteOnce(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    // Publication atomique exclusive sur le même filesystem ; jamais rename
    // remplaçant un ancien run A (Windows comme POSIX).
    linkSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

interface SceneSignal { view?: string; instanceId?: string; generation?: number; timestamp?: number; drawCalls?: number }
function currentScene(signals: Record<string, SceneSignal>): boolean {
  const map = signals.mapInteractive;
  const avatar = signals.avatarFrameSubmitted;
  const usable = signals.sceneUsable;
  return Boolean(map && avatar && usable && [map, avatar, usable].every(s => s.view === 'dashboard' && nonempty(s.instanceId) && finite(s.timestamp) && s.timestamp > 0 && Number.isSafeInteger(s.generation) && Number(s.generation) > 0) &&
    map.generation === avatar.generation && usable.generation === map.generation && finite(avatar.drawCalls) && avatar.drawCalls > 0 && usable.timestamp === Math.max(Number(map.timestamp), Number(avatar.timestamp)));
}
async function waitForCurrentScene(page: Page): Promise<void> {
  await expect(page.locator('div.maplibregl-map canvas.maplibregl-canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Créer un Beer Call', exact: true }).locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const signals = await page.evaluate(() => (window as unknown as { __beercall_scene_metrics?: Record<string, SceneSignal> }).__beercall_scene_metrics ?? {});
    return currentScene(signals);
  }, { timeout: 30_000, message: 'Carte interactive et frame du joueur de la génération courante' }).toBe(true);
}

async function registerActor(browser: Browser): Promise<Actor> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ['geolocation'],
  });
  try {
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
    guard(['head', 'body', 'legs', 'feet'].every(part => nonempty(avatar[part]) && avatar[part] !== 'none'), 'avatar joueur obligatoire non-none');

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

    return { context, page, username, token };
  } catch {
    await context.close();
    throw new Error('Préparation acteur latence interrompue ; aucune mesure valide.');
  }
}

test.describe('Banc de mesure de latence réelle (PERF-01 / T07a)', () => {
  test('mesure chronométrée de bout en bout clic -> 202 -> résultat', async ({ browser, baseURL: configuredOrigin }) => {
    // Tous les gardes passent avant registerActor, donc avant la première écriture API.
    const qualified = await qualify(browser, configuredOrigin ?? '');
    const { operator, resultsDir } = qualified;
    const history = readTimings(qualified.stack.worker);
    validateHistory(history, operator);
    const { category, repetition, kind } = operator.selection;
    const photo = qualified.photos[kind];
    const output = join(resultsDir, `latency-${operator.variant}-${category}-${repetition}-attempt${operator.run.attempt}.json`);
    guard(!existsSync(output), 'run immuable déjà présent');
    const reservation = `${output}.lock`;
    writeFileSync(reservation, '', { flag: 'wx', mode: 0o600 });
    let actor: Actor | undefined;
    let observer: ReturnType<typeof observeJob> | undefined;
    let terminal: JobResult | undefined;
    let ui: JobResult | undefined;
    let durations: ReturnType<typeof correlateTimeline> | undefined;
    let correlation: ReturnType<typeof correlateLogs> | undefined;
    let technicalFailure = false;
    let failureStage = 'préparation';
    let timestampUtc = new Date().toISOString();
    try {
      actor = await registerActor(browser);
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
        // GPS réel du navigateur local ; aucune mutation du store applicatif.
        await squadHeading.click();
        await waitForCurrentScene(actor.page);

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

        const modal = actor.page.getByRole('heading', { name: "Valider l'Apéro", exact: true });
        await expect(modal).toBeVisible();
        await expect(actor.page.getByText('Alerte Fraude 🚨', { exact: true })).toHaveCount(0);
        await expect(actor.page.getByText('Une erreur technique est survenue.', { exact: true })).toHaveCount(0);
        const submit = actor.page.getByRole('button', { name: "LANCER L'APPEL", exact: true });
        await expect(submit).toBeEnabled();
        observer = observeJob(actor.page, squad.id);
        failureStage = 'request/202';
        timestampUtc = new Date().toISOString();
        observer.marks.click = performance.now();
        await submit.click();
        await expect.poll(() => observer!.faults.length ? 'erreur' : observer!.acceptedId ? 'accepté' : 'attente', { timeout: 15_000, intervals: [20, 50, 100] }).toBe('accepté');
        failureStage = 'résultat/UI';
        await expect.poll(() => observer!.faults.length ? 'erreur' : observer!.terminal ? 'terminal' : 'attente', { timeout: 120_000, intervals: [20, 50, 100] }).toBe('terminal');
        const received = observer.terminal!;
        terminal = received.body;
        observer.marks.terminal = received.at;
        if (terminal.status === 'succeeded') {
          await modal.waitFor({ state: 'hidden', timeout: 15_000 });
          await actor.page.getByRole('heading', { name: locationName, exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
        } else if (terminal.status === 'rejected') {
          await actor.page.getByText('Alerte Fraude 🚨', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
          await actor.page.getByText('Désolé, aucune boisson détectée !', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
        } else {
          await actor.page.getByText('Une erreur technique est survenue.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
        }
        observer.marks.ui = performance.now();
        ui = { ...terminal };
        durations = correlateTimeline(observer.marks, observer.acceptedId!, terminal, ui);
        failureStage = 'corrélation serveur';
        const workerEvents = readTimings(qualified.stack.worker);
        correlation = correlateLogs([], workerEvents, terminal.id, terminal.status);
        correlation = correlateLogs(readTimings(qualified.stack.api), workerEvents, terminal.id, terminal.status);
        guard(!operator.run.firstJobOfProcess || workerEvents.every(e => e.phase !== 'claimed' || e.job_id === terminal!.id), 'un autre job a précédé cet essai froid/restart');
        const active = validateStack(observeContainers());
        guard((['api', 'worker', 'frontend', 'proxy'] as const).every(role => {
          const before = qualified.stack[role], after = active[role];
          return before.id === after.id && before.image === after.image && before.hostPid === after.hostPid && before.startedAt === after.startedAt && before.nanoCpus === after.nanoCpus && before.memory === after.memory;
        }), 'stack ou limites modifiées pendant la mesure');
        guard(active.worker.id === qualified.stack.worker.id && active.worker.hostPid === operator.run.process.hostPid && active.worker.startedAt === operator.run.process.startedAt, 'worker redémarré pendant la mesure');
        guard(backendObservation(active.worker, []).weights === operator.metadata.weightsSha256, 'poids réellement employés non conformes');
        guard(correlation.complete, 'phases serveur inconnues ou non corrélables ; prescription complémentaire nécessaire');
        await observer.drain();
        guard(observer.posts === 1 && observer.faults.length === 0, 'soumission nominale unique');
        guard(terminal.status === (kind === 'drink' ? 'succeeded' : 'rejected'), 'verdict réel non conforme au corpus sélectionné');
    } catch {
      technicalFailure = true;
    } finally {
      observer?.detach();
      try {
        if (actor) await actor.context.close();
        if (observer) await observer.drain();
      } catch { technicalFailure = true; }
      try {
        const marks = observer?.marks ?? {};
        const run = {
          ...operator.selection, attempt: operator.run.attempt, epoch: operator.run.epoch, process: operator.run.process,
          firstJobOfProcess: operator.run.firstJobOfProcess, startupMs: operator.run.startupMs,
          photoHash: photo.hash, job_id: observer?.acceptedId ?? 'inconnue', verdict: technicalFailure ? 'failed' : terminal!.status, observedVerdict: terminal?.status ?? 'inconnue', timestampUtc,
          ...(durations ?? partialDurations(marks)),
          technicalFailure, failureStage: technicalFailure ? failureStage : null,
          postsObserved: observer?.posts ?? 0,
          containers: Object.fromEntries(['api', 'worker'].map(role => {
            const c = qualified.stack[role as 'api' | 'worker'];
            return [role, { id: c.id, hostPid: c.hostPid, startedAt: c.startedAt }];
          })),
          driverMarks: { click: marks.click ?? 'inconnue', request: marks.request ?? 'inconnue', accepted: marks.accepted ?? 'inconnue', terminal: marks.terminal ?? 'inconnue', ui: marks.ui ?? 'inconnue' },
          ui: ui ? { job_id: ui.id, state: ui.status, isolatedActor: true, source: 'GET applicatif réel puis état UI visible' } : 'inconnue',
          correlation: correlation ?? { phases: Object.fromEntries(phases.map(phase => [phase, 'inconnue'])), complete: false },
          warmup: operator.run.warmupJobId ? history.filter(e => e.job_id === operator.run.warmupJobId) : null,
          limits: 'Durées observées par le pilote Node monotone, incluant transport et résolution des attentes UI ; pas une mesure physique écran. Startup opérateur séparé. Phases absentes inconnues. Aucun bouton de récupération utilisé.',
        };
        atomicWriteOnce(output, { schemaVersion: 2, variant: operator.variant, protocol: operator.protocol, metadata: operator.metadata, runs: [run] });
      } finally { unlinkSync(reservation); }
    }
    // Un refus no_drink attendu est nominal ; les pannes/données incomplètes
    // conservent leur fichier, mais le runner sort non0 (jamais test.fail/skip).
    guard(!technicalFailure, 'essai technique incomplet ou non conforme, fichier immuable conservé');
  });

  test('contrôles de corrélation — ordre, identité, logs et immutabilité synthétiques', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    const marks = { click: 0, request: 10, accepted: 30, terminal: 80, ui: 100 };
    const result: JobResult = { id, status: 'succeeded' };
    expect(correlateTimeline(marks, id, result, result)).toEqual({ clickToPostMs: 10, postToAcceptedMs: 20, acceptedToResultMs: 70, totalDurationMs: 100 });
    const refused: JobResult = { id, status: 'rejected' };
    expect(() => correlateTimeline(marks, id, refused, refused)).not.toThrow();
    for (const invalid of [
      { ...marks, request: -1 }, { ...marks, request: NaN }, { ...marks, accepted: Infinity },
      { ...marks, accepted: 5 }, { ...marks, terminal: 20 }, { ...marks, ui: 70 }, { ...marks, ui: undefined },
    ]) expect(() => correlateTimeline(invalid, id, result, result)).toThrow();
    expect(() => correlateTimeline(marks, id, { ...result, id: other }, result)).toThrow(/corrélation/);
    expect(() => correlateTimeline(marks, id, result, { ...result, id: other })).toThrow(/corrélation/);
    expect(() => correlateTimeline(marks, id, result, refused)).toThrow(/corrélation/);
    expect(partialDurations({ click: 0, request: 10 })).toEqual({ clickToPostMs: 10, postToAcceptedMs: 'inconnue', acceptedToResultMs: 'inconnue', totalDurationMs: 'inconnue' });

    // Émetteur local, pas de serveur, de socket ni de navigateur. Une réponse202
    // doit correspondre à l'objet Request observé et un autre job ne suffit pas.
    const emitter = new EventEmitter();
    const page = emitter as unknown as Page;
    const observed = observeJob(page, 42);
    const endpoint = `${baseURL}/api/squads/42/beer-calls/`;
    const post = { url: () => endpoint, method: () => 'POST' } as unknown as Request;
    const get = { method: () => 'GET' } as unknown as Request;
    const response = (url: string, request: Request, status: number, body: unknown) => ({ url: () => url, request: () => request, status: () => status, json: async () => body }) as unknown as Response;
    try {
      observed.marks.click = performance.now();
      emitter.emit('request', post);
      emitter.emit('response', response(endpoint, post, 202, { job_id: id }));
      emitter.emit('response', response(`${endpoint}jobs/${other}`, get, 200, { id: other, status: 'succeeded' }));
      await observed.drain();
      expect(observed.acceptedId).toBe(id);
      expect(observed.terminal).toBeUndefined();
      expect(observed.marks.accepted).toBeGreaterThanOrEqual(observed.marks.request!);
      emitter.emit('response', response(`${endpoint}jobs/${id}`, get, 200, result));
      await observed.drain();
      expect(observed.terminal?.body).toEqual(result);
      emitter.emit('request', post);
      expect(observed.posts).toBe(2);
      expect(observed.faults).toContain('POST dupliqué');
    } finally { observed.detach(); await observed.drain(); }
    expect(emitter.listenerCount('request')).toBe(0);
    expect(emitter.listenerCount('response')).toBe(0);

    const event = (phase: string, index: number): TimingEvent => ({ phase, job_id: id, pid: 1, attempt: phase === 'enqueued' ? 0 : 1,
      utc: new Date(Date.parse('2026-10-27T00:00:00.000Z') + index * 10).toISOString(),
      ...(['file_read', 'detector_total', 'finalization'].includes(phase) ? { duration_ms: 2 } : {}),
      ...(phase === 'result' ? { outcome: 'succeeded' } : {}),
    });
    const api = [event('enqueued', 0)];
    const worker = phases.slice(1).map((phase, index) => event(phase, index + 1));
    expect(correlateLogs(api, worker, id, 'succeeded').complete).toBe(true);
    expect(correlateLogs(api, worker, id, 'succeeded').queueUtcMs).toBe(10);
    expect(correlateLogs(api, worker, other, 'succeeded').complete).toBe(false);
    const missing = correlateLogs(api, worker.filter(e => e.phase !== 'detector_total'), id, 'succeeded');
    expect(missing.phases.detector_total).toBe('inconnue');
    expect(missing.complete).toBe(false);
    expect(correlateLogs([], worker, id, 'succeeded').queueUtcMs).toBe('inconnue');
    expect(correlateLogs([event('enqueued', 9)], worker, id, 'succeeded').complete).toBe(false);
    expect(correlateLogs(api, worker.map(e => e.phase === 'result' ? { ...e, attempt: 2 } : e), id, 'succeeded').complete).toBe(false);
    expect(correlateLogs(api, worker.map(e => e.phase === 'result' ? { ...e, pid: 2 } : e), id, 'succeeded').complete).toBe(false);
    const raw = `INFO:worker:${JSON.stringify({ event: 'beer_job_timing', ...worker[0], token: 'NEVER_EXPORT' })}`;
    expect(JSON.stringify(parseTimings(raw))).not.toContain('NEVER_EXPORT');
    expect(parseTimings('non-json\n{invalid')).toEqual([]);
    expect(() => parseTimings(JSON.stringify({ event: 'beer_job_timing', ...worker[1], duration_ms: -1 }))).toThrow();
    const operator: Operator = { schemaVersion: 2, variant: 'A', metadata: { corpus: {} as Record<Kind, CorpusEntry> },
      protocol: { seed: 20261025, counts: COUNTS, timingPrecisionMs: 1 }, selection: { category: 'cold-image', repetition: 1, kind: 'drink' },
      run: { epoch: 'contrôle-synthétique', attempt: 1, startupMs: 0, firstJobOfProcess: true, process: { hostPid: 1, startedAt: '2026-10-27T00:00:00.000Z' }, weightsInitiallyPresent: false } };
    expect(() => validateHistory([], operator)).not.toThrow();
    expect(() => validateHistory(worker, operator)).toThrow(/premier job/);
    operator.selection.category = 'warm';
    operator.run.warmupJobId = id;
    const warmup = worker.map(e => ({ ...e, status: 'success' }));
    expect(() => validateHistory(warmup, operator)).not.toThrow();
    expect(() => validateHistory([], operator)).toThrow(/chauffe/);

    const map: SceneSignal = { instanceId: 'map:1', view: 'dashboard', generation: 1, timestamp: 10 };
    const avatar: SceneSignal = { instanceId: 'avatar:2', view: 'dashboard', generation: 1, timestamp: 20, drawCalls: 2 };
    const scene = { mapInteractive: map, avatarFrameSubmitted: avatar, sceneUsable: { ...avatar } };
    expect(currentScene(scene)).toBe(true);
    expect(currentScene({ ...scene, avatarFrameSubmitted: { ...avatar, drawCalls: 0 } })).toBe(false);
    expect(currentScene({ ...scene, avatarFrameSubmitted: { ...avatar, generation: 2 } })).toBe(false);
    expect(currentScene({ ...scene, avatarFrameSubmitted: { ...avatar, view: 'profile' } })).toBe(false);
    expect(currentScene({})).toBe(false);

    // Vérifier la parité avec T41 via Node natif (le collecteur CJS ne doit
    // ni transpiler le CLI ESM ni le lancer pendant --list).
    const summaryUrl = pathToFileURL(join(__dirname, 'summarize-latency.mjs')).href;
    const schedule = parseJson(command(process.execPath, ['--input-type=module', '-e', `import {makeSchedule} from ${JSON.stringify(summaryUrl)}; process.stdout.write(JSON.stringify(makeSchedule()))`]), 'seed T41');
    expect(makeSchedule()).toEqual(schedule);
    const directory = mkdtempSync(join(approvedRoot, 't43-controls-'));
    const path = join(directory, 'synthetic-run.json');
    try {
      atomicWriteOnce(path, { synthetic: true, attempt: 1 });
      expect(() => atomicWriteOnce(path, { synthetic: true, attempt: 2 })).toThrow();
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ synthetic: true, attempt: 1 });
      expect(readdirSync(directory)).toEqual(['synthetic-run.json']);
    } finally { if (existsSync(path)) unlinkSync(path); rmdirSync(directory); }
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
