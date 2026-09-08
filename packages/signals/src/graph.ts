/**
 * NEW during ETHOnline 2026.
 *
 * The Graph is where Preflight learns what a contract has actually done, as
 * opposed to what its source code says it will do. A node can tell you a
 * token's current balance; it cannot tell you that the only pool holding it
 * was created six hours ago and has never been traded. That needs indexed
 * history, and The Graph's network is where that history lives.
 *
 * We read the official Uniswap V3 subgraphs. Uniswap wrote the schema and the
 * mapping handlers; The Graph's Indexers run that code and serve the result
 * through a gateway we authenticate against with a Subgraph Studio key.
 *
 * One query string covers every chain. Uniswap ships identical subgraph code
 * to each deployment, so only the subgraph id changes. Verified 2026-09-09
 * against USDC on Ethereum, Arbitrum and Base.
 */

/**
 * Subgraph ids are public identifiers, not secrets, so they ship as defaults.
 * A judge who clones this repo needs only GRAPH_API_KEY to get live data.
 *
 * Every id here uses Uniswap's own schema, with `pools` and `tokens` at the
 * root. Several subgraphs on the network are also labelled "Uniswap V3" but
 * use the Messari standardized schema, where the root field is
 * `liquidityPools` and this query returns an error. Screen any replacement
 * with scripts/probe-subgraph.ts, which prints the schema family, before
 * putting it here.
 */
const DEFAULT_SUBGRAPHS: Record<number, string> = {
  1: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV', // Ethereum
  42161: 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM', // Arbitrum One
  8453: 'HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1', // Base
};

const ENV_OVERRIDES: Record<number, string> = {
  1: 'SG_UNISWAP_V3_ETHEREUM',
  42161: 'SG_UNISWAP_V3_ARBITRUM',
  8453: 'SG_UNISWAP_V3_BASE',
};

const GATEWAY = 'https://gateway.thegraph.com/api';
const TIMEOUT_MS = 15_000;

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

export function subgraphFor(chainId: number): string | undefined {
  const override = ENV_OVERRIDES[chainId];
  // SG_UNISWAP_V3 is the pre-multichain name, kept working for Ethereum only.
  return (
    (override ? env(override) : undefined) ??
    (chainId === 1 ? env('SG_UNISWAP_V3') : undefined) ??
    DEFAULT_SUBGRAPHS[chainId]
  );
}

