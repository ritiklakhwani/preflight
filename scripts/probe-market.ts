/**
 * Dev tool: show what the Uniswap V3 subgraphs know about a token.
 *
 * Used to tune signal thresholds against real addresses rather than guesses.
 *
 *   node --env-file=.env --import tsx scripts/probe-market.ts <address> [chainId]
 */
import { queryMarket } from '../packages/signals/src/graph.js';

const address = process.argv[2];
const chainId = Number(process.argv[3] ?? 1);
if (!address) {
  console.error('usage: probe-market.ts <address> [chainId]');
  process.exit(1);
}

const usd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const age = (ts: number) => ((Date.now() / 1000 - ts) / 86400).toFixed(1) + 'd';

const t0 = Date.now();
const res = await queryMarket(address, chainId);
const ms = Date.now() - t0;

if (res.status !== 'ok') {
  console.log(`${res.status}${'error' in res ? ': ' + res.error : ''}  [${ms}ms]`);
  process.exit(0);
}

const m = res.market;
console.log(`chain ${m.chainId}  subgraph ${m.subgraphId.slice(0, 10)}..  [${ms}ms]`);
console.log(`token   ${m.symbol ?? '?'}  ${m.name ?? ''}`);
console.log(`known   ${m.known}   txCount ${m.txCount}`);
console.log(`token   tvl ${usd(m.totalValueLockedUSD)}   volume ${usd(m.volumeUSD)}`);
console.log(`pools   ${m.pools.length}`);
for (const p of m.pools.slice(0, 5)) {
  const ratio = p.totalValueLockedUSD > 0 ? p.volumeUSD / p.totalValueLockedUSD : 0;
  console.log(
    `  ${p.id.slice(0, 10)}..  ${(p.token0.symbol + '/' + p.token1.symbol).padEnd(18)}` +
      ` tvl ${usd(p.totalValueLockedUSD).padStart(16)}  vol ${usd(p.volumeUSD).padStart(16)}` +
      `  vol/tvl ${ratio.toFixed(2).padStart(8)}  tx ${String(p.txCount).padStart(9)}  age ${age(p.createdAtTimestamp)}`,
  );
}
