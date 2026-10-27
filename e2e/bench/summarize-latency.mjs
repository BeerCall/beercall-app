#!/usr/bin/env node
/**
 * T41 — Schéma v2 strict ; aucune inférence à partir d'une ancienne série.
 * Durées en ms, précision <=1ms déclarée dans protocol.timingPrecisionMs.
 * Sources F/B/O : {head, servedSha256}. Images frontend/api/worker : IDs sha256.
 * Resources : {hardware:{cpu, ramBytes, gpu}, docker:{cpus, memoryBytes}, workers}.
 * Corpus drink/no_drink : {sha256, mimeType, width, height, authorization} (pas d'octets).
 * Chaque run porte epoch, process:{hostPid, startedAt}, firstJobOfProcess et les
 * durées clickToPostMs/postToAcceptedMs/acceptedToResultMs/totalDurationMs.
 * CLI : A.json B.json [--decisions decisions.json]. Les décisions optionnelles
 * contiennent expectedDifferences:{chemin:{A:valeur,B:valeur}} et approval H05.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const COUNTS = Object.freeze({ 'cold-image': 3, 'process-restart': 10, warm: 20 });
const KINDS = ['drink', 'no_drink'];
const DURATIONS = ['clickToPostMs', 'postToAcceptedMs', 'acceptedToResultMs', 'totalDurationMs'];
const HASH = /^[a-f0-9]{64}$/;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
}
function requireValid(ok, label) {
  if (!ok) throw new Error(`Données invalides : ${label}`);
}
function object(value, label) {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  return value;
}
function text(value, label, pattern) {
  requireValid(typeof value === 'string' && value.trim().length > 0 && (!pattern || pattern.test(value)), label);
}
function number(value, label, minimum = 0, integer = false) {
  requireValid(typeof value === 'number' && Number.isFinite(value) && value >= minimum && (!integer || Number.isSafeInteger(value)), label);
}
function utc(value, label) {
  text(value, label, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  requireValid(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, label);
}

/** Mélange déterministe des 2/1, 5/5 et 10/10, au total 33 et non 66. */
export function makeSchedule(seed = 20261025) {
  requireValid(seed === 20261025, 'seed');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; };
  return Object.entries(COUNTS).flatMap(([category, count]) => {
    const kinds = Array.from({ length: count }, (_, index) => index < Math.ceil(count / 2) ? 'drink' : 'no_drink');
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    return kinds.map((kind, index) => ({ category, repetition: index + 1, kind }));
  });
}

