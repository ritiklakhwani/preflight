import { describe, expect, it } from 'vitest';
import {
  deployerHistory,
  holderConcentration,
  liquidityReality,
  noMarket,
  notAContract,
  poolAge,
  thinLiquidity,
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
  const thinlyHeld = { status: 'ok' as const, sampled: 13, uniqueAddresses: 6, spanSeconds: 900_000 };

  it('fires on large value that nothing has traded against, held by almost nobody', () => {
    // The demo asset. $1.1T locked, four transactions ever, six addresses
    // across its last thirteen transfers.
    return expect(
      liquidityReality
        .run(
          context({
            holders: thinlyHeld,
            market: market({
              pools: [pool({ totalValueLockedUSD: 1_110_167_010_696, txCount: 4, volumeUSD: 0 })],
            }),
          }),
        )
        .then((r) => r.fired),
    ).resolves.toBe(true);
  });

  it('does not fire when the token is widely held, however quiet the pool', async () => {
    // sUSDat. A staking wrapper acquired by staking rather than swapping, so
    // its pool sits untraded while 1,259 people hold it. Identical pool shape
    // to the case above; opposite meaning. Without this it scored HIGH 90.
    const r = await liquidityReality.run(
      context({
        holders: { status: 'ok', sampled: 100, uniqueAddresses: 45, spanSeconds: 900_000 },
        market: market({
          pools: [pool({ totalValueLockedUSD: 10_239_570, txCount: 12, volumeUSD: 0 })],
        }),
      }),
    );
    expect(r.fired).toBe(false);
    expect(r.evidence.some((e) => e.value.includes('unused'))).toBe(true);
  });

  it('does not fire on a real pool that reports zero tracked volume', async () => {
    // WBTC/USDC on Arbitrum: $18.7m locked, $0 volume because the subgraph
    // only tracks whitelisted pairs, 8.6m real transactions. Volume alone
    // would flag this. Transaction count is what separates it.
    const r = await liquidityReality.run(
      context({
        holders: thinlyHeld,
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
        holders: thinlyHeld,
        market: market({
          pools: [pool({ createdAtTimestamp: now() - DAY, txCount: 2, totalValueLockedUSD: 50_000 })],
        }),
      }),
    );
    expect(r.fired).toBe(false);
  });
});

describe('thin-liquidity', () => {
  it('fires when the deepest pool is too small to exit against', async () => {
    const r = await thinLiquidity.run(
      context({ market: market({ pools: [pool({ totalValueLockedUSD: 900 })] }) }),
    );
    expect(r.fired).toBe(true);
  });

  it('says it is a routing problem rather than evidence of fraud', async () => {
    // FDUSD. A real stablecoin, 4,252 holders, whose deepest Uniswap V3 pool
    // on Ethereum holds $1,092 because its market lives elsewhere. At the old
    // weight of 0.85 this alone produced HIGH, above an unverified
    // three-holder token. It is worth 0.3 and a sentence, not a stop.
    const r = await thinLiquidity.run(
      context({
        market: market({ pools: [pool({ totalValueLockedUSD: 1_092, txCount: 4_317 })] }),
      }),
    );
    expect(r.fired).toBe(true);
    expect(thinLiquidity.weight).toBeLessThan(0.5);
    expect(r.evidence.some((e) => e.value.includes('not evidence of fraud'))).toBe(true);
  });

  it('does not fire on a deep pool', async () => {
    const r = await thinLiquidity.run(context({ market: market({ pools: [pool()] }) }));
    expect(r.fired).toBe(false);
  });
});

describe('holder-concentration', () => {
  // spanSeconds defaults to eleven days, the Ethereum pace the threshold was
  // calibrated against.
  const held = (uniqueAddresses: number, sampled = 100, spanSeconds = 950_000) =>
    context({ holders: { status: 'ok', sampled, uniqueAddresses, spanSeconds } });

  it('fires on transfers circulating among a closed set', async () => {
    // MEX: a hundred transfers among eight addresses, which is how a $104m
    // volume figure gets manufactured without anyone buying the token.
    expect((await holderConcentration.run(held(8))).fired).toBe(true);
  });

  it('does not fire on a distributed token', async () => {
    expect((await holderConcentration.run(held(57))).fired).toBe(false);
  });

  it('fires on a token almost nobody has touched', async () => {
    expect((await holderConcentration.run(held(7, 15))).fired).toBe(true);
  });

  it('reports inconclusive rather than damning when there are no transfers', async () => {
    // On an unverified contract, no ERC-20 transfers may mean it is not a
    // token at all. We cannot tell from here, so we do not claim to.
    const r = await holderConcentration.run(held(0, 0));
    expect(r.fired).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('does not apply to something that is not a token', async () => {
    const r = await holderConcentration.run(context({ holders: null }));
    expect(r.fired).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('does not fire when the sample spans seconds rather than days', async () => {
    // USDC on Polygon. Fifteen addresses across a hundred transfers, which on
    // Ethereum would be damning and here is just one busy minute on a chain
    // producing blocks thirty times faster. It scored HIGH 66 before this.
    const r = await holderConcentration.run(held(15, 100, 40));
    expect(r.fired).toBe(false);
    expect(r.evidence.some((e) => /throughput/.test(e.value))).toBe(true);
  });

  it('still fires on a closed set when those transfers took months', async () => {
    // The same fifteen addresses, spread over a hundred days. Nothing about
    // the throughput excuses this one.
    expect((await holderConcentration.run(held(15, 100, 8_640_000))).fired).toBe(true);
  });

  it('does not let a small sample hide behind a short span', async () => {
    // Thirteen transfers in a minute is not evidence of heavy throughput, so
    // the guard must not apply.
    expect((await holderConcentration.run(held(6, 13, 60))).fired).toBe(true);
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
        lastDeployedAt: now() - firstSeenDaysAgo * DAY,
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
