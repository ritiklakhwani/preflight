/**
 * Dev tool: run the signal set against labelled addresses and report where it
 * disagrees with the label.
 *
 * The number that matters is the false-positive rate. A rug detector that
 * flags WETH is not a cautious detector, it is one nobody will leave switched
 * on, and an agent that stops on every third call gets its guard rail removed.
 *
 * `expect` is the worst band an address should produce. Scoring at or below it
 * passes; scoring above it is a false positive and prints the signals that
 * caused it, so the weight responsible is obvious.
 *
 *   node --env-file=.env --import tsx scripts/benchmark.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runPreflight, createStore } from '../packages/engine/src/index.js';
import type { Severity } from '../packages/core/src/types.js';

const RANK: Record<Severity, number> = { clean: 0, low: 1, medium: 2, high: 3 };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? resolve(root, 'test/benchmark/addresses.json');
const { cases } = JSON.parse(readFileSync(file, 'utf8')) as {
  cases: { address: string; chainId: number; label: string; expect: Severity; why: string }[];
};

// Etherscan's free tier allows 5 calls a second and one verdict makes up to
// five. Without this pause the run rate-limits itself and every address comes
// back CLEAN, which is exactly the failure the coverage check now catches.
const PAUSE_MS = 1500;
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

const store = await createStore();
let overshoot = 0;
let undershoot = 0;

console.log(
  '\n  ' + 'address'.padEnd(20) + 'expect'.padEnd(9) + 'actual'.padEnd(9) + 'score  fired',
);
console.log('  ' + '-'.repeat(96));

let first = true;
for (const c of cases) {
  if (!first) await pause();
  first = false;
  let line: string;
  try {
    const v = await runPreflight(c.address, c.chainId, { store });
    const fired = v.signals.filter((s) => s.fired).map((s) => s.name);
    const errored = v.coverage.total - v.coverage.ran;
    const delta = RANK[v.severity] - RANK[c.expect];
    const flag = delta > 0 ? 'OVER ' : delta < 0 ? 'under' : '  ok ';
    if (delta > 0) overshoot++;
    if (delta < 0) undershoot++;

    line =
      '  ' +
      c.label.padEnd(20) +
      c.expect.padEnd(9) +
      v.severity.padEnd(9) +
      String(v.score).padStart(5) +
      '  ' +
      flag +
      '  ' +
      (fired.join(', ') || 'none') +
      (errored ? `  [${errored} could not run]` : '');
  } catch (err) {
    line = `  ${c.label.padEnd(20)}ERROR    ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(line);
}

console.log('  ' + '-'.repeat(96));
console.log(
  `\n  ${cases.length} cases   ${overshoot} scored above their label (false positives)` +
    `   ${undershoot} below (missed risk)\n`,
);
console.log('  A false positive on a blue chip is the expensive failure: it is the one');
console.log('  that gets Preflight uninstalled. Fix those before tuning anything else.\n');

await store.close();
