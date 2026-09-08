/**
 * NEW during ETHOnline 2026.
 *
 * Where the project's actual claim lives: that what a contract has done
 * predicts a rug better than what its source code says. These read Uniswap V3
 * pool state through The Graph and the explorer's creation record. None of
 * them look at source.
 *
 * Every threshold below was calibrated against real addresses, and the
 * measurements are recorded next to the constant they justify. Two of them
 * exist specifically to stop a false positive that the obvious version of the
 * signal would have produced.
 */
import type { Evidence } from '@preflight/core';
import type { Signal, SignalContext } from './types.js';
import type { Pool } from './graph.js';

const DAY = 86_400;

const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const daysOld = (ts: number) => (Date.now() / 1000 - ts) / DAY;

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  42161: 'https://arbiscan.io',
  8453: 'https://basescan.org',
};

function poolLink(ctx: SignalContext, poolId: string): string | undefined {
  const base = EXPLORERS[ctx.chainId];
  return base ? `${base}/address/${poolId}` : undefined;
}

/**
 * Market signals share three non-findings, and each has to be handled
 * differently or the verdict lies.
 *
 * A gateway failure is an `error`: the signal drops out of the score entirely
 * so the verdict degrades to what we could measure, rather than claiming the
 * token has no market.
 *
 * An unsupported chain is also an `error`, for the same reason.
 *
 * A non-token contract is neither. Asking whether a lending pool has a Uniswap
 * market is a category mistake, so the signal reports `fired: false` and keeps
 * its weight, which lowers the score rather than inflating it.
 */
type Guard = { skip: Omit<import('@preflight/core').SignalResult, 'name' | 'weight'> } | { pools: Pool[]; ctx: SignalContext };

function guardMarket(ctx: SignalContext, requireToken = true): Guard {
  if (ctx.market.status === 'unsupported-chain') {
    return {
      skip: {
        fired: false,
        evidence: [],
        error: `no Uniswap V3 subgraph indexed for chain ${ctx.market.chainId}`,
      },
    };
  }
  if (ctx.market.status === 'error') {
    return { skip: { fired: false, evidence: [], error: `The Graph: ${ctx.market.error}` } };
  }
  if (requireToken && ctx.analysis.verified && !ctx.analysis.isErc20) {
    return {
      skip: {
        fired: false,
        evidence: [
          {
            label: 'market',
            value: 'not an ERC-20, so pool liquidity is not a meaningful question here',
          },
        ],
      },
    };
  }
  return { pools: ctx.market.market.pools, ctx };
}

// ---------------------------------------------------------------------------

export const notAContract: Signal = {
  name: 'not-a-contract',
  weight: 0.35,
  describe:
    'The address has no contract creation record, so it is a wallet. Approving or sending to it does not do what calling a contract would.',
  async run(ctx) {
    const { isContract } = ctx.analysis;
    if (isContract === null) {
      return { fired: false, evidence: [], error: 'creation record could not be read' };
    }
    if (isContract) {
      return {
        fired: false,
        evidence: [
          {
            label: 'deployed by',
            value: ctx.analysis.creator ?? 'unknown',
            untrusted: true,
          },
        ],
      };
    }
    return {
      fired: true,
      evidence: [
        {
          label: 'address type',
          value: 'externally owned account, not a contract; the explorer has no creation record',
        },
      ],
    };
  },
};

