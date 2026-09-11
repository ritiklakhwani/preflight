/**
 * Dev tool: find benchmark candidates by querying for the shapes our signals
 * are supposed to catch.
 *
 * The benchmark's weakness is that it has one known-bad address. You cannot
 * measure a detector with one positive, and five of nine signals have never
 * fired against it, so their weights are assertions rather than findings.
 *
 * Sourcing addresses from a model is not an option: it produces plausible hex
 * that is wrong, and one mislabelled address poisons every calibration
 * decision downstream. So this asks the chain instead. Each shape below is a
 * query, each result is a candidate, and every candidate needs a human to open
 * the explorer link and confirm before it earns a label.
 *
 *   node --env-file=.env --import tsx scripts/find-candidates.ts [chainId]
 */
import './boot.js';
import { gql, subgraphFor } from '../packages/signals/src/graph.js';

const chainId = Number(process.argv[2] ?? 1);
const subgraphId = subgraphFor(chainId);
if (!subgraphId) {
  console.error(`no Uniswap V3 subgraph for chain ${chainId}`);
  process.exit(1);
}

const EXPLORER: Record<number, string> = {
  1: 'https://etherscan.io',
  42161: 'https://arbiscan.io',
  8453: 'https://basescan.org',
};

const FIELDS = `
  id createdAtTimestamp totalValueLockedUSD volumeUSD txCount
  token0 { id symbol } token1 { id symbol }
`;

interface RawPool {
  id: string;
  createdAtTimestamp: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
}

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

/**
 * Each shape names the signal it should exercise, so a candidate that turns
 * out to be genuine directly closes one of the coverage gaps.
 */
const SHAPES: { id: string; exercises: string; why: string; where: string; order: string }[] = [
  {
    id: 'young-pool',
    exercises: 'pool-age',
    why: 'created in the last 48 hours, so it has no track record either way',
    where: `createdAtTimestamp_gt: "${now - 2 * DAY}"`,
    order: 'totalValueLockedUSD',
  },
  {
    id: 'dormant-capital',
    exercises: 'liquidity-reality',
    why: 'five figures locked that almost nothing has ever traded against',
    where: `totalValueLockedUSD_gt: "50000", txCount_lt: "20", createdAtTimestamp_lt: "${now - 7 * DAY}"`,
    order: 'totalValueLockedUSD',
  },
  {
    id: 'drained',
    exercises: 'liquidity-reality',
    why: 'real volume happened and then the liquidity left, which is the rug signature',
    where: 'volumeUSD_gt: "500000", totalValueLockedUSD_lt: "2000", txCount_gt: "50"',
    order: 'volumeUSD',
  },
  {
    id: 'thin-market',
    exercises: 'liquidity-reality',
    why: 'a position of any size cannot be exited against this',
    where: 'totalValueLockedUSD_lt: "3000", totalValueLockedUSD_gt: "100", txCount_gt: "100"',
    order: 'txCount',
  },
];

/** The token under suspicion is the one that is not the well-known side. */
const KNOWN = new Set(['weth', 'usdc', 'usdt', 'dai', 'wbtc', 'frax', 'usds', 'wsteth']);
function suspect(p: RawPool) {
  const a = p.token0;
  const b = p.token1;
  if (KNOWN.has(a.symbol.toLowerCase()) && !KNOWN.has(b.symbol.toLowerCase())) return b;
  if (KNOWN.has(b.symbol.toLowerCase()) && !KNOWN.has(a.symbol.toLowerCase())) return a;
  return a;
}

const usd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const seen = new Set<string>();

console.log(`\nCandidates from chain ${chainId}. Every one needs confirming on the explorer`);
console.log('before it earns a label. Nothing here is ground truth yet.\n');

for (const shape of SHAPES) {
  const query = `{ pools(where: { ${shape.where} }, first: 6,
      orderBy: ${shape.order}, orderDirection: desc) { ${FIELDS} } }`;

  let pools: RawPool[] = [];
  try {
    pools = (await gql<{ pools: RawPool[] }>(subgraphId, query, {})).pools;
  } catch (err) {
    console.log(`${shape.id}: query failed, ${err instanceof Error ? err.message : String(err)}\n`);
    continue;
  }

  console.log(`## ${shape.id}  ->  exercises ${shape.exercises}`);
  console.log(`   ${shape.why}\n`);

  let shown = 0;
  for (const p of pools) {
    const t = suspect(p);
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    shown++;

    const tvl = Number(p.totalValueLockedUSD);
    const vol = Number(p.volumeUSD);
    const age = ((now - Number(p.createdAtTimestamp)) / DAY).toFixed(1);
    console.log(`   ${t.symbol.padEnd(14)} ${t.id}`);
    console.log(
      `   ${''.padEnd(14)} tvl ${usd(tvl)}   volume ${usd(vol)}   ` +
        `${p.txCount} tx   ${age} days old`,
    );
    console.log(`   ${''.padEnd(14)} ${EXPLORER[chainId]}/token/${t.id}`);
    console.log(`   ${''.padEnd(14)} pool: ${EXPLORER[chainId]}/address/${p.id}\n`);
  }
  if (shown === 0) console.log('   nothing matched\n');
}

console.log('For each candidate, open the token link and decide:');
console.log('  - is the source verified, and does it read like a real project');
console.log('  - did the liquidity leave, or was it never real');
console.log('  - is there a holder distribution consistent with a launch or a rug');
console.log('Then add it to test/benchmark/addresses.json with the band you expect.\n');
