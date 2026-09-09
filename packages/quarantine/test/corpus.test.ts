import { describe, expect, it } from 'vitest';
import { detect } from '../src/rules.js';
import { BENIGN, CORPUS, IMPOSSIBLE, type AttackClass, type Site } from './corpus.js';

describe('injection corpus', () => {
  it('has no duplicate ids', () => {
    const ids = CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate payloads', () => {
    const payloads = CORPUS.map((c) => c.payload);
    expect(new Set(payloads).size).toBe(payloads.length);
  });

  for (const entry of CORPUS) {
    it(`${entry.id} [${entry.site}/${entry.class}] is ${entry.expected}`, () => {
      const matched = detect(entry.payload).map((r) => r.id);
      if (entry.expected === 'detect') {
        expect(matched.length, `expected a rule to match: ${entry.payload.slice(0, 60)}`)
          .toBeGreaterThan(0);
      } else {
        // A known-miss that starts passing is good news and should be
        // promoted, so the test fails to make us notice.
        expect(matched, `known-miss now detected, promote it to detect`).toEqual([]);
      }
    });
  }
});

describe('benign strings', () => {
  it.each(BENIGN)('does not fire on the real value %s', (value) => {
    expect(detect(value)).toEqual([]);
  });
});

describe('corpus coverage', () => {
  it('reports the grid, including what is missed and what cannot be filled', () => {
    const sites = [...new Set(CORPUS.map((c) => c.site))] as Site[];
    const classes = [...new Set(CORPUS.map((c) => c.class))] as AttackClass[];
    const misses = CORPUS.filter((c) => c.expected === 'known-miss');

    // Printed rather than asserted: this is the artifact, not a threshold.
    const lines = [
      '',
      `  ${CORPUS.length} payloads across ${sites.length} sites and ${classes.length} attack classes`,
      `  ${CORPUS.length - misses.length} detected, ${misses.length} known misses, ${IMPOSSIBLE.length} cells documented as impossible`,
      '',
      '  KNOWN MISSES, which are the backlog for the next pass at the rules:',
      ...misses.map((m) => `    ${m.id.padEnd(30)} ${m.class.padEnd(24)} ${m.note ?? ''}`),
      '',
    ];
    console.log(lines.join('\n'));

    expect(CORPUS.length).toBeGreaterThan(0);
    // Documented failures are the point. A corpus with none is not evidence.
    expect(misses.length).toBeGreaterThan(0);
  });
});