export const noMarket: Signal = {
  name: 'no-market',
  weight: 0.3,
  describe:
    'No Uniswap V3 pool holds this token on this chain, so there is nothing here to swap against.',
  async run(ctx) {
    // A wallet has no market by definition. Saying so adds nothing.
    if (ctx.analysis.isContract === false) {
      return {
        fired: false,
        evidence: [{ label: 'market', value: 'not applicable, the address is a wallet' }],
      };
    }
    const g = guardMarket(ctx);
    if ('skip' in g) return g.skip;

    if (g.pools.length > 0) {
      const deepest = g.pools[0]!;
      return {
        fired: false,
        evidence: [
          {
            label: 'market',
            value: `${g.pools.length} Uniswap V3 pool(s), deepest holds ${usd(deepest.totalValueLockedUSD)}`,
            link: poolLink(ctx, deepest.id),
          },
        ],
      };
    }
    return {
      fired: true,
      evidence: [
        {
          label: 'market',
          value: `no Uniswap V3 pool on chain ${ctx.chainId}; a swap against this address has no route here`,
        },
      ],
    };
  },
};

/**
 * Pools younger than this are treated as unproven rather than suspicious in
 * `liquidity-reality`, and are this signal's whole subject. Two days is long
 * enough that a legitimate launch has usually seen real trades and short
 * enough to still be inside the window a rug operates in.
 */
const YOUNG_POOL_DAYS = 2;

export const poolAge: Signal = {
  name: 'pool-age',
  weight: 0.5,
  describe:
    'The deepest pool holding this token was created within the last two days, so it has no track record.',
  async run(ctx) {
    const g = guardMarket(ctx);
    if ('skip' in g) return g.skip;
    const deepest = g.pools[0];
    if (!deepest) {
      return {
        fired: false,
        evidence: [{ label: 'pool age', value: 'no pool to date; see no-market' }],
      };
    }

    const age = daysOld(deepest.createdAtTimestamp);
    const evidence: Evidence[] = [
      {
        label: 'deepest pool',
        value: `${deepest.token0.symbol}/${deepest.token1.symbol}, created ${age.toFixed(1)} days ago, holds ${usd(deepest.totalValueLockedUSD)}`,
        link: poolLink(ctx, deepest.id),
        untrusted: true,
      },
    ];
    return { fired: age < YOUNG_POOL_DAYS, evidence };
  },
};

/**
 * Thresholds for liquidity-reality, each measured rather than guessed.
 *
 * DORMANT_MIN_TVL / DORMANT_MAX_TX: five figures locked and almost nobody has
 * ever traded against it. Measured transaction counts on the deepest pool:
 *
 *   ease.org / ez-cvxsteCRV   $1.11T locked          4 transactions
 *   WBTC / USDC on Arbitrum   $18.7m locked  8,684,384 transactions
 *   USDC / WETH on Ethereum   $414m locked  12,071,203 transactions
 *
 * DORMANT_MIN_AGE_DAYS exists because a pool created yesterday having few
 * trades is normal. That case belongs to pool-age, not here.
 *
 * The obvious version of this signal used volume rather than transaction
 * count, and it was wrong twice over. A high volume-to-TVL ratio is what a
 * healthy market looks like: USDC/WETH runs at 1459. And the subgraph only
 * tracks volume for whitelisted pairs, so WBTC/USDC on Arbitrum reports $0
 * volume against 8.6 million real transactions. Transaction count separates
 * those cleanly where volume does not.
 */
const DORMANT_MIN_TVL = 10_000;
const DORMANT_MAX_TX = 25;
const DORMANT_MIN_AGE_DAYS = 7;

/** Below this, a position of any size cannot be exited at a sane price. */
const EXIT_FLOOR_TVL = 5_000;

