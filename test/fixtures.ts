/**
 * Shared test fixtures.
 *
 * These exist so that adding a field to AnalysisResult or SignalContext does
 * not require editing every test file that happens to need one. Each builder
 * returns a plausible default and accepts an override.
 */
import type { AnalysisResult, Verdict } from '@preflight/core';
import type { MarketResult, SignalContext, TokenMarket } from '@preflight/signals';

export function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    verified: true,
    contractName: 'Token',
    compilerVersion: 'v0.8.0',
    isProxy: false,
    implementationAddress: null,
    isErc20: true,
    isContract: true,
    creator: '0x00000000000000000000000000000000000000c0',
    ownerOnlyFunctions: [],
    hasSelfDestruct: false,
    hasTransferRestrictions: false,
    llmSummary: '',
    llmRiskLabel: 'Unknown',
    llmRiskNotes: [],
    ...over,
  };
}

export function market(over: Partial<TokenMarket> = {}): MarketResult {
  return {
    status: 'ok',
    market: {
      chainId: 1,
      subgraphId: 'test',
      known: true,
      symbol: 'TKN',
      name: 'Token',
      txCount: 1_000,
      volumeUSD: 1_000_000,
      totalValueLockedUSD: 100_000,
      pools: [],
      queriedAt: '2026-09-09T00:00:00.000Z',
      ...over,
    },
  };
}

export function context(over: Partial<SignalContext> = {}): SignalContext {
  return {
    address: '0x0000000000000000000000000000000000000001',
    chainId: 1,
    analysis: analysis(),
    market: market(),
    deployer: { status: 'ok', firstSeen: 1_600_000_000, deployments: 1, sampled: 12, truncated: false },
    holders: { status: 'ok', sampled: 100, uniqueAddresses: 60 },
    ...over,
  };
}

export function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: 'abcd1234',
    address: '0x0000000000000000000000000000000000000001',
    chainId: 1,
    severity: 'low',
    score: 20,
    summary: 'LOW (20/100).',
    analysis: analysis(),
    signals: [],
    coverage: { ran: 9, total: 9 },
    taint: [],
    createdAt: '2026-09-09T00:00:00.000Z',
    ...over,
  };
}
