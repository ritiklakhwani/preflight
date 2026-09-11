/**
 * Dev tool: screen a subgraph ID for schema family, network and freshness
 * before wiring it into the signal layer.
 *
 *   node --env-file=.env --import tsx scripts/probe-subgraph.ts <id> [<id> ...]
 */
import './boot.js';

const KEY = process.env.GRAPH_API_KEY;
if (!KEY) { console.error('GRAPH_API_KEY missing'); process.exit(1); }

async function gql(id: string, query: string) {
  const r = await fetch(`https://gateway.thegraph.com/api/${KEY}/subgraphs/id/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const b = await r.json() as any;
  return b.errors ? { error: JSON.stringify(b.errors).slice(0, 160) } : b.data;
}

for (const id of process.argv.slice(2)) {
  const short = id.slice(0, 10) + '..';
  const meta = await gql(id, `{ _meta { block { number timestamp } deployment hasIndexingErrors } }`);
  if ((meta as any).error) { console.log(`${short}  UNREACHABLE  ${(meta as any).error}`); continue; }

  const blk = (meta as any)._meta.block;
  const ageHrs = blk.timestamp ? (Date.now() / 1000 - blk.timestamp) / 3600 : NaN;
  const fresh = Number.isNaN(ageHrs) ? '?' : ageHrs < 6 ? 'LIVE' : ageHrs < 24 * 7 ? 'lagging' : 'STALE';

  const schema = await gql(id, `{ __schema { queryType { fields { name } } } }`);
  const names: string[] = (schema as any).__schema.queryType.fields.map((f: any) => f.name);
  const family =
    names.includes('liquidityPools') ? 'DEX AMM'
    : names.includes('lendingProtocols') ? 'Lending/CDP'
    : names.includes('vaults') ? 'Yield'
    : names.includes('marketplaces') ? 'NFT Marketplace'
    : 'other';

  let net = '?';
  for (const [f, sel] of [['lendingProtocols','network'],['dexAmmProtocols','network'],['protocols','network']] as const) {
    if (!names.includes(f)) continue;
    const d = await gql(id, `{ ${f}(first:1){ name ${sel} } }`);
    const row = (d as any)?.[f]?.[0];
    if (row) { net = `${row.network} (${row.name})`; break; }
  }

  console.log(
    `${short}  ${family.padEnd(15)} ${fresh.padEnd(8)} ` +
    `block ${blk.number}  ${Number.isNaN(ageHrs) ? '' : `age ${ageHrs.toFixed(0)}h`}  ${net}`
  );
}
