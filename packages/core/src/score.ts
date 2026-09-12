import type { SignalResult, Severity } from './types.js';

/**
 * The risk decision. Deliberately deterministic and readable.
 *
 * When a judge asks "is the AI making this call?" the answer is no, and this
 * is the file you open. The model only summarises source code; the severity
 * comes from weighted on-chain signals combined here.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a weighted average
 *
 * The first version divided fired weight by total weight. It produced a
 * defensible-looking number and a wrong answer, because averaging assumes
 * findings dilute each other. They do not. A pool holding $1.1 trillion that
 * four transactions have ever touched is damning on its own, and it does not
 * become less damning because the contract's source happens to be verified and
 * its ABI happens to be ordinary. Under averaging that address scored 18 out
 * of 100 and read as LOW.
 *
 * So each signal is treated as independent evidence, and the score is the
 * probability that at least one of them is a real problem:
 *
 *     score = 1 - product over fired signals of (1 - weight)
 *
 * A weight is therefore a specific claim: given only this signal firing and
 * nothing else known, how likely is it that the caller should not proceed.
 * That makes every weight arguable on its own terms rather than only relative
 * to the others, which is what you want when defending the number.
 *
 * Two consequences worth knowing. Evidence accumulates but never saturates:
 * three weak signals reach further than any one of them and still fall short
 * of one strong one. And a signal that could not run contributes nothing at
 * all, so the verdict degrades to whatever could actually be measured rather
 * than quietly inflating or deflating.
 */
export function score(results: SignalResult[]): { score: number; severity: Severity } {
  const fired = results.filter((r) => !r.error && r.fired);
  if (fired.length === 0) return { score: 0, severity: 'clean' };

  const noneAreReal = fired.reduce((p, r) => p * (1 - clamp(r.weight)), 1);
  const score = Math.round((1 - noneAreReal) * 100);

  const severity: Severity =
    score >= 60 ? 'high' : score >= 35 ? 'medium' : score >= 15 ? 'low' : 'clean';

  return { score, severity };
}

/** A weight outside 0-1 would invert or overflow the product. */
function clamp(w: number): number {
  return Math.min(Math.max(w, 0), 1);
}

/**
 * Below this fraction of the signal set running, a verdict is a statement
 * about our connectivity rather than about the address.
 */
export const MIN_COVERAGE = 0.6;

/**
 * Was enough of the check performed for the answer to mean anything?
 *
 * This lives here, next to the scoring, because it is a property of a verdict
 * and not of any one way of displaying it. Breaking the Key Ring passphrase
 * produced a verdict whose severity was `clean` and whose score was 0, which
 * is arithmetically correct: no signal fired, because eight of eleven could
 * not run. The tool returned an error and the summary said INCONCLUSIVE, and
 * the header still read CLEAN 0/100, and the recent list still showed a clean
 * row for an address nobody had checked.
 *
 * An outage must not be readable as a clean bill of health anywhere, including
 * in the two places a person's eye actually lands.
 */
export function inconclusive(coverage: { ran: number; total: number }): boolean {
  return coverage.total > 0 && coverage.ran / coverage.total < MIN_COVERAGE;
}
