/**
 * The orchestrator. Composes the ported 2024 analysis, the 2026 signal set and
 * the deterministic score into one verdict, then persists it.
 *
 * Everything that talks to Preflight goes through here: the MCP server today,
 * the Ledger gate on Thursday, the console on Saturday. There is exactly one
 * definition of what a verdict is.
 */
import { randomUUID } from 'node:crypto';
import { analyse, fetchDeployerProfile } from '@preflight/analysis';
import { score, type Verdict } from '@preflight/core';
import {
  ALL_SIGNALS,
  queryMarket,
  runSignals,
  type Signal,
  type SignalContext,
} from '@preflight/signals';
import { scanFields, type Field } from '@preflight/quarantine';
import { createStore, type VerdictStore } from './store.js';

export { createStore } from './store.js';
export type { VerdictStore } from './store.js';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface PreflightOptions {
  store?: VerdictStore;
  /** Override the signal set. Defaults to everything currently wired. */
  signals?: Signal[];
}

/**
 * Below this fraction of the signal set running, the verdict is a statement
 * about our connectivity rather than about the address, and it says so.
 */
export const MIN_COVERAGE = 0.6;

/** Deterministic. Written from the signals that fired, never from model output. */
function summarise(v: { severity: string; score: number; signals: Verdict['signals'] }): string {
  const fired = v.signals.filter((s) => s.fired);
  const failed = v.signals.filter((s) => s.error);
  const ran = v.signals.length - failed.length;
  const head = `${v.severity.toUpperCase()} (${v.score}/100)`;

  const tail = failed.length
    ? `; ${failed.length} of ${v.signals.length} signals could not run`
    : '';

  if (ran / v.signals.length < MIN_COVERAGE) {
    return (
      `INCONCLUSIVE. Only ${ran} of ${v.signals.length} checks completed, so this is not ` +
      `a finding about the address. Treat the risk as unknown, not absent${tail.replace('; ', '. ')}.`
    );
  }

  if (fired.length === 0) return `${head}. No risk signals fired${tail}.`;
  const names = fired.map((s) => s.name).join(', ');
  return `${head}. ${fired.length} of ${v.signals.length} signals fired: ${names}${tail}.`;
}

export async function runPreflight(
  address: string,
  chainId = 1,
  opts: PreflightOptions = {},
): Promise<Verdict> {
  if (!ADDRESS.test(address)) {
    throw new Error(`not a contract address: ${address}`);
  }
  const normalised = address.toLowerCase();

  // Two independent sources, fetched together. The context is assembled once
  // and shared, so adding signals costs no extra network calls.
  const [analysis, market] = await Promise.all([
    analyse(normalised, chainId),
    queryMarket(normalised, chainId),
  ]);

  // Depends on the creator, so it cannot join the batch above. Skipped
  // entirely for wallets and for anything whose creation record we could not
  // read, in which case the signal reports why rather than guessing.
  const deployer = analysis.creator
    ? await fetchDeployerProfile(analysis.creator, chainId)
    : null;

  const ctx: SignalContext = { address: normalised, chainId, analysis, market, deployer };
  const signals = await runSignals(opts.signals ?? ALL_SIGNALS, ctx);
  const { score: value, severity } = score(signals);

  // Ingress boundary. Every string below was written by the party under
  // review and is on its way into an agent's context window. Scanning here
  // rather than at render time means the finding travels with the verdict.
  const marketFields: Field[] =
    ctx.market.status === 'ok'
      ? [
          { path: 'market.symbol', value: ctx.market.market.symbol },
          { path: 'market.name', value: ctx.market.market.name },
          ...ctx.market.market.pools.flatMap((p, i) => [
            { path: `market.pools[${i}].token0.symbol`, value: p.token0.symbol },
            { path: `market.pools[${i}].token1.symbol`, value: p.token1.symbol },
          ]),
        ]
      : [];

  const taint = [
    ...scanFields(
      [
        { path: 'analysis.contractName', value: analysis.contractName },
        { path: 'analysis.ownerOnlyFunctions', value: analysis.ownerOnlyFunctions },
      ],
      'etherscan',
    ),
    ...scanFields(
      [
        { path: 'analysis.llmSummary', value: analysis.llmSummary },
        { path: 'analysis.llmRiskNotes', value: analysis.llmRiskNotes },
      ],
      'model output',
    ),
    ...scanFields(marketFields, 'thegraph:uniswap-v3'),
  ];

  const verdict: Verdict = {
    id: randomUUID().slice(0, 8),
    address: normalised,
    chainId,
    severity,
    score: value,
    summary: summarise({ severity, score: value, signals }),
    analysis,
    signals,
    coverage: { ran: signals.length - signals.filter((s) => s.error).length, total: signals.length },
    taint,
    createdAt: new Date().toISOString(),
  };

  const store = opts.store ?? (await createStore());
  try {
    await store.save(verdict);
  } catch (err) {
    // A storage failure must not cost the caller their answer.
    process.stderr.write(
      `[engine] verdict ${verdict.id} not persisted: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return verdict;
}