export function validateDataset(data) {
  object(data, 'dataset v2');
  requireValid(data.schemaVersion === 2, 'schemaVersion (v2 requis)');
  requireValid(['A', 'B'].includes(data.variant), 'variant');
  const protocol = object(data.protocol, 'protocol');
  requireValid(protocol.seed === 20261025 && canonical(protocol.counts) === canonical(COUNTS), 'protocol seed/counts');
  number(protocol.timingPrecisionMs, 'timingPrecisionMs', Number.MIN_VALUE);
  requireValid(protocol.timingPrecisionMs <= 1, 'timingPrecisionMs <=1');
  const metadata = object(data.metadata, 'metadata');
  const sources = object(metadata.sources, 'sources');
  for (const repo of ['F', 'B', 'O']) {
    const source = object(sources[repo], `sources.${repo}`);
    text(source.head, `sources.${repo}.head`, HEAD);
    text(source.servedSha256, `sources.${repo}.servedSha256`, HASH);
  }
  const images = object(metadata.images, 'images');
  for (const service of ['frontend', 'api', 'worker']) text(images[service], `images.${service}`, IMAGE);
  const versions = object(metadata.versions, 'versions');
  for (const name of ['node', 'python', 'playwright', 'three', 'pytorch', 'ultralytics']) text(versions[name], `versions.${name}`);
  const resources = object(metadata.resources, 'resources');
  const hardware = object(resources.hardware, 'resources.hardware');
  text(hardware.cpu, 'hardware.cpu');
  number(hardware.ramBytes, 'hardware.ramBytes', 1, true);
  text(hardware.gpu, 'hardware.gpu (inconnue si inaccessible)');
  const docker = object(resources.docker, 'resources.docker');
  number(docker.cpus, 'docker.cpus', Number.MIN_VALUE);
  number(docker.memoryBytes, 'docker.memoryBytes', 1, true);
  requireValid(resources.workers === 1, 'exactement un worker');
  text(metadata.weightsSha256, 'weightsSha256', HASH);
  const corpus = object(metadata.corpus, 'corpus');
  for (const kind of KINDS) {
    const photo = object(corpus[kind], `corpus.${kind}`);
    text(photo.sha256, `${kind}.sha256`, HASH);
    text(photo.mimeType, `${kind}.mimeType`, /^image\/(jpeg|png|webp)$/);
    number(photo.width, `${kind}.width`, 2, true);
    number(photo.height, `${kind}.height`, 2, true);
    text(photo.authorization, `${kind}.authorization`);
  }
  requireValid(corpus.drink.sha256 !== corpus.no_drink.sha256, 'deux photos distinctes');
  const schedule = makeSchedule(protocol.seed);
  requireValid(Array.isArray(data.runs) && data.runs.length === schedule.length, '33 runs requis');
  const slots = new Set();
  const jobs = new Set();
  const attempts = new Set();
  const epochs = new Map();
  const processes = new Map();
  for (const run of data.runs) {
    object(run, 'run');
    const expected = schedule.find(item => item.category === run.category && item.repetition === run.repetition);
    requireValid(expected && expected.kind === run.kind, 'catégorie/répétition/kind du seed');
    const slot = `${run.category}/${run.repetition}`;
    requireValid(!slots.has(slot), 'répétition dupliquée');
    slots.add(slot);
    requireValid(run.photoHash === corpus[run.kind].sha256, 'run.photoHash');
    text(run.job_id, 'run.job_id');
    requireValid(!jobs.has(run.job_id), 'job_id dupliqué');
    jobs.add(run.job_id);
    number(run.attempt, 'run.attempt', 1, true);
    requireValid(!attempts.has(run.attempt), 'attempt dupliqué');
    attempts.add(run.attempt);
    const expectedVerdict = run.kind === 'drink' ? 'succeeded' : 'rejected';
    requireValid(run.verdict === expectedVerdict || run.verdict === 'failed', 'verdict incompatible avec kind');
    utc(run.timestampUtc, 'timestampUtc');
    number(run.startupMs, 'startupMs');
    for (const field of DURATIONS) number(run[field], field);
    const sum = run.clickToPostMs + run.postToAcceptedMs + run.acceptedToResultMs;
    // Trois segments et un total arrondis : erreur maximale de deux unités.
    requireValid(Number.isFinite(sum) && Math.abs(sum - run.totalDurationMs) <= 2 * protocol.timingPrecisionMs, 'somme des durées');
    text(run.epoch, 'epoch opérateur');
    const process = object(run.process, 'process');
    number(process.hostPid, 'process.hostPid', 1, true);
    utc(process.startedAt, 'process.startedAt');
    requireValid(Date.parse(process.startedAt) <= Date.parse(run.timestampUtc), 'process démarré après run');
    requireValid(typeof run.firstJobOfProcess === 'boolean', 'firstJobOfProcess');
    requireValid(run.firstJobOfProcess === (run.category !== 'warm'), 'premier job froid/restart, pas warm');
    const identity = canonical(process);
    const epoch = epochs.get(run.epoch);
    if (epoch) {
      requireValid(run.category === 'warm' && epoch.category === 'warm' && epoch.identity === identity && epoch.startupMs === run.startupMs, 'epoch réutilisé hors warm ou identité incohérente');
    } else {
      requireValid(!processes.has(identity), 'processus réutilisé sous un autre epoch');
      epochs.set(run.epoch, { category: run.category, identity, startupMs: run.startupMs });
      processes.set(identity, run.epoch);
    }
  }
  return data;
}

