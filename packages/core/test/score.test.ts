import { describe, expect, it } from 'vitest';
import { score } from '../src/score.js';
import type { SignalResult } from '../src/types.js';

const sig = (over: Partial<SignalResult>): SignalResult => ({
  name: 'test', fired: false, weight: 0.5, evidence: [], ...over,
});

describe('score', () => {
  it('is clean when nothing fires', () => {
    expect(score([sig({}), sig({})])).toEqual({ score: 0, severity: 'clean' });
  });

  it('reports a single signal at its own weight', () => {
    // The property that matters: one damning finding is not diluted by the
    // other seven checks happening to look ordinary. Under the weighted
    // average this replaced, the demo asset scored 18 and read as LOW.
    expect(score([sig({ fired: true, weight: 0.85 }), ...Array(7).fill(sig({}))])).toEqual({
      score: 85, severity: 'high',
    });
  });

  it('accumulates independent evidence without saturating', () => {
    // 1 - (0.8 * 0.7) = 0.44
    expect(score([sig({ fired: true, weight: 0.2 }), sig({ fired: true, weight: 0.3 })]).score)
      .toBe(44);
  });

  it('never lets three weak signals outrank one strong one', () => {
    const weak = score([
      sig({ fired: true, weight: 0.2 }),
      sig({ fired: true, weight: 0.2 }),
      sig({ fired: true, weight: 0.2 }),
    ]).score;
    const strong = score([sig({ fired: true, weight: 0.85 })]).score;
    expect(weak).toBeLessThan(strong);
  });

  it('ignores signals that errored', () => {
    // A broken signal must neither add risk nor subtract it. The verdict is
    // computed from what could actually be measured.
    expect(score([sig({ fired: true, weight: 0.5 }), sig({ fired: true, weight: 0.9, error: 'timeout' })]))
      .toEqual({ score: 50, severity: 'medium' });
  });

  it('is clean when every signal errored', () => {
    expect(score([sig({ fired: true, weight: 1, error: 'x' })])).toEqual({ score: 0, severity: 'clean' });
  });

  it('clamps a weight outside 0 to 1 rather than inverting the product', () => {
    expect(score([sig({ fired: true, weight: 5 })]).score).toBe(100);
    expect(score([sig({ fired: true, weight: -3 })]).score).toBe(0);
  });

  it('places each severity band at its documented boundary', () => {
    const at = (n: number) => score([sig({ fired: true, weight: n / 100 })]).severity;
    expect(at(14)).toBe('clean');
    expect(at(15)).toBe('low');
    expect(at(34)).toBe('low');
    expect(at(35)).toBe('medium');
    expect(at(59)).toBe('medium');
    expect(at(60)).toBe('high');
  });
});
