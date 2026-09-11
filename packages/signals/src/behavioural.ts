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
 *
 * A dormant pool also has to be read against who holds the token, because the
 * same pool shape means two different things. sUSDat is a staking wrapper: you
 * acquire it by staking, not by swapping, so its pool sits untraded while
 * 1,259 people hold it. That is an unused venue. ease.org has six addresses
 * across its last thirteen transfers, and that is fabricated value. Both show
 * eight-figure sums and single-digit trades.
 *
 *   ease.org   6 unique addresses per 13 transfers   fires
 *   sUSDat    45 unique per 100                      does not
 */
const DORMANT_MIN_TVL = 10_000;
const DORMANT_MAX_TX = 25;
const DORMANT_MIN_AGE_DAYS = 7;

export const liquidityReality: Signal = {
  name: 'liquidity-reality',
  weight: 0.85,
  describe:
    'Value is locked in this token\'s deepest pool that almost nothing has ever traded against, so the liquidity is reported rather than usable.',
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

    // A widely held token with a quiet pool is a venue nobody uses, not value
    // that was never real.
    const widelyHeld =
      ctx.holders?.status === 'ok' && ctx.holders.uniqueAddresses >= MIN_UNIQUE_ADDRESSES;

    const dormant =
      tvl >= DORMANT_MIN_TVL &&
      age >= DORMANT_MIN_AGE_DAYS &&
      deepest.txCount < DORMANT_MAX_TX &&
      !widelyHeld;

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

    const evidence: Evidence[] = [
      {
        label: 'liquidity',
        value: `${usd(tvl)} locked, ${deepest.txCount.toLocaleString('en-US')} transactions, ${usd(perTx)} per transaction`,
        link: poolLink(ctx, deepest.id),
      },
    ];
    if (widelyHeld && deepest.txCount < DORMANT_MAX_TX) {
      evidence.push({
        label: 'reading',
        value:
          'the pool is quiet but the token is widely held, so this venue is unused rather than the value being unreal',
      });
    }
    return { fired: false, evidence };
  },
};

/** Below this, a position of any size cannot be exited at a sane price. */
const EXIT_FLOOR_TVL = 5_000;

/**
 * Split out of liquidity-reality, at a much lower weight, because it was
 * producing the worst kind of false positive.
 *
 * Thin liquidity says nothing about whether a token is a fraud. It says a
 * swap routed here will be destroyed by slippage. Those are different claims
 * and only the second one is supportable from this data.
 *
 * FDUSD is the case that forced this. A real stablecoin, 4,252 holders,
 * $220m market cap, whose deepest Uniswap V3 pool on Ethereum holds $1,092
 * because its market lives on other venues. It scored HIGH 90, above an
 * unverified three-holder token deployed two days earlier. sUSDat, $74m and
 * 1,259 holders, scored the same.
 *
 * At 0.3 the honest statement survives at the honest severity: report it to
 * the user, do not stop the agent.
 */
export const thinLiquidity: Signal = {
  name: 'thin-liquidity',
  weight: 0.3,
  describe:
    'The deepest pool holding this token is too small to swap against without severe slippage. A statement about this venue, not about the token.',
  async run(ctx) {
    const g = guardMarket(ctx);
    if ('skip' in g) return g.skip;
    const deepest = g.pools[0];
    if (!deepest) {
      return { fired: false, evidence: [{ label: 'depth', value: 'no pool; see no-market' }] };
    }

    const tvl = deepest.totalValueLockedUSD;
    if (tvl > 0 && tvl < EXIT_FLOOR_TVL) {
      return {
        fired: true,
        evidence: [
          {
            label: 'depth',
            value: `deepest pool holds ${usd(tvl)} across ${deepest.txCount.toLocaleString('en-US')} transactions; a position of any size cannot be exited here`,
            link: poolLink(ctx, deepest.id),
          },
          {
            label: 'reading',
            value:
              'the token may trade elsewhere. This is a routing problem, not evidence of fraud',
          },
        ],
      };
    }
    return {
      fired: false,
      evidence: [{ label: 'depth', value: `${usd(tvl)} in the deepest pool`, link: poolLink(ctx, deepest.id) }],
    };
  },
};

/**
 * Below this many distinct addresses, the token is not distributed, whatever
 * its transfer count says.
 *
 * Confirmed by hand on 2026-09-09 against tokens whose character was checked
 * on the explorer. Unique addresses across the last 100 transfers:
 *
 *   FDUSD   57   real, 4,252 holders
 *   sUSDat  45   real, 1,259 holders
 *   ONJAI   11   dead, 9 holders
 *   MEX      8   dead, 14 holders
 *   DOTT     7   throwaway, 3 holders
 *
 * The gap between 11 and 45 has nothing in it, so the threshold sits in the
 * middle of a wide empty band rather than being tuned to a boundary.
 */
const MIN_UNIQUE_ADDRESSES = 20;