export function quantile(values, q) {
  requireValid(Array.isArray(values) && values.length > 0, 'série vide');
  values.forEach(value => number(value, 'valeur de série'));
  number(q, 'quantile');
  requireValid(q <= 1, 'quantile <=1');
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  return sorted[base] + (position - base) * ((sorted[base + 1] ?? sorted[base]) - sorted[base]);
}
export function computeStats(values) {
  const median = quantile(values, 0.5);
  return { n: values.length, median, iqr: quantile(values, 0.75) - quantile(values, 0.25), min: Math.min(...values), max: Math.max(...values) };
}
function validateApproval(approval) {
  if (approval === undefined) return;
  object(approval, 'approval H05');
  text(approval.reference, 'approval.reference H05');
  number(approval.usefulGainMs, 'approval.usefulGainMs', Number.MIN_VALUE);
  number(approval.maxStartupMs, 'approval.maxStartupMs');
}
export function compareSeries(seriesA, seriesB, options = {}) {
  const statsA = computeStats(seriesA);
  const statsB = computeStats(seriesB);
  validateApproval(options.approval);
  const deltaMedian = statsB.median - statsA.median;
  const ratio = statsA.median === 0 ? null : statsB.median / statsA.median;
  requireValid(ratio === null || Number.isFinite(ratio), 'ratio non fini');
  const dispersionMs = Math.max(statsA.iqr, statsB.iqr);
  const sufficient = Math.min(statsA.n, statsB.n) >= 10;
  let conclusion = 'gain non démontré (dispersion observée)';
  if (deltaMedian > 0) conclusion = 'régression observée';
  else if (deltaMedian < -dispersionMs) {
    if (!sufficient) conclusion = 'baisse descriptive, données insuffisantes';
    else if (!options.approval) conclusion = 'baisse descriptive, H05 en attente';
    else if (options.startupWithinBudget !== true) conclusion = 'gain utile non démontré (budget startup)';
    else if (-deltaMedian < options.approval.usefulGainMs) conclusion = 'gain utile non démontré (seuil H05)';
    else conclusion = 'gain utile démontré';
  }
  if (options.technicalFailures > 0) conclusion = 'erreurs techniques présentes, gain non démontré';
  return {
    statsA, statsB, deltaMedian, ratio,
    ratioDefinition: 'médiane B / médiane A ; null si A=0',
    dispersionMs, status: 'descriptif ; IQR observé, pas un test de significativité', sufficient, conclusion,
  };
}

