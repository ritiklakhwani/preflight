// The agent's reason is untrusted text: it may be steered by a prompt
// injection the agent read. Strip what hides or forges text, cap it, and keep
// the quarantine rule hits so the phone can warn the owner.
import { LENGTH_BUDGET, scanValue } from '@preflight/quarantine';

/** C0 controls fake new lines; zero-width and bidi characters hide text from the reader. */
const CONTROL = /[\x00-\x1f\x7f]/g;
const INVISIBLE = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}]/gu;

/** The reason is written by the agent, so it is untrusted: strip, cap, and flag. */
export function sanitiseReason(raw: unknown): { reason: string; flags: string[] } {
  const text = typeof raw === 'string' ? raw : '';
  // Scan the raw text first: the invisible characters are evidence.
  const hit = scanValue(text, 'agent', 'reason', 'delimited', LENGTH_BUDGET.prose);
  const reason = text.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return { reason: reason || '(no reason given)', flags: hit?.matchedRules ?? [] };
}

