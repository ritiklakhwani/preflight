/**
 * The orchestrator. Composes the ported 2024 analysis, the 2026 signal set and
 * the deterministic score into one verdict, then persists it.
 *
 * Everything that talks to Preflight goes through here: the MCP server today,
 * the Ledger gate on Thursday, the console on Saturday. There is exactly one
 * definition of what a verdict is.
 */
import { randomUUID } from 'node:crypto';
import { analyse, fetchDeployerProfile, fetchHolderDiversity } from '@preflight/analysis';
import { score, type Verdict } from '@preflight/core';
import {
  ALL_SIGNALS,
  queryMarket,
  runSignals,
  type Signal,
  type SignalContext,
} from '@preflight/signals';
import { runGate } from '@preflight/gate';
import { LENGTH_BUDGET, scanFields, type Field } from '@preflight/quarantine';
import { createStore, type VerdictStore } from './store.js';

export { createStore } from './store.js';
export type { VerdictStore } from './store.js';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface PreflightOptions {
  store?: VerdictStore;
  /** Override the signal set. Defaults to everything currently wired. */
  signals?: Signal[];
  /**
   * Ask for hardware confirmation when the verdict is high.
   *
   * Explicit rather than defaulted on, because a confirmation blocks for up to
   * a minute waiting for a person, and the benchmark alone would sit through
   * eight of those. The MCP server, which is the product surface, always
   * passes true. Dev tooling does not.
   */
  gate?: boolean;
}

/**
 * Below this fraction of the signal set running, the verdict is a statement
 * about our connectivity rather than about the address, and it says so.
 */
export const MIN_COVERAGE = 0.6;

/**
 * The MCP SDK gives a tool call sixty seconds by default, and that is the real
 * constraint on everything below.
 *
 * Analysis is bounded but not fixed: it depends on Etherscan, The Graph and a
 * model, measured at seven to nine seconds together and capable of much worse.
 * The gate then blocks on a person. Adding a fixed forty-second wait to a
 * variable analysis is how we shipped a call that could exceed the caller's
 * limit, and when it did the agent got a transport timeout rather than a
 * refusal. A timeout is not an answer. A refusal is.
 *
 * So the gate is given whatever is left rather than a constant, and the
 * response always arrives before the caller stops listening.
 */
const CLIENT_REQUEST_BUDGET_MS = 60_000;

/** Rendering, persistence and transport, after the gate returns. */
const RESPONSE_MARGIN_MS = 6_000;

/**
 * Below this there is no point asking a human. Nobody reaches a device and
 * presses in four seconds, so the honest move is to refuse now and say the
 * budget was already spent, rather than open a window that cannot be met.
 */
const MIN_USEFUL_GATE_MS = 5_000;

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
  const startedAt = Date.now();

  // Two independent sources, fetched together. The context is assembled once
  // and shared, so adding signals costs no extra network calls.
  const [analysis, market] = await Promise.all([
    analyse(normalised, chainId),
    queryMarket(normalised, chainId),
  ]);

  // Depends on the creator, so it cannot join the batch above. Skipped
  // entirely for wallets and for anything whose creation record we could not
  // read, in which case the signal reports why rather than guessing.
  const [deployer, holders] = await Promise.all([
    analysis.creator ? fetchDeployerProfile(analysis.creator, chainId) : null,
    // Fetch whenever we cannot rule a token out. Requiring isErc20 skipped the
    // check on unverified contracts, since the ABI is what proves the ERC-20
    // surface, and an unverified contract with three holders is exactly the
    // case this signal exists for.
    //
    // A wallet is ruled out, though: it has no token transfers, so the call
    // spends a request to learn nothing and then reports a failed check that
    // reads as a coverage gap.
    analysis.isContract !== false && (analysis.isErc20 || !analysis.verified)
      ? fetchHolderDiversity(normalised, chainId)
      : null,
  ]);

  const ctx: SignalContext = {
    address: normalised,
    chainId,
    analysis,
    market,
    deployer,
    holders,
  };
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
    // Prose budget, not the identifier one. We asked the model for up to
    // sixty words, so flagging a 140-character summary as an attack was the
    // scanner reporting our own output as hostile.
    ...scanFields(
      [
        { path: 'analysis.llmSummary', value: analysis.llmSummary },
        { path: 'analysis.llmRiskNotes', value: analysis.llmRiskNotes },
      ],
      'model output',
      LENGTH_BUDGET.prose,
    ),
    ...scanFields(marketFields, 'thegraph:uniswap-v3'),
  ];

  // Blocks on a human. Runs after scoring because the severity is what decides
  // whether a person is needed at all, and it gets only the time the analysis
  // did not already spend.
  const remaining =
    CLIENT_REQUEST_BUDGET_MS - (Date.now() - startedAt) - RESPONSE_MARGIN_MS;
  const gate = opts.gate
    ? remaining < MIN_USEFUL_GATE_MS
      ? {
          required: severity === 'high',
          approved: severity !== 'high',
          method: 'auto' as const,
          ...(severity === 'high'
            ? {
                reason:
                  `analysis used ${Math.round((Date.now() - startedAt) / 1000)}s of the ` +
                  `60s request budget, leaving no room to wait for a device. Nobody ` +
                  `approved this. Retry when the network is quicker`,
              }
            : {}),
        }
      : await runGate(severity, { budgetMs: remaining })
    : undefined;

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
    ...(gate ? { gate } : {}),
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