export function supportedChains(): number[] {
  return Object.keys(DEFAULT_SUBGRAPHS).map(Number);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Pool {
  id: string;
  /** Unix seconds. */
  createdAtTimestamp: number;
  totalValueLockedUSD: number;
  /** Lifetime, not 24h. */
  volumeUSD: number;
  txCount: number;
  /** Hundredths of a basis point. 500 is 0.05%. */
  feeTier: number;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
}

export interface TokenMarket {
  chainId: number;
  subgraphId: string;
  /** False when the subgraph has never seen this address in any pool. */
  known: boolean;
  symbol: string | null;
  name: string | null;
  txCount: number;
  volumeUSD: number;
  totalValueLockedUSD: number;
  /** Deepest first. Deduplicated across the three lookup paths. */
  pools: Pool[];
  queriedAt: string;
}

/**
 * Three outcomes, deliberately distinguished.
 *
 * A signal must never treat "the gateway timed out" as "this token has no
 * market". The first is a gap in our knowledge and the second is a finding
 * about the token, and conflating them produces confident false positives on
 * the exact day the network is having trouble.
 */
export type MarketResult =
  | { status: 'ok'; market: TokenMarket }
  | { status: 'unsupported-chain'; chainId: number }
  | { status: 'error'; error: string };

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

const POOL_FIELDS = `
  id
  createdAtTimestamp
  totalValueLockedUSD
  volumeUSD
  txCount
  feeTier
  token0 { id symbol }
  token1 { id symbol }
`;

/**
 * Three selections, sent as three parallel requests rather than one document.
 *
 * A pair is directional in this schema, so a token can sit on either side and
 * both have to be walked. Together they cover every pool holding it.
 *
 * Two measurements drove this shape, both taken against USDC on Base, which
 * is the worst case because USDC is paired with almost everything:
 *
 *   page size 5   2.8s      one document, both sides   ~13s, times out
 *   page size 10  4.4s      three parallel requests    ~4.4s
 *   page size 20  7.4s
 *
 * Aliased selections in one GraphQL document are billed serially by the
 * indexer, so their latencies add. Separate requests overlap. Ethereum and
 * Arbitrum are fast enough that neither choice matters there; Base is not.
 *
 * `token.whitelistPools` looks like a shortcut and is a trap. It is only
 * populated for tokens paired against a whitelisted asset, which a fresh scam
 * token never is, so it misses exactly the tokens we care about. It also took
 * 35 seconds for USDC on Base. The two pool lookups return a superset.
 */
const PAGE_SIZE = 10;

const TOKEN_QUERY = `
  query TokenAggregates($token: ID!) {
    token(id: $token) {
      symbol
      name
      txCount
      volumeUSD
      totalValueLockedUSD
    }
  }
`;

const POOLS_AS_TOKEN0 = `
  query PoolsAsToken0($addr: String!, $first: Int!) {
    pools(where: { token0: $addr }, first: $first,
          orderBy: totalValueLockedUSD, orderDirection: desc) { ${POOL_FIELDS} }
  }
`;

const POOLS_AS_TOKEN1 = `
  query PoolsAsToken1($addr: String!, $first: Int!) {
    pools(where: { token1: $addr }, first: $first,
          orderBy: totalValueLockedUSD, orderDirection: desc) { ${POOL_FIELDS} }
  }
`;

interface RawPool {
  id: string;
  createdAtTimestamp: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
  feeTier: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
}

interface RawToken {
  token: {
    symbol: string;
    name: string;
    txCount: string;
    volumeUSD: string;
    totalValueLockedUSD: string;
  } | null;
}

interface RawPools {
  pools: RawPool[];
}

/** The subgraph returns BigInt and BigDecimal as strings. */
function num(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toPool(raw: RawPool): Pool {
  return {
    id: raw.id,
    createdAtTimestamp: num(raw.createdAtTimestamp),
    totalValueLockedUSD: num(raw.totalValueLockedUSD),
    volumeUSD: num(raw.volumeUSD),
    txCount: num(raw.txCount),
    feeTier: num(raw.feeTier),
    token0: raw.token0,
    token1: raw.token1,
  };
}

export async function gql<T>(subgraphId: string, query: string, variables: unknown): Promise<T> {
  const key = env('GRAPH_API_KEY');
  if (!key) throw new Error('GRAPH_API_KEY is not set');

  const res = await fetch(`${GATEWAY}/${key}/subgraphs/id/${subgraphId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    // A schema mismatch surfaces here, which is the failure mode worth naming:
    // it means the subgraph id points at something with a different schema.
    throw new Error(`subgraph: ${body.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
  }
  if (!body.data) throw new Error('subgraph returned no data');
  return body.data;
}

/**
 * Every Uniswap V3 pool holding this token on this chain.
 *
 * Never throws. A caller waiting to produce a verdict gets a status it can
 * reason about rather than an exception it has to catch.
 */
export async function queryMarket(address: string, chainId: number): Promise<MarketResult> {
  const subgraphId = subgraphFor(chainId);
  if (!subgraphId) return { status: 'unsupported-chain', chainId };

  const addr = address.toLowerCase();

  try {
    // The two pool lookups are required for correctness: missing one side can
    // hide the deepest pool and make `no-market` fire on a token that has one.
    // The token aggregates are metadata, so they are allowed to fail softly.
    const [tokenData, side0, side1] = await Promise.all([
      gql<RawToken>(subgraphId, TOKEN_QUERY, { token: addr }).catch(() => null),
      gql<RawPools>(subgraphId, POOLS_AS_TOKEN0, { addr, first: PAGE_SIZE }),
      gql<RawPools>(subgraphId, POOLS_AS_TOKEN1, { addr, first: PAGE_SIZE }),
    ]);

    // A token can be token0 in one pool and token1 in another, and the lists
    // overlap for a token paired against itself across fee tiers.
    const seen = new Map<string, Pool>();
    for (const raw of [...side0.pools, ...side1.pools]) {
      if (!seen.has(raw.id)) seen.set(raw.id, toPool(raw));
    }
    const pools = [...seen.values()].sort(
      (a, b) => b.totalValueLockedUSD - a.totalValueLockedUSD,
    );

    const token = tokenData?.token ?? null;

    return {
      status: 'ok',
      market: {
        chainId,
        subgraphId,
        known: Boolean(token) || pools.length > 0,
        symbol: token?.symbol ?? null,
        name: token?.name ?? null,
        txCount: num(token?.txCount),
        volumeUSD: num(token?.volumeUSD),
        totalValueLockedUSD: num(token?.totalValueLockedUSD),
        pools,
        queriedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
