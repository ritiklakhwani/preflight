/**
 * NEW during ETHOnline 2026.
 *
 * Tagging untrusted text at the point it enters the system.
 *
 * The boundary matters more than the rules. Preflight previously neutralised
 * attacker-controlled strings only at the moment of rendering, which is the
 * last possible instant and after the text had already been used: the model
 * had read the contract source unguarded, and nothing recorded what was in it.
 * Scanning at ingress means the taint travels with the verdict, the console
 * can show what was caught, and the model prompt can be defended separately.
 */
import type { TaintEvent } from '@preflight/core';
import { detect } from './rules.js';

/** A field to check, named so the taint log points somewhere specific. */
export interface Field {
  path: string;
  value: unknown;
}

/**
 * Records a field only when something matched. A log that also contains every
 * benign token symbol is a log nobody reads.
 */
export function scanValue(
  value: unknown,
  source: string,
  path: string,
  action: TaintEvent['action'] = 'delimited',
): TaintEvent | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const matched = detect(value);
  if (matched.length === 0) return null;

  return {
    fieldPath: path,
    source,
    // Capped: a payload's whole point can be its length, and the taint log is
    // stored and rendered.
    raw: value.slice(0, 300),
    action,
    matchedRules: matched.map((r) => r.id),
  };
}

export function scanFields(fields: Field[], source: string): TaintEvent[] {
  const events: TaintEvent[] = [];
  for (const f of fields) {
    if (Array.isArray(f.value)) {
      f.value.forEach((v, i) => {
        const e = scanValue(v, source, `${f.path}[${i}]`);
        if (e) events.push(e);
      });
      continue;
    }
    const e = scanValue(f.value, source, f.path);
    if (e) events.push(e);
  }
  return events;
}