/**
 * Below this many seconds, a hundred transfers is not a sample of who holds the
 * token. It is a snapshot of one busy moment.
 *
 * Found by running USDC on Polygon, which scored HIGH 66 while the same token
 * on Ethereum scored LOW 32. The threshold above was calibrated entirely on
 * Ethereum, where a hundred transfers of a real token span hours. Polygon
 * produces blocks roughly thirty times faster, so the same hundred transfers
 * span seconds and are dominated by a handful of routers and MEV bots. A
 * legitimate token looked exactly like a closed circle.
 *
 * Throughput this high is positive evidence of an active market, which is the
 * direct contradiction of what this signal claims, so the honest move is to
 * report the sample as unrepresentative rather than to fire on it.
 *
 * The residual gap, stated rather than hidden: a wash-trading bot cycling a
 * hundred transfers between a few addresses inside an hour is excused by this
 * guard. On a chain we index, `liquidity-reality`, `thin-liquidity` and
 * `pool-age` all still see that token. On a chain we do not index, it is a
 * miss, and closing it needs the total holder count rather than a sample.
 */
const ACTIVE_SAMPLE_SPAN_SECONDS = 3_600;

/** Sample sizes below this are too small for the span to mean anything. */
const SPAN_MIN_SAMPLE = 50;

function describeSpan(seconds: number): string {
  if (seconds <= 0) return 'all within one block';
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)}min`;
  if (seconds < 172_800) return `${(seconds / 3_600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

export const holderConcentration: Signal = {
  name: 'holder-concentration',
  weight: 0.5,
  describe:
    'Almost nobody holds this token. Its transfers circulate among a handful of addresses, which is how volume gets manufactured without anyone buying.',
  async run(ctx) {
    if (!ctx.holders) {
      return {
        fired: false,
        evidence: [{ label: 'distribution', value: 'not applicable, the address is not a token' }],
      };
    }
    if (ctx.holders.status === 'error') {
      return { fired: false, evidence: [], error: `holder history: ${ctx.holders.error}` };
    }

    const { sampled, uniqueAddresses, spanSeconds } = ctx.holders;
    if (sampled === 0) {
      // No ERC-20 transfers at all. On a verified token that means nobody
      // holds it; on an unverified contract it may simply not be a token.
      // Either way we cannot tell from here, so we do not claim to.
      return {
        fired: false,
        evidence: [],
        error: 'no token transfers on record, so distribution could not be assessed',
      };
    }

    const evidence: Evidence[] = [
      {
        label: 'distribution',
        value:
          `${uniqueAddresses} distinct addresses across the last ${sampled} transfers, ` +
          `spanning ${describeSpan(spanSeconds)}`,
      },
    ];

    // A fast sample is a statement about throughput, not about distribution.
    if (
      uniqueAddresses < MIN_UNIQUE_ADDRESSES &&
      sampled >= SPAN_MIN_SAMPLE &&
      spanSeconds > 0 &&
      spanSeconds < ACTIVE_SAMPLE_SPAN_SECONDS
    ) {
      evidence.push({
        label: 'reading',
        value:
          `${sampled} transfers in ${describeSpan(spanSeconds)} is heavy throughput, so this ` +
          'sample shows the busiest addresses rather than the holder base. Not enough to judge ' +
          'distribution either way',
      });
      return { fired: false, evidence };
    }

    if (uniqueAddresses < MIN_UNIQUE_ADDRESSES) {
      evidence.push({
        label: 'reading',
        value:
          sampled >= 50
            ? 'transfers circulating among a closed set, which manufactures volume without buyers'
            : 'too few holders for a market to exist',
      });
      return { fired: true, evidence };
    }
    return { fired: false, evidence };
  },
};

/**
 * Thresholds for deployer-history.
 *
 * The pattern being matched is a factory: an address that did not exist last
 * month and has already shipped several contracts. Neither half means much
 * alone, and the count least of all. Measured:
 *
 *   ease.org deployer   38 contracts, 8 of them flagged elsewhere as honeypots
 *   DAI deployer       165 contracts, MakerDAO
 *
 * Volume does not separate those, so the signal fires on the conjunction with
 * recency and reports the raw count either way. What it cannot do is recognise
 * an established serial scammer: an address five years old that shipped its
 * honeypots in 2021 looks exactly like an address five years old that shipped
 * infrastructure in 2021. Telling those apart needs a labelled database of bad
 * contracts, which is a different product. The limit is stated here rather than
 * papered over, because the signal's name promises more than it delivers.
 */
const NEW_DEPLOYER_DAYS = 30;
const PROLIFIC_DEPLOYMENTS = 3;

export const deployerHistory: Signal = {
  name: 'deployer-history',
  // 0.55 rather than 0.6 deliberately. At 0.6 this signal alone lands exactly
  // on the HIGH boundary, so a new-ish address with three contracts would stop
  // an agent and demand a hardware press on its own. It has also never fired
  // in the benchmark, so we have no measurement of its false-positive rate. A
  // signal with no observed behaviour should not sit on a threshold.
  weight: 0.55,
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

    const { firstSeen, deployments, sampled, truncated, lastDeployedAt } = ctx.deployer;
    const age = firstSeen > 0 ? daysOld(firstSeen) : Number.POSITIVE_INFINITY;
    const window = truncated ? `first ${sampled} transactions` : 'entire history';
    const lastDeploy =
      lastDeployedAt && lastDeployedAt > 0
        ? `, most recent ${daysOld(lastDeployedAt).toFixed(0)} days ago`
        : '';

    const evidence: Evidence[] = [
      {
        label: 'deployer',
        value: `${ctx.analysis.creator ?? 'unknown'}, first seen ${
          Number.isFinite(age) ? age.toFixed(0) + ' days ago' : 'unknown'
        }, ${deployments} contract deployment(s) in its ${window}${lastDeploy}`,
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
  holderConcentration,
  noMarket,
  poolAge,
  thinLiquidity,
  liquidityReality,
];
