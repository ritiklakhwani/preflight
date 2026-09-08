import type { SignalResult } from '@preflight/core';
import type { Signal, SignalContext } from './types.js';

/**
 * Runs every signal against one shared context.
 *
 * A signal that throws is recorded and excluded from the score denominator by
 * `score()`. It must never fail the verdict: an agent waiting to sign needs an
 * answer about the signals that did work, not an exception.
 */
export async function runSignals(signals: Signal[], ctx: SignalContext): Promise<SignalResult[]> {
  const settled = await Promise.allSettled(signals.map((s) => s.run(ctx)));

  return signals.map((s, i) => {
    const outcome = settled[i];
    if (!outcome || outcome.status === 'rejected') {
      const reason = outcome && 'reason' in outcome ? outcome.reason : new Error('signal did not run');
      return {
        name: s.name,
        weight: s.weight,
        fired: false,
        evidence: [],
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
    return { name: s.name, weight: s.weight, ...outcome.value };
  });
}
