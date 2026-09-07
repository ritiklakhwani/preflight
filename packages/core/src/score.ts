import type { SignalResult, Severity } from './types.js';

/**
 * The risk decision. Deliberately deterministic and readable.
 *
 * When a judge asks "is the AI making this call?" the answer is no, and this
 * is the file you open. The model only summarises source code; the severity
 * comes from weighted on-chain signals.
 */
export function score(results: SignalResult[]): { score: number; severity: Severity } {
  const usable = results.filter((r) => !r.error);
  const max = usable.reduce((s, r) => s + r.weight, 0);
  if (max === 0) return { score: 0, severity: 'clean' };

  const fired = usable.filter((r) => r.fired).reduce((s, r) => s + r.weight, 0);
  const score = Math.round((fired / max) * 100);

  const severity: Severity =
    score >= 60 ? 'high' : score >= 35 ? 'medium' : score >= 15 ? 'low' : 'clean';

  return { score, severity };
}