function differences(a, b, prefix = '') {
  if (canonical(a) === canonical(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => differences(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return [{ path: prefix, A: a, B: b }];
}
export function compareDatasets(inputA, inputB, decisions = {}) {
  const a = validateDataset(inputA);
  const b = validateDataset(inputB);
  object(decisions, 'decisions');
  validateApproval(decisions.approval);
  const selfComparison = canonical(a) === canonical(b);
  requireValid(selfComparison || (a.variant === 'A' && b.variant === 'B'), 'ordre A puis B (ou A contre A identique)');
  requireValid(canonical(a.protocol) === canonical(b.protocol), 'protocoles incompatibles');
  // Les différences de sources/images prévues sont explicites et leurs valeurs
  // vérifiées. Aucune whitelist ne permet de changer corpus/poids/ressources.
  const planned = decisions.expectedDifferences ?? {};
  object(planned, 'expectedDifferences');
  const diffs = differences(a.metadata, b.metadata);
  const comparableFields = ['versions', 'resources', 'weightsSha256', 'corpus'];
  for (const field of comparableFields) {
    requireValid(canonical(a.metadata[field]) === canonical(b.metadata[field]), `${field} incompatibles`);
  }
  const sourceDiffs = diffs.filter(diff => /^(sources\.[FBO]\.(head|servedSha256)|images\.(frontend|api|worker))$/.test(diff.path));
  for (const diff of sourceDiffs) {
    requireValid(canonical(planned[diff.path]) === canonical({ A: diff.A, B: diff.B }), `différentiel non prévu : ${diff.path}`);
  }
  for (const key of Object.keys(planned)) requireValid(sourceDiffs.some(diff => diff.path === key), `différentiel prévu absent : ${key}`);
  // L'utilisation instantanée n'est pas un invariant de machine ; elle reste
  // une observation séparée, jamais comparée par égalité stricte.
  const unknownDiffs = diffs.filter(diff => !sourceDiffs.includes(diff) && diff.path !== 'utilization' && !diff.path.startsWith('utilization.'));
  requireValid(unknownDiffs.length === 0, 'métadonnées incompatibles');
  const approval = selfComparison ? undefined : decisions.approval;
  const strata = [];
  for (const category of Object.keys(COUNTS)) {
    for (const kind of KINDS) {
      const group = dataset => dataset.runs.filter(run => run.category === category && run.kind === kind);
      const runsA = group(a);
      const runsB = group(b);
      const technicalFailures = [...runsA, ...runsB].filter(run => run.verdict === 'failed').length;
      const startupA = computeStats(runsA.map(run => run.startupMs));
      const startupB = computeStats(runsB.map(run => run.startupMs));
      const startupWithinBudget = approval ? startupB.max <= approval.maxStartupMs : null;
      strata.push({
        category, kind, technicalFailures, startupA, startupB, startupWithinBudget,
        durations: Object.fromEntries(DURATIONS.map(field => [field, compareSeries(
          runsA.map(run => run[field]), runsB.map(run => run[field]),
          { approval, startupWithinBudget, technicalFailures },
        )])),
      });
    }
  }
  return {
    schemaVersion: 2, selfComparison, approval: approval ?? null,
    differences: sourceDiffs, strata,
    errors: { A: a.runs.filter(run => run.verdict === 'failed').length, B: b.runs.filter(run => run.verdict === 'failed').length },
    observations: { utilizationA: a.metadata.utilization ?? null, utilizationB: b.metadata.utilization ?? null },
    limits: 'Comparaison par catégorie ET kind, sans p95 des petits effectifs ni revendication statistique. H05 requis pour un gain utile ; les strates de moins de10 observations par variante restent descriptives.',
  };
}

/** Corpus synthétique pour tester le schéma, jamais une mesure YOLO. */
function syntheticDataset(variant = 'A', total = 500) {
  const hash = char => char.repeat(64);
  const photo = char => ({ sha256: hash(char), mimeType: 'image/jpeg', width: 640, height: 480, authorization: 'synthétique, aucune photo personnelle' });
  const start = new Date('2026-10-27T00:00:00.000Z').getTime();
  return {
    schemaVersion: 2, variant,
    protocol: { seed: 20261025, counts: { ...COUNTS }, timingPrecisionMs: 1 },
    metadata: {
      sources: Object.fromEntries(['F', 'B', 'O'].map(repo => [repo, { head: 'a'.repeat(40), servedSha256: hash('a') }])),
      images: Object.fromEntries(['frontend', 'api', 'worker'].map(service => [service, `sha256:${hash('b')}`])),
      versions: { node: 'test-node', python: 'test-python', playwright: 'test-pw', three: 'test-three', pytorch: 'test-torch', ultralytics: 'test-yolo' },
      resources: { hardware: { cpu: 'test CPU', ramBytes: 16e9, gpu: 'inconnue' }, docker: { cpus: 4, memoryBytes: 8e9 }, workers: 1 },
      weightsSha256: hash('c'), corpus: { drink: photo('d'), no_drink: photo('e') },
    },
    runs: makeSchedule().map((slot, index) => {
      const processIndex = slot.category === 'warm' ? 13 : index;
      return {
        ...slot, photoHash: hash(slot.kind === 'drink' ? 'd' : 'e'), job_id: `${variant}-job-${index}`, attempt: index + 1,
        epoch: `${variant}-epoch-${processIndex}`, process: { hostPid: 100 + processIndex, startedAt: new Date(start + processIndex * 60_000).toISOString() },
        firstJobOfProcess: slot.category !== 'warm', verdict: slot.kind === 'drink' ? 'succeeded' : 'rejected',
        timestampUtc: new Date(start + index * 60_000 + 10_000).toISOString(), startupMs: 1000,
        clickToPostMs: total / 10, postToAcceptedMs: total / 10, acceptedToResultMs: total * 0.8, totalDurationMs: total,
      };
    }),
  };
}

export function runSelfTest() {
  let checks = 0;
  const check = (condition, label) => { assert.ok(condition, label); checks++; };
  const invalid = (mutate, pattern = /invalides/) => {
    const data = syntheticDataset();
    mutate(data);
    assert.throws(() => validateDataset(data), pattern);
    checks++;
  };
  const approval = { reference: 'H05-SYNTHETIQUE-TEST-SEULEMENT', usefulGainMs: 100, maxStartupMs: 1200 };
  const opts = { approval, startupWithinBudget: true };
  const ten = n => Array(10).fill(n);
  check(compareSeries(ten(100), ten(100)).deltaMedian === 0, 'identiques');
  check(compareSeries([10, 100, 200], [10, 90, 200]).conclusion.includes('dispersion'), 'bruit observé');
  check(compareSeries(ten(500), ten(200), opts).conclusion === 'gain utile démontré', 'gain au seuil approuvé');
  check(compareSeries(ten(500), ten(200)).conclusion.includes('H05'), 'pas de gain sans H05');
  check(compareSeries([500], [200], opts).conclusion.includes('insuffisantes'), 'froid descriptif');
  check(compareSeries(ten(500), ten(200), { approval, startupWithinBudget: false }).conclusion.includes('startup'), 'budget startup');
  check(compareSeries(ten(500), ten(450), opts).conclusion.includes('seuil'), 'seuil utile');
  check(compareSeries(ten(200), ten(500), opts).conclusion.includes('régression'), 'régression visible');
  check(compareSeries(ten(0), ten(0)).ratio === null, 'A=0 inconnu');
  check(compareSeries(ten(500), ten(200), { ...opts, technicalFailures: 1 }).conclusion.includes('erreurs'), 'erreurs visibles');
  assert.throws(() => compareSeries([], [1])); checks++;
  assert.throws(() => compareSeries([NaN], [1])); checks++;
  assert.throws(() => compareSeries([Number.MIN_VALUE], [Number.MAX_VALUE]), /ratio non fini/); checks++;
  assert.throws(() => compareSeries([1], [1], { approval: {} })); checks++;
  check(validateDataset(syntheticDataset()).runs.length === 33, '33 observations');
  for (const value of [NaN, Infinity, -1, null, '100']) invalid(d => { d.runs[0].totalDurationMs = value; });
  for (const field of ['sources', 'images', 'versions', 'resources', 'weightsSha256', 'corpus']) invalid(d => { delete d.metadata[field]; });
  invalid(d => { d.schemaVersion = 1; });
  invalid(d => { delete d.protocol.timingPrecisionMs; });
  invalid(d => { d.protocol.counts.warm = 19; });
  invalid(d => { d.runs.pop(); });
  invalid(d => { d.runs[1] = { ...d.runs[0] }; });
  invalid(d => { d.runs[1].job_id = d.runs[0].job_id; });
  invalid(d => { d.runs[1].attempt = d.runs[0].attempt; });
  invalid(d => { d.runs[0].category = 'inconnue'; });
  invalid(d => { delete d.runs[0].repetition; });
  invalid(d => { d.runs[0].kind = d.runs[0].kind === 'drink' ? 'no_drink' : 'drink'; });
  invalid(d => { d.runs[0].photoHash = 'f'.repeat(64); });
  invalid(d => { d.runs[0].verdict = d.runs[0].kind === 'drink' ? 'rejected' : 'succeeded'; });
  invalid(d => { d.runs[0].totalDurationMs += 10; });
  invalid(d => { d.runs[0].timestampUtc = 'hier'; });
  invalid(d => { d.runs[0].firstJobOfProcess = false; });
  invalid(d => { d.runs[1].epoch = d.runs[0].epoch; });
  invalid(d => { d.runs[1].process = { ...d.runs[0].process }; });
  invalid(d => { d.metadata.corpus.no_drink.sha256 = d.metadata.corpus.drink.sha256; });
  invalid(d => { d.metadata.corpus.drink.width = 1; });
  invalid(d => { d.metadata.resources.workers = 2; });
  invalid(d => { d.metadata.versions.node = ''; });
  assert.throws(() => validateDataset([])); checks++;
  assert.throws(() => validateDataset({ runs: [123] })); checks++;
  const a = syntheticDataset();
  const b = syntheticDataset('B', 200);
  const result = compareDatasets(a, b, { approval });
  check(result.strata.length === 6, 'jamais agréger boisson/refus');
  check(result.strata.filter(s => s.category === 'warm').every(s => s.durations.totalDurationMs.conclusion === 'gain utile démontré'), 'warm qualifié synthétique');
  check(result.strata.filter(s => s.category === 'cold-image').every(s => s.durations.totalDurationMs.conclusion.includes('insuffisantes')), '1/2 froid descriptif');
  check(compareDatasets(a, a, { approval }).selfComparison, 'A/A validation');
  for (const mutate of [
    d => { d.metadata.versions.pytorch = 'autre'; },
    d => { d.metadata.weightsSha256 = 'f'.repeat(64); },
    d => { d.metadata.resources.docker.cpus = 8; },
    d => { d.metadata.corpus.drink.authorization = 'autre corpus'; },
    d => { d.protocol.timingPrecisionMs = 0.1; },
  ]) {
    const changed = structuredClone(b);
    mutate(changed);
    assert.throws(() => compareDatasets(a, changed)); checks++;
  }
  const changed = structuredClone(b);
  changed.metadata.sources.F.head = 'f'.repeat(40);
  changed.metadata.images.frontend = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => compareDatasets(a, changed), /non prévu/); checks++;
  const expectedDifferences = Object.fromEntries(differences(a.metadata, changed.metadata).map(diff => [diff.path, { A: diff.A, B: diff.B }]));
  check(compareDatasets(a, changed, { expectedDifferences }).differences.length === 2, 'HEAD/images prévus autorisés et listés');
  const observed = structuredClone(b);
  observed.metadata.utilization = { cpuPercent: 70 };
  const observedA = structuredClone(a);
  observedA.metadata.utilization = { cpuPercent: 5 };
  check(compareDatasets(observedA, observed).observations.utilizationB.cpuPercent === 70, 'usage instantané séparé');
  check(compareDatasets(a, observed).observations.utilizationA === null, 'usage absent inconnu, pas invariant');
  const failed = structuredClone(b);
  failed.runs.find(run => run.category === 'warm').verdict = 'failed';
  check(compareDatasets(a, failed, { approval }).errors.B === 1, 'échec technique conservé');

  // Vrais codes de sortie CLI sur fichiers synthétiques, jamais un backend.
  const root = process.env.BEERCALL_USAGE_RESULTS ?? join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'opencode');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 't41-self-test-'));
  try {
    const fileA = join(dir, 'A.json');
    const fileB = join(dir, 'B.json');
    writeFileSync(fileA, JSON.stringify(a));
    writeFileSync(fileB, JSON.stringify(b));
    const invoke = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url), fileA, fileB], { encoding: 'utf8', env: { ...process.env, BEERCALL_USAGE_RESULTS: dir } });
    check(invoke().status === 0, 'CLI valide');
    for (const bad of [[123], { runs: [] }, { ...b, schemaVersion: 1 }, { ...b, runs: b.runs.slice(1) }]) {
      writeFileSync(fileB, JSON.stringify(bad));
      const child = invoke();
      check(child.status === 1 && child.stderr.includes('invalides'), 'CLI invalide non0');
    }
    for (const mutate of [
      d => { d.runs[0].totalDurationMs = -1; },
      d => { d.runs[0].verdict = 'incompatible'; },
      d => { d.metadata.weightsSha256 = 'f'.repeat(64); },
      d => { d.metadata.versions.python = 'autre'; },
    ]) {
      const bad = structuredClone(b);
      mutate(bad);
      writeFileSync(fileB, JSON.stringify(bad));
      check(invoke().status === 1, 'CLI négatif/verdict/poids/version non0');
    }
    writeFileSync(fileB, '{"totalDurationMs":NaN}');
    check(invoke().status === 1, 'JSON non fini refusé');
    writeFileSync(fileB, JSON.stringify(failed));
    check(invoke().status === 1, 'CLI échec technique non0, rapport conservé');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(import.meta.url)}); console.log('import-ok')`, 'ignoredA', 'ignoredB'], { encoding: 'utf8' });
    check(imported.status === 0 && imported.stdout.trim() === 'import-ok', 'import sans CLI/process.exit');
  } finally {
    // Seulement le dossier synthétique créé ici, aucun résultat utilisateur.
    rmSync(dir, { recursive: true });
  }
  console.log(`[summarize-latency] ${checks} contrôles synthétiques réussis (aucune mesure réelle).`);
  return checks;
}

export function main(args = process.argv.slice(2)) {
  try {
    if (args.length === 1 && args[0] === '--self-test') { runSelfTest(); return 0; }
    requireValid(args.length === 2 || (args.length === 4 && args[2] === '--decisions'), 'usage : A.json B.json [--decisions decisions.json]');
    const load = file => JSON.parse(readFileSync(resolve(file), 'utf8'));
    const report = compareDatasets(load(args[0]), load(args[1]), args[3] ? load(args[3]) : {});
    console.log(JSON.stringify(report, null, 2));
    if (process.env.BEERCALL_USAGE_RESULTS) {
      const dir = resolve(process.env.BEERCALL_USAGE_RESULTS);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'latency-summary.json'), JSON.stringify(report, null, 2));
    }
    return report.errors.A + report.errors.B > 0 ? 1 : 0;
  } catch (error) {
    console.error(`[summarize-latency] ${error.message}`);
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
