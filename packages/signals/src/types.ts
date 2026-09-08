import type { AnalysisResult, SignalResult } from '@preflight/core';
import type { DeployerResult } from '@preflight/analysis';
import type { MarketResult } from './graph.js';

/**
 * Everything a signal is allowed to look at. Signals never fetch on their own -
 * the context is assembled once and shared, so one address costs one round of
 * network calls no matter how many signals run.
 *
 * `market` carries a status rather than a value because a signal must be able
 * to tell "this token has no pool" apart from "we could not reach The Graph".
 */
export interface SignalContext {
  address: string;
  chainId: number;
  /** Etherscan source, ABI and the advisory model read. Ported from 2024. */
  analysis: AnalysisResult;
  /** Uniswap V3 pool state via The Graph. */
  market: MarketResult;
  /**
   * The deploying address's own history. Null when the contract has no known
   * creator, which is either a wallet or an explorer we could not reach.
   */
  deployer: DeployerResult | null;
}

export interface Signal {
  name: string;
  /** 0-1. Contribution to the score when fired. Set by hand, documented per signal. */
  weight: number;
  /** One sentence, shown to the agent. Explains what firing means, not how it works. */
  describe: string;
  run(ctx: SignalContext): Promise<Omit<SignalResult, 'name' | 'weight'>>;
}
