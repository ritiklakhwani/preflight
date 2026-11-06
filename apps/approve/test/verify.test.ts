import { describe, expect, it } from 'vitest';
import { releaseDigest, type Receipt } from '@preflight/capline';
import { hashReceipts } from '../web/src/receipts.js';
import { MAX_EXPIRY_WINDOW, checkRequest, type ChainView, type RequestLike } from '../web/src/verify.js';

const vault = '0x31529ef8ec96f7a1bc5ea0166b3c040b1b95bbee' as const;
const agent = '0x1111111111111111111111111111111111111111' as const;
const NOW = 1_800_000_000;

const receipts: Receipt[] = [
  {
    chain: 'whitechain',
    kind: 'transfer',
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 120,
    timestamp: NOW - 100,
    to: '0x2222222222222222222222222222222222222222',
    token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7',
    amount: '1500000',
    verdict: 'clean',
    reasons: [],
    link: 'https://explorer.testnet.whitechain.io/tx/0xab',
  },
];

const chain: ChainView = { nonce: 3n, dropped: false, balance: 100_000_000n, lastReleaseBlock: 100n };

function honest(over: Partial<RequestLike> = {}): RequestLike {
  const base = {
    chain: 'whitechain' as const,
    agent,
    amount: '5000000',
    nonce: 3,
    expiry: NOW + 900,
    receipts: {
      chain: 'whitechain' as const,
      agent,
      fromBlock: 100,
      receipts,
      spent: '1500000',
      receiptsHash: hashReceipts(receipts),
    },
    ...over,
  };
  const digest = releaseDigest({
    chain: 1874,
    vault,
    agent: base.agent as `0x${string}`,
    amount: BigInt(base.amount),
    nonce: base.nonce,
    expiry: base.expiry,
    receiptsHash: base.receipts.receiptsHash,
  });
  return { digest, ...base };
}

const run = (r: RequestLike, c: ChainView | undefined = chain) => checkRequest(r, { vault, now: NOW, chain: c });

describe('checkRequest (phone-side release check)', () => {
  it('passes an honest request and returns the locally built digest', () => {
    const r = honest();
    const c = run(r);
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.digest).toBe(r.digest);
    expect(c.spent).toBe(1_500_000n);
    expect(c.nonceOnChain).toBe(true);
  });

  it('blocks a server digest that does not match the displayed fields', () => {
    const r = { ...honest(), amount: '50000000' }; // shows 50, digest is for 5
    expect(run(r).ok).toBe(false);
  });

  it('blocks a future nonce even when the server digest is self-consistent', () => {
    const r = honest({ nonce: 5 });
    const c = run(r);
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/nonce/i);
  });

  it('blocks an expiry far in the future even when self-consistent', () => {
    const c = run(honest({ expiry: NOW + MAX_EXPIRY_WINDOW + 60 }));
    expect(c.ok).toBe(false);
    expect(c.problems.join(' ')).toMatch(/expiry/i);
  });

  it('blocks an expired request', () => {
    expect(run(honest({ expiry: NOW - 1 })).ok).toBe(false);
  });

  it('blocks receipts that do not hash to the signed receiptsHash', () => {
    const r = honest();
    const shown = [{ ...receipts[0]!, verdict: 'clean' as const, amount: '1' }];
    const c = run({ ...r, receipts: { ...r.receipts, receipts: shown, spent: '1' } });
    expect(c.receiptsOk).toBe(false);
    expect(c.ok).toBe(false);
  });

  it('blocks a spent total that is not the sum of the shown receipts', () => {
    const r = honest();
    const c = run({ ...r, receipts: { ...r.receipts, spent: '0' } });
    expect(c.receiptsOk).toBe(false);
    expect(c.ok).toBe(false);
  });

  it('blocks receipts for a different agent', () => {
    const r = honest();
    const c = run({ ...r, receipts: { ...r.receipts, agent: '0x3333333333333333333333333333333333333333' } });
    expect(c.ok).toBe(false);
  });

  it('blocks a hex or negative amount string', () => {
    expect(run({ ...honest(), amount: '0x10' }).ok).toBe(false);
    expect(run({ ...honest(), amount: '-1' }).ok).toBe(false);
  });

  it('blocks when the agent is dropped on chain', () => {
    expect(run(honest(), { ...chain, dropped: true }).ok).toBe(false);
  });

  it('allows but warns when the chain cannot be read', () => {
    const c = checkRequest(honest(), { vault, now: NOW });
    expect(c.ok).toBe(true);
    expect(c.nonceOnChain).toBe(false);
    expect(c.warnings.length).toBeGreaterThan(0);
  });

  it('warns when the receipts window skips spending since the last refill', () => {
    const c = run(honest(), { ...chain, lastReleaseBlock: 50n });
    expect(c.warnings.join(' ')).toMatch(/missing/);
  });
});
