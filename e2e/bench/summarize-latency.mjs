#!/usr/bin/env node
/**
 * summarize-latency.mjs
 * Analyse statistique comparative des latences A/B pour BeerCall (PERF-01 / T07a).
 * Calcule n, médiane, IQR, min, max, écarts absolus et ratios B/A.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

export function computeStats(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { n: 0, median: 0, iqr: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q25 = quantile(sorted, 0.25);
  const q50 = quantile(sorted, 0.50);
  const q75 = quantile(sorted, 0.75);
  return {
    n: sorted.length,
    median: Math.round(q50 * 100) / 100,
    iqr: Math.round((q75 - q25) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

export function compareSeries(seriesA, seriesB, noiseThresholdMs = 25) {
  const statsA = computeStats(seriesA);
  const statsB = computeStats(seriesB);

  if (statsA.n === 0 || statsB.n === 0) {
    return {
      statsA,
      statsB,
      deltaMedian: 0,
      ratio: 1,
      conclusion: 'non comparable (série vide)',
    };
  }

  const deltaMedian = Math.round((statsB.median - statsA.median) * 100) / 100;
  const ratio = statsA.median > 0 ? Math.round((statsB.median / statsA.median) * 1000) / 1000 : 1;

  let conclusion = 'gain démontré';
  if (Math.abs(deltaMedian) <= noiseThresholdMs) {
    conclusion = 'gain non démontré (dans le bruit de mesure)';
  } else if (deltaMedian > 0) {
    conclusion = 'régression constatée';
  }

  return {
    statsA,
    statsB,
    deltaMedian,
    ratio,
    conclusion,
  };
}

export function runSelfTest() {
  console.log('[summarize-latency] Exécution du self-test...');

  // Test 1: Données identiques -> delta=0, ratio=1, gain non démontré
  const sIdentical = [100, 105, 95, 102, 98];
  const comp1 = compareSeries(sIdentical, sIdentical);
  if (comp1.deltaMedian !== 0 || comp1.ratio !== 1 || !comp1.conclusion.includes('non démontré')) {
    throw new Error(`Self-test échoué sur données identiques: ${JSON.stringify(comp1)}`);
  }

  // Test 2: Données non comparables (série vide)
  const comp2 = compareSeries([], [100, 110]);
  if (!comp2.conclusion.includes('non comparable')) {
    throw new Error(`Self-test échoué sur données non comparables: ${JSON.stringify(comp2)}`);
  }

  // Test 3: Amélioration nette (gain démontré)
  const sA = [500, 520, 480, 510, 490];
  const sB = [200, 210, 190, 205, 195];
  const comp3 = compareSeries(sA, sB);
  if (comp3.deltaMedian >= 0 || comp3.ratio >= 1 || comp3.conclusion !== 'gain démontré') {
    throw new Error(`Self-test échoué sur amélioration: ${JSON.stringify(comp3)}`);
  }

  // Test 4: Régression nette
  const comp4 = compareSeries(sB, sA);
  if (comp4.deltaMedian <= 0 || comp4.conclusion !== 'régression constatée') {
    throw new Error(`Self-test échoué sur régression: ${JSON.stringify(comp4)}`);
  }

  console.log('[summarize-latency] Self-test réussi avec succès (0).');
  return true;
}

// Point d'entrée CLI
if (process.argv[2] === '--self-test') {
  try {
    runSelfTest();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
} else if (process.argv.length >= 4) {
  try {
    const fileA = resolve(process.argv[2]);
    const fileB = resolve(process.argv[3]);
    const dataA = JSON.parse(readFileSync(fileA, 'utf-8'));
    const dataB = JSON.parse(readFileSync(fileB, 'utf-8'));

    // Extraction des séries (par exemple totalDurationMs ou e2eDurationMs)
    const seriesA = (Array.isArray(dataA) ? dataA : dataA.runs ?? []).map(r => r.totalDurationMs ?? r.durationMs ?? r);
    const seriesB = (Array.isArray(dataB) ? dataB : dataB.runs ?? []).map(r => r.totalDurationMs ?? r.durationMs ?? r);

    const comparison = compareSeries(seriesA, seriesB);

    console.log('\n=== SYNTHÈSE COMPARATIVE DE LATENCE A/B (PERF-01) ===');
    console.log(`Variante A: n=${comparison.statsA.n}, méd=${comparison.statsA.median}ms, IQR=${comparison.statsA.iqr}ms, [${comparison.statsA.min}ms .. ${comparison.statsA.max}ms]`);
    console.log(`Variante B: n=${comparison.statsB.n}, méd=${comparison.statsB.median}ms, IQR=${comparison.statsB.iqr}ms, [${comparison.statsB.min}ms .. ${comparison.statsB.max}ms]`);
    console.log(`Écart médian (B - A): ${comparison.deltaMedian}ms`);
    console.log(`Ratio B / A: ${comparison.ratio}`);
    console.log(`Verdict: ${comparison.conclusion}\n`);

    if (process.env.BEERCALL_USAGE_RESULTS) {
      const outPath = resolve(process.env.BEERCALL_USAGE_RESULTS, 'latency-summary.json');
      writeFileSync(outPath, JSON.stringify(comparison, null, 2), 'utf-8');
      console.log(`Rapport sauvegardé sous: ${outPath}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`[summarize-latency] Erreur:`, err.message);
    process.exit(1);
  }
}
