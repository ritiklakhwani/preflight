// Browser copy of @preflight/receipts canonical hashing (that package is
// Node-only). Lets the phone re-derive receiptsHash itself, and build a raw
// fallback list straight from chain logs when the server is down.
import { getAddress, keccak256, parseAbiItem, stringToBytes, type Hex } from 'viem';
import { getChain, publicClient, type Receipt, type ReceiptsReport } from '@preflight/capline';
import type { ChainKey } from './config.js';

export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/** Must stay byte-identical to packages/receipts/src/canonical.ts. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(obj).sort()) {
        if (obj[k] === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`unsupported type ${typeof value}`);
  }
}

export const hashReceipts = (receipts: Receipt[]): Hex => keccak256(stringToBytes(canonicalJson(receipts)));

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MAX_RANGE = 10_000n; // Whitechain RPC caps getLogs at 10k blocks.

/** Unscored Transfer logs out of the agent wallet since fromBlock. */
export async function rawReceipts(chain: ChainKey, agent: `0x${string}`, fromBlock: bigint): Promise<ReceiptsReport> {
  const cfg = getChain(chain);
  const client = publicClient(chain);
  const head = await client.getBlockNumber();
  // Cap the window so a never-released agent does not mean thousands of calls.
  let start = fromBlock > 0n ? fromBlock : head > 5_000n ? head - 5_000n : 0n;
  if (head - start > MAX_RANGE * 5n) start = head - MAX_RANGE * 5n;

  const logs = [];
  for (let s = start; s <= head; s += MAX_RANGE) {
    const e = s + MAX_RANGE - 1n < head ? s + MAX_RANGE - 1n : head;
    logs.push(
      ...(await client.getLogs({ address: cfg.token, event: TRANSFER, args: { from: agent }, fromBlock: s, toBlock: e })),
    );
  }
  logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

  const times = new Map<bigint, number>();
  for (const b of new Set(logs.slice(0, 25).map((l) => l.blockNumber))) {
    const blk = await client.getBlock({ blockNumber: b });
    times.set(b, Number(blk.timestamp));
  }

  const receipts: Receipt[] = logs.map((l) => ({
    chain,
    kind: 'transfer',
    txHash: l.transactionHash,
    blockNumber: Number(l.blockNumber),
    timestamp: times.get(l.blockNumber) ?? 0,
    to: getAddress(l.args.to!),
    token: cfg.token,
    amount: (l.args.value ?? 0n).toString(),
    verdict: 'unknown',
    reasons: ['raw transfer log, not risk-scored'],
    link: `${cfg.explorer}/tx/${l.transactionHash}`,
  }));
  const spent = receipts.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString();
  return {
    chain,
    agent,
    fromBlock: Number(start),
    toBlock: Number(head),
    receipts,
    spent,
    receiptsHash: hashReceipts(receipts),
  };
}
