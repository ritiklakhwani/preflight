import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import { assembleReport } from '../src/build.js';
import { canonicalJson, receiptsHash } from '../src/canonical.js';
import { mapEngineVerdict, whitechainVerdict, withTimeout, type WhitechainFacts } from '../src/score.js';
import type { Receipt, Scorer } from '../src/types.js';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as const;
const TX1 = `0x${'a'.repeat(64)}` as const;
const TX2 = `0x${'b'.repeat(64)}` as const;

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    chain: 'whitechain',
    kind: 'transfer',
    txHash: TX1,
    blockNumber: 10,
    timestamp: 1700000000,
    to: A,
    token: TOKEN,
    amount: '1000000',
    verdict: 'clean',
    reasons: ['known token'],
    link: `https://explorer.testnet.whitechain.io/tx/${TX1}`,
    ...over,
  };
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('drops undefined members and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  it('refuses bigints and non-finite numbers', () => {
    expect(() => canonicalJson({ amount: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });

  it('escapes strings like JSON', () => {
    expect(canonicalJson({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
  });
});

describe('receiptsHash', () => {
  it('is keccak256 of the canonical JSON', () => {
    const rs = [receipt()];
    expect(receiptsHash(rs)).toBe(keccak256(stringToBytes(canonicalJson(rs))));
  });

  it('is stable across key order and absent meta', () => {
    const r = receipt();
    const shuffled = Object.fromEntries(Object.entries(r).reverse()) as unknown as Receipt;
    expect(receiptsHash([shuffled])).toBe(receiptsHash([r]));
    expect(receiptsHash([{ ...r, meta: undefined }])).toBe(receiptsHash([r]));
  });

  it('changes when any field changes', () => {
    const h = receiptsHash([receipt()]);
    expect(receiptsHash([receipt({ amount: '1000001' })])).not.toBe(h);
    expect(receiptsHash([receipt({ verdict: 'high' })])).not.toBe(h);
    expect(receiptsHash([receipt(), receipt({ txHash: TX2 })])).not.toBe(
      receiptsHash([receipt({ txHash: TX2 }), receipt()]),
    );
  });

  it('pins the empty list', () => {
    expect(receiptsHash([])).toBe(keccak256(stringToBytes('[]')));
  });
});

describe('mapEngineVerdict', () => {
  const sig = (name: string, fired: boolean, weight: number, error?: string) => ({
    name,
    fired,
    weight,
    evidence: [],
    ...(error ? { error } : {}),
  });

  it('maps severity and lists heaviest fired signals, at most three', () => {
    const s = mapEngineVerdict({
      severity: 'high',
      coverage: { ran: 5, total: 5 },
      signals: [
        sig('pool-age', true, 0.2),
        sig('unverified-source', true, 0.5),
        sig('self-destruct', true, 0.4),
        sig('thin-liquidity', true, 0.1),
        sig('no-market', false, 0.3),
      ],
    });
    expect(s).toEqual({ verdict: 'high', reasons: ['unverified source', 'self destruct', 'pool age'] });
  });

  it('is unknown when coverage is too low, with the first error', () => {
    const s = mapEngineVerdict({
      severity: 'clean',
      coverage: { ran: 1, total: 5 },
      signals: [sig('a', false, 0.1, 'ETHERSCAN_API_KEY is not set'), sig('b', false, 0.1)],
    });
    expect(s.verdict).toBe('unknown');
    expect(s.reasons[0]).toMatch(/inconclusive: 1 of 5/);
    expect(s.reasons[1]).toMatch(/ETHERSCAN_API_KEY/);
  });

  it('says so when nothing fired', () => {
    const s = mapEngineVerdict({ severity: 'clean', coverage: { ran: 4, total: 4 }, signals: [] });
    expect(s).toEqual({ verdict: 'clean', reasons: ['no risk signals fired (4 of 4 checks)'] });
  });

  it('treats a wallet as unknown', () => {
    const s = mapEngineVerdict({
      severity: 'medium',
      coverage: { ran: 4, total: 4 },
      signals: [],
      analysis: { isContract: false },
    });
    expect(s).toEqual({ verdict: 'unknown', reasons: ['wallet, not a contract'] });
  });
});

describe('whitechainVerdict', () => {
  const now = 2_000_000_000;
  const base: WhitechainFacts = {
    hasCode: true,
    verified: false,
    createdAt: now - 3600,
    deployer: '0xca4Fde0786758681d083E6515C7E3584BE75D11C',
    txCount: 3,
  };

  it('unverified and younger than 24h is high', () => {
    const s = whitechainVerdict(base, now);
    expect(s.verdict).toBe('high');
    expect(s.reasons).toEqual(['unverified contract', 'deployed 1h ago', 'deployer 0xca4F...D11C']);
  });
  it('unverified and older is medium', () => {
    expect(whitechainVerdict({ ...base, createdAt: now - 3 * 86400 }, now).verdict).toBe('medium');
  });
  it('unverified of unknown age is medium', () => {
    expect(whitechainVerdict({ ...base, createdAt: null }, now).verdict).toBe('medium');
  });
  it('verified is low, old verified with activity is clean', () => {
    expect(whitechainVerdict({ ...base, verified: true }, now).verdict).toBe('low');
    expect(whitechainVerdict({ ...base, verified: true, createdAt: now - 30 * 86400, txCount: 500 }, now).verdict).toBe(
      'clean',
    );
  });
  it('EOA is unknown', () => {
    expect(whitechainVerdict({ ...base, hasCode: false }, now)).toEqual({
      verdict: 'unknown',
      reasons: ['wallet, not a contract'],
    });
  });
  it('known token is never flagged, even if new and unverified', () => {
    expect(whitechainVerdict({ ...base, known: 'known token: Whitechain USDT' }, now).verdict).toBe('clean');
  });
  it('explorer down is unknown, not clean', () => {
    expect(whitechainVerdict({ ...base, verified: null }, now).verdict).toBe('unknown');
  });
});

describe('withTimeout', () => {
  it('degrades to the fallback instead of hanging', async () => {
    const never = new Promise<never>(() => {});
    const s = await withTimeout(never, 20, { verdict: 'unknown', reasons: ['timed out'] });
    expect(s.reasons).toEqual(['timed out']);
  });
  it('turns a throw into unknown', async () => {
    const s = await withTimeout(Promise.reject(new Error('boom')), 1000, { verdict: 'unknown', reasons: [] });
    expect(s).toEqual({ verdict: 'unknown', reasons: ['scoring failed: boom'] });
  });
});

describe('assembleReport with a stubbed scorer', () => {
  it('scores each counterparty once, merges extra, sorts, sums and hashes', async () => {
    const calls: string[] = [];
    const scorer: Scorer = async (_chain, addr) => {
      calls.push(addr);
      return addr === A ? { verdict: 'high', reasons: ['unverified contract'] } : { verdict: 'unknown', reasons: ['wallet, not a contract'] };
    };
    const t = (blockNumber: number, logIndex: number, to: `0x${string}`, amount: string, txHash = TX1) => ({
      chain: 'whitechain' as const,
      txHash,
      blockNumber,
      logIndex,
      from: B,
      to,
      token: TOKEN,
      amount,
      timestamp: 1700000000 + blockNumber,
    });
    const flash = receipt({ kind: 'flash_order', blockNumber: 11, txHash: TX2, to: B, amount: '5', meta: { pair: 'ETH/USDC' } });

    const report = await assembleReport({
      chain: 'whitechain',
      agent: B,
      fromBlock: 1,
      toBlock: 20,
      transfers: [t(12, 0, A, '300'), t(11, 2, B, '20'), t(11, 1, A, '100')],
      extra: [flash],
      scorer,
    });

    expect(calls.sort()).toEqual([A, B].sort());
    expect(report.receipts.map((r) => [r.blockNumber, r.kind, r.amount])).toEqual([
      [11, 'transfer', '100'],
      [11, 'transfer', '20'],
      [11, 'flash_order', '5'],
      [12, 'transfer', '300'],
    ]);
    expect(report.receipts[0]?.verdict).toBe('high');
    expect(report.receipts[1]?.reasons).toEqual(['wallet, not a contract']);
    expect(report.receipts[0]?.link).toBe(`https://explorer.testnet.whitechain.io/tx/${TX1}`);
    expect(report.spent).toBe('425');
    expect(report.receiptsHash).toBe(receiptsHash(report.receipts));
  });
});