export const liquidityReality: Signal = {
  name: 'liquidity-reality',
  weight: 0.85,
  describe:
    'The pool backing this token does not hold what it appears to. Either the locked value has sat untraded, or there is too little of it to exit a position against.',
  async run(ctx) {
    const g = guardMarket(ctx);
    if ('skip' in g) return g.skip;
    const deepest = g.pools[0];
    if (!deepest) {
      return {
        fired: false,
        evidence: [{ label: 'liquidity', value: 'no pool to assess; see no-market' }],
      };
    }

    const tvl = deepest.totalValueLockedUSD;
    const age = daysOld(deepest.createdAtTimestamp);
    const perTx = deepest.txCount > 0 ? tvl / deepest.txCount : tvl;

    const dormant =
      tvl >= DORMANT_MIN_TVL && age >= DORMANT_MIN_AGE_DAYS && deepest.txCount < DORMANT_MAX_TX;
    const unexitable = tvl > 0 && tvl < EXIT_FLOOR_TVL;

    if (dormant) {
      return {
        fired: true,
        evidence: [
          {
            label: 'dormant capital',
            value: `${usd(tvl)} locked across only ${deepest.txCount} transaction(s) in ${age.toFixed(0)} days, ${usd(perTx)} per transaction`,
            link: poolLink(ctx, deepest.id),
          },
          {
            label: 'reading',
            value:
              'value this large that nothing has traded against is reported liquidity, not usable liquidity',
          },
        ],
      };
    }

    if (unexitable) {
      return {
        fired: true,
        evidence: [
          {
            label: 'thin liquidity',
            value: `deepest pool holds ${usd(tvl)}, below the floor at which a position can be exited`,
            link: poolLink(ctx, deepest.id),
          },
        ],
      };
    }

    return {
      fired: false,
      evidence: [
        {
          label: 'liquidity',
          value: `${usd(tvl)} locked, ${deepest.txCount.toLocaleString('en-US')} transactions, ${usd(perTx)} per transaction`,
          link: poolLink(ctx, deepest.id),
        },
      ],
    };
  },
};



/**
 * Thresholds for deployer-history.
 *
 * The pattern being matched is a factory: an address that did not exist last
 * month and has already shipped several contracts. Neither half means much
 * alone. Plenty of honest projects deploy from a fresh address, and plenty of
 * prolific deployers are infrastructure teams years into their history. The
 * conjunction is what is rare and what precedes a rug.
 */
const NEW_DEPLOYER_DAYS = 30;
const PROLIFIC_DEPLOYMENTS = 3;

export const deployerHistory: Signal = {
  name: 'deployer-history',
  weight: 0.6,
  describe:
    'The address that deployed this contract is itself new and has already shipped several other contracts, which is the shape of a factory rather than a project.',
  async run(ctx) {
    if (ctx.analysis.isContract === false) {
      return {
        fired: false,
        evidence: [{ label: 'deployer', value: 'not applicable, the address is a wallet' }],
      };
    }
    if (!ctx.deployer) {
      return { fired: false, evidence: [], error: 'no creator on record for this address' };
    }
    if (ctx.deployer.status === 'error') {
      return { fired: false, evidence: [], error: `deployer history: ${ctx.deployer.error}` };
    }

    const { firstSeen, deployments, sampled, truncated } = ctx.deployer;
    const age = firstSeen > 0 ? daysOld(firstSeen) : Number.POSITIVE_INFINITY;
    const window = truncated ? `last ${sampled} transactions` : 'entire history';

    const evidence: Evidence[] = [
      {
        label: 'deployer',
        value: `${ctx.analysis.creator ?? 'unknown'}, first seen ${
          Number.isFinite(age) ? age.toFixed(0) + ' days ago' : 'unknown'
        }, ${deployments} contract deployment(s) in its ${window}`,
        link: EXPLORERS[ctx.chainId]
          ? `${EXPLORERS[ctx.chainId]}/address/${ctx.analysis.creator}`
          : undefined,
        untrusted: true,
      },
    ];

    const fired = age < NEW_DEPLOYER_DAYS && deployments >= PROLIFIC_DEPLOYMENTS;
    if (fired) {
      evidence.push({
        label: 'reading',
        value: `an address under ${NEW_DEPLOYER_DAYS} days old that has already deployed ${deployments} contracts is producing them at volume, not building one`,
      });
    }
    return { fired, evidence };
  },
};

export const BEHAVIOURAL_SIGNALS: Signal[] = [
  notAContract,
  deployerHistory,
  noMarket,
  poolAge,
  liquidityReality,
];
