import type { AnalysisResult, SignalResult } from '@preflight/core';

/**
 * Everything a signal is allowed to look at. Signals never fetch on their own -
 * the context is assembled once and shared, so one address costs one round of
 * network calls no matter how many signals run.
 *
 * `pools` lands here on Day 3 when the Graph-backed signals arrive.
 */
export interface SignalContext {
  address: string;
  chainId: number;
  analysis: AnalysisResult;
}

export interface Signal {
  name: string;
  /** 0-1. Contribution to the score when fired. Set by hand, documented per signal. */
  weight: number;
  /** One sentence, shown to the agent. Explains what firing means, not how it works. */
  describe: string;
  run(ctx: SignalContext): Promise<Omit<SignalResult, 'name' | 'weight'>>;
}
