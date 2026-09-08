import { describe, expect, it } from 'vitest';
import { score } from '../src/score.js';
import type { SignalResult } from '../src/types.js';

const sig = (over: Partial<SignalResult>): SignalResult => ({
  name: 'test', fired: false, weight: 1, evidence: [], ...over,
});

describe('score', () => {
  it('is clean when nothing fires', () => {
    expect(score([sig({}), sig({})])).toEqual({ score: 0, severity: 'clean' });
  });

  it('is high when everything fires', () => {
    expect(score([sig({ fired: true }), sig({ fired: true })])).toEqual({
      score: 100, severity: 'high',
    });
  });

  it('weights by signal, not by count', () => {
    const light = score([sig({ fired: true, weight: 0.2 }), sig({ weight: 0.8 })]);
    const heavy = score([sig({ weight: 0.2 }), sig({ fired: true, weight: 0.8 })]);
    expect(light.score).toBe(20);
    expect(heavy.score).toBe(80);
  });

  it('excludes signals that errored from the denominator', () => {
    // Without the exclusion a broken signal would silently dilute the score
    // and make a risky address look safer than the working signals say it is.
    const withError = score([sig({ fired: true, weight: 1 }), sig({ weight: 1, error: 'timeout' })]);
    expect(withError).toEqual({ score: 100, severity: 'high' });
  });

  it('is clean rather than dividing by zero when every signal errored', () => {
    expect(score([sig({ weight: 1, error: 'x' })])).toEqual({ score: 0, severity: 'clean' });
  });

  it('places each severity band at its documented boundary', () => {
    const at = (n: number) =>
      score([sig({ fired: true, weight: n }), sig({ weight: 100 - n })]).severity;
    expect(at(14)).toBe('clean');
    expect(at(15)).toBe('low');
    expect(at(34)).toBe('low');
    expect(at(35)).toBe('medium');
    expect(at(59)).toBe('medium');
    expect(at(60)).toBe('high');
  });
});
