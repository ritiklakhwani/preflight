/**
 * The orchestrator. Composes the ported 2024 analysis, the 2026 signal set and
 * the deterministic score into one verdict, then persists it.
 *
 * Everything that talks to Preflight goes through here: the MCP server today,
 * the Ledger gate on Thursday, the console on Saturday. There is exactly one
 * definition of what a verdict is.
 */
import { randomUUID } from 'node:crypto';
import { analyse } from '@preflight/analysis';
import { score, type Verdict } from '@preflight/core';
import { STRUCTURAL_SIGNALS, runSignals, type Signal, type SignalContext } from '@preflight/signals';
import { createStore, type VerdictStore } from './store.js';

export { createStore } from './store.js';
export type { VerdictStore } from './store.js';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export interface PreflightOptions {
  store?: VerdictStore;
  /** Override the signal set. Defaults to everything currently wired. */
  signals?: Signal[];
}

/** Deterministic. Written from the signals that fired, never from model output. */
function summarise(v: { severity: string; score: number; signals: Verdict['signals'] }): string {
  const fired = v.signals.filter((s) => s.fired);
  const failed = v.signals.filter((s) => s.error);
  const head = `${v.severity.toUpperCase()} (${v.score}/100)`;

  if (fired.length === 0) {
    const tail = failed.length ? `; ${failed.length} signal(s) could not run` : '';
    return `${head}. No risk signals fired${tail}.`;
  }
  const names = fired.map((s) => s.name).join(', ');
  const tail = failed.length ? `; ${failed.length} signal(s) could not run` : '';
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

  const analysis = await analyse(normalised, chainId);
  const ctx: SignalContext = { address: normalised, chainId, analysis };
  const signals = await runSignals(opts.signals ?? STRUCTURAL_SIGNALS, ctx);
  const { score: value, severity } = score(signals);

  const verdict: Verdict = {
    id: randomUUID().slice(0, 8),
    address: normalised,
    chainId,
    severity,
    score: value,
    summary: summarise({ severity, score: value, signals }),
    analysis,
    signals,
    // Populated by @preflight/quarantine on Day 5.
    taint: [],
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
