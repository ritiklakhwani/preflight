import { describe, expect, it } from 'vitest';
import {
  deployerHistory,
  liquidityReality,
  noMarket,
  notAContract,
  poolAge,
} from '../src/behavioural.js';
import type { Pool } from '../src/graph.js';
import { analysis, context, market } from '../../../test/fixtures.js';

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

const pool = (over: Partial<Pool> = {}): Pool => ({
  id: '0x00000000000000000000000000000000000000p1',
  createdAtTimestamp: now() - 400 * DAY,
  totalValueLockedUSD: 5_000_000,
  volumeUSD: 900_000_000,
  txCount: 250_000,
  feeTier: 3000,
  token0: { id: '0xa', symbol: 'TKN' },
  token1: { id: '0xb', symbol: 'WETH' },
  ...over,
});

describe('not-a-contract', () => {
  it('fires on an address with no creation record', async () => {
    const r = await notAContract.run(context({ analysis: analysis({ isContract: false }) }));
    expect(r.fired).toBe(true);
  });

  it('does not fire on a contract, and names the deployer', async () => {
    const r = await notAContract.run(context());
    expect(r.fired).toBe(false);
    expect(r.evidence[0]!.untrusted).toBe(true);
  });

  it('errors rather than guessing when the explorer could not be reached', async () => {
    const r = await notAContract.run(context({ analysis: analysis({ isContract: null }) }));
    expect(r.error).toBeDefined();
    expect(r.fired).toBe(false);
  });
});

describe('no-market', () => {
  it('fires for an ERC-20 with no pool', async () => {
    const r = await noMarket.run(context({ market: market({ pools: [] }) }));
    expect(r.fired).toBe(true);
  });

  it('does not fire for a contract that is not a token', async () => {
    // Asking whether a lending pool has a Uniswap market is a category mistake.
    const r = await noMarket.run(
      context({ analysis: analysis({ isErc20: false }), market: market({ pools: [] }) }),
    );
    expect(r.fired).toBe(false);
  });

  it('errors, rather than reporting no market, when The Graph is unreachable', async () => {
    // The distinction that matters most in this file. A gateway outage must
    // never be reported as a finding about the token.
    const r = await noMarket.run(
      context({ market: { status: 'error', error: 'timeout' } }),
    );
    expect(r.fired).toBe(false);
    expect(r.error).toContain('timeout');
  });

  it('errors on a chain we do not index', async () => {
    const r = await noMarket.run(
      context({ market: { status: 'unsupported-chain', chainId: 137 } }),
    );
    expect(r.error).toContain('137');
  });
});

describe('pool-age', () => {
  it('fires on a pool created yesterday', async () => {
    const r = await poolAge.run(
      context({ market: market({ pools: [pool({ createdAtTimestamp: now() - DAY })] }) }),
    );
    expect(r.fired).toBe(true);
  });

  it('does not fire on an established pool', async () => {
    const r = await poolAge.run(context({ market: market({ pools: [pool()] }) }));
    expect(r.fired).toBe(false);
  });
});

describe('liquidity-reality', () => {
  it('fires on large value that nothing has traded against', async () => {
    // The demo asset, in miniature: a pool holding a fortune that four
    // transactions have ever touched.
    const r = await liquidityReality.run(
      context({
        market: market({
          pools: [pool({ totalValueLockedUSD: 1_110_167_010_696, txCount: 4, volumeUSD: 0 })],
        }),
      }),
    );
    expect(r.fired).toBe(true);
    expect(r.evidence[0]!.label).toBe('dormant capital');
  });

  it('does not fire on a real pool that reports zero tracked volume', async () => {
    // WBTC/USDC on Arbitrum: $18.7m locked, $0 volume because the subgraph
    // only tracks whitelisted pairs, 8.6m real transactions. Volume alone
    // would flag this. Transaction count is what separates it.
    const r = await liquidityReality.run(
      context({
        market: market({
          pools: [pool({ totalValueLockedUSD: 18_670_643, volumeUSD: 0, txCount: 8_684_384 })],
        }),
      }),
    );
    expect(r.fired).toBe(false);
  });

  it('does not fire on a young quiet pool, which is pool-age territory', async () => {
    const r = await liquidityReality.run(
      context({
        market: market({
          pools: [pool({ createdAtTimestamp: now() - DAY, txCount: 2, totalValueLockedUSD: 50_000 })],
        }),
      }),
    );
    expect(r.fired).toBe(false);
  });

  it('fires when the deepest pool is too thin to exit against', async () => {
    const r = await liquidityReality.run(
      context({ market: market({ pools: [pool({ totalValueLockedUSD: 900 })] }) }),
    );
    expect(r.fired).toBe(true);
    expect(r.evidence[0]!.label).toBe('thin liquidity');
  });
});

describe('deployer-history', () => {
  const deployer = (firstSeenDaysAgo: number, deployments: number) =>
    context({
      deployer: {
        status: 'ok' as const,
        firstSeen: now() - firstSeenDaysAgo * DAY,
        deployments,
        sampled: 100,
        truncated: true,
      },
    });

  it('fires on a new address already shipping contracts at volume', async () => {
    expect((await deployerHistory.run(deployer(5, 9))).fired).toBe(true);
  });

  it('does not fire on an established prolific deployer', async () => {
    // Infrastructure teams deploy constantly. Age is what separates them.
    expect((await deployerHistory.run(deployer(1999, 40))).fired).toBe(false);
  });

  it('does not fire on a new address that deployed one thing', async () => {
    expect((await deployerHistory.run(deployer(3, 1))).fired).toBe(false);
  });

  it('errors when the deployer history could not be read', async () => {
    const r = await deployerHistory.run(
      context({ deployer: { status: 'error', error: 'rate limited' } }),
    );
    expect(r.error).toContain('rate limited');
  });
});
