import { describe, expect, it } from 'vitest';
import { runSignals } from '../src/run.js';
import type { Signal } from '../src/types.js';
import { context } from '../../../test/fixtures.js';

const ctx = context();

const ok: Signal = {
  name: 'ok', weight: 1, describe: '',
  run: async () => ({ fired: true, evidence: [] }),
};
const boom: Signal = {
  name: 'boom', weight: 1, describe: '',
  run: async () => { throw new Error('subgraph unreachable'); },
};

describe('runSignals', () => {
  it('records a throwing signal instead of failing the verdict', async () => {
    // An agent waiting to sign needs the answer from the signals that worked.
    const results = await runSignals([ok, boom], ctx);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: 'ok', fired: true });
    expect(results[1]).toMatchObject({ name: 'boom', fired: false, error: 'subgraph unreachable' });
  });

  it('keeps results in the order the signals were declared', async () => {
    const results = await runSignals([boom, ok, boom], ctx);
    expect(results.map((r) => r.name)).toEqual(['boom', 'ok', 'boom']);
  });
});
