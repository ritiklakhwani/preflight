/**
 * Dev tool: turn the weights into the decisions they actually produce.
 *
 * A weight is unreviewable on its own. "Is 0.5 right for unverified-source?"
 * has no answer. "Should an agent report an unverified contract to the user
 * before acting, when nothing else is wrong?" does, and that is the same
 * question asked in the units a reviewer can reason about.
 *
 *   node --import tsx scripts/weights.ts
 */
import { score } from '../packages/core/src/score.js';
import { ALL_SIGNALS } from '../packages/signals/src/all.js';
import type { SignalResult } from '../packages/core/src/types.js';

const byName = new Map(ALL_SIGNALS.map((s) => [s.name, s]));

function fire(names: string[]): SignalResult[] {
  return ALL_SIGNALS.map((s) => ({
    name: s.name,
    weight: s.weight,
    fired: names.includes(s.name),
    evidence: [],
  }));
}

const ACTION: Record<string, string> = {
  clean: 'proceed',
  low: 'proceed, mention it',
  medium: 'report to the user before acting',
  high: 'stop, require a human on hardware',
};

console.log('EACH SIGNAL ALONE\n');
console.log('  ' + 'signal'.padEnd(24) + 'w'.padStart(5) + '  score  band     agent does');
console.log('  ' + '-'.repeat(78));
for (const s of [...ALL_SIGNALS].sort((a, b) => b.weight - a.weight)) {
  const r = score(fire([s.name]));
  console.log(
    '  ' +
      s.name.padEnd(24) +
      s.weight.toFixed(2).padStart(5) +
      String(r.score).padStart(7) +
      '  ' +
      r.severity.padEnd(8) +
      ' ' +
      ACTION[r.severity],
  );
}

const COMBINATIONS: [string, string[]][] = [
  ['a blue chip with an admin key', ['privileged-control']],
  ['USDC shape: proxy plus blacklist', ['privileged-control', 'transfer-restrictions']],
  ['a wallet, mistaken for a contract', ['not-a-contract']],
  ['unverified contract, nothing else known', ['unverified-source']],
  ['unverified with no market', ['unverified-source', 'no-market']],
  ['fresh token, fresh pool', ['pool-age', 'deployer-history']],
  ['fresh token, fresh pool, unverified', ['pool-age', 'deployer-history', 'unverified-source']],
  ['fake liquidity alone', ['liquidity-reality']],
  ['classic rug shape', ['liquidity-reality', 'pool-age', 'deployer-history']],
  ['honeypot shape', ['transfer-restrictions', 'privileged-control', 'liquidity-reality']],
];

console.log('\n\nREALISTIC COMBINATIONS\n');
console.log('  ' + 'situation'.padEnd(38) + 'score  band     agent does');
console.log('  ' + '-'.repeat(88));
for (const [label, names] of COMBINATIONS) {
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`unknown signal: ${missing.join(', ')}`);
  const r = score(fire(names));
  console.log(
    '  ' +
      label.padEnd(38) +
      String(r.score).padStart(5) +
      '  ' +
      r.severity.padEnd(8) +
      ' ' +
      ACTION[r.severity],
  );
}

console.log('\n  Bands: clean 0-14, low 15-34, medium 35-59, high 60-100.');
console.log('  Change a weight in packages/signals/src/{structural,behavioural}.ts and rerun.\n');
