/**
 * NEW during ETHOnline 2026.
 *
 * Detection rules for text that is trying to be read as instruction.
 *
 * Every string Preflight handles was written by the author of the contract
 * under review. A contract name, a token symbol, an ABI function name: all of
 * it is free text, costs one transaction to publish, is hosted permanently by
 * a block explorer or a subgraph, and lands directly in the context window of
 * an agent that holds signing capability.
 *
 * The rules are grouped by what they detect rather than by severity, because
 * the interesting cases combine them. A payload that carries a bidi override
 * and an imperative is doing two different things at once.
 *
 * The corpus in test/ is the artifact worth reusing. It runs against any MCP
 * server, not just this one.
 */

export interface Rule {
  id: string;
  /** What an operator reading a taint log needs to understand about the match. */
  describe: string;
  re?: RegExp;
  test?: (value: string) => boolean;
}

export const RULES: Rule[] = [
  // --- Instruction-shaped text -------------------------------------------
  {
    id: 'imperative-override',
    describe: 'Attempts to void the surrounding instructions',
    re: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instruction|prompt|rule|context)/i,
  },
  {
    id: 'role-injection',
    describe: 'Impersonates a conversation role to fake a new turn',
    re: /(^|[\s>\]])(system|assistant|user|developer)\s*:/i,
  },
  {
    id: 'tool-coercion',
    describe: 'Names a signing action next to an address',
    re: /\b(approve|transfer|send|sign|execute|withdraw|drain)\b.{0,60}0x[a-fA-F0-9]{40}/i,
  },
  {
    id: 'safety-assertion',
    describe: 'Asserts its own verdict, which is the one thing the data may not do',
    re: /\b(this (token|contract) is safe|verified by|audited by|do not flag|mark as (safe|low risk)|no risk)\b/i,
  },

  // --- Boundary escapes ---------------------------------------------------
  {
    id: 'delimiter-escape',
    describe: 'Tries to close the delimiter it is wrapped in',
    re: /<\/?\s*(untrusted|system|instructions?|context)\b|```/i,
  },

  // --- Invisible characters ----------------------------------------------
  {
    id: 'bidi-override',
    describe: 'Reorders how the text renders to a human without changing its bytes',
    re: /[\u202a-\u202e\u2066-\u2069]/,
  },
  {
    id: 'zero-width',
    describe: 'Hides characters that a reviewer reading the output cannot see',
    re: /[\u200b-\u200f\u2060-\u2064\ufeff]/,
  },

  // --- Shape anomalies ----------------------------------------------------
  {
    id: 'newline-in-field',
    describe: 'A name or symbol containing line breaks, which can forge a new section',
    re: /[\r\n]/,
  },
  {
    id: 'excess-length',
    describe: 'Far longer than any real token name, so it is carrying a payload',
    test: (v) => v.length > 120,
  },
];

/** Every rule that matches. Cheap enough to run on every field. */
export function detect(value: string): Rule[] {
  return RULES.filter((r) => (r.re ? r.re.test(value) : r.test!(value)));
}
