import { getAddress, parseAbi, parseAbiItem } from 'viem';
import { CHAINS, publicClient } from './chains.js';
import type { ChainKey, Hex, RawTransfer } from './types.js';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

// Whitechain's RPC answers "query exceeds max block range 10000"; other RPCs
// use other wording, so match loosely and halve when no number is given.
const RANGE_ERROR = /range|limit|exceed|too many|too large|10000 results|response size/i;
const DEFAULT_CHUNK = 10_000;

/** Window fallback when the vault cannot tell us lastReleaseBlock. */
export const DEFAULT_LOOKBACK = 5_000;

function errText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 5; i++) {
    const o = e as { shortMessage?: string; details?: string; message?: string; cause?: unknown };
    parts.push(o.shortMessage ?? '', o.details ?? '', o.message ?? '');
    e = o.cause;
  }
  return parts.join(' | ');
}

/**
 * ERC-20 Transfer logs where from = agent on the chain's token, inclusive range.
 * Chunks requests and shrinks the chunk when the RPC rejects the range.
 */
export async function rawTransfers(
  chain: ChainKey,
  agent: string,
  fromBlock: number,
  toBlock?: number,
): Promise<RawTransfer[]> {
  const client = publicClient(chain);
  const token = CHAINS[chain].token;
  const from = getAddress(agent);
  const end = toBlock ?? Number(await client.getBlockNumber());
  if (fromBlock > end) return [];

  const out: RawTransfer[] = [];
  let chunk = DEFAULT_CHUNK;
  let start = fromBlock;
  let retried = false;

  while (start <= end) {
    const stop = Math.min(end, start + chunk - 1);
    try {
      const logs = await client.getLogs({
        address: token,
        event: TRANSFER,
        args: { from },
        fromBlock: BigInt(start),
        toBlock: BigInt(stop),
      });
      for (const l of logs) {
        if (l.args.to === undefined || l.args.value === undefined) continue;
        out.push({
          chain,
          txHash: l.transactionHash as Hex,
          blockNumber: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          from,
          to: getAddress(l.args.to),
          token,
          amount: l.args.value.toString(),
        });
      }
      start = stop + 1;
      retried = false;
    } catch (err) {
      const text = errText(err);
      if (RANGE_ERROR.test(text) && chunk > 1) {
        const m = /max(?:imum)? block range (\d+)/i.exec(text);
        const cap = m ? Number(m[1]) : 0;
        chunk = cap > 0 && cap < chunk ? cap : Math.max(1, Math.floor(chunk / 2));
        continue;
      }
      // One blind retry for transient failures, then give up loudly: a
      // receipts list with a silent hole is worse than no list.
      if (!retried) {
        retried = true;
        continue;
      }
      throw new Error(`getLogs ${chain} ${start}-${stop} failed: ${text.slice(0, 200)}`);
    }
  }

  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** Unix-second timestamps for the given blocks, a few requests at a time. */
export async function blockTimestamps(chain: ChainKey, blocks: number[]): Promise<Map<number, number>> {
  const client = publicClient(chain);
  const unique = [...new Set(blocks)];
  const out = new Map<number, number>();
  await mapLimit(unique, 8, async (n) => {
    const b = await client.getBlock({ blockNumber: BigInt(n) });
    out.set(n, Number(b.timestamp));
  });
  return out;
}

const VAULT_ABI = parseAbi([
  'struct Agent { bytes32 qx; bytes32 qy; address token; uint256 balance; uint64 nonce; bool dropped; uint64 lastReleaseBlock; bytes32 lastReceiptsHash; }',
  'function agents(address agent) view returns (Agent)',
  'function getAgent(address agent) view returns (Agent)',
]);

/**
 * lastReleaseBlock from the vault, or null if no vault is configured or the
 * agent is unknown. Agent is all static types, so a struct return and a public
 * mapping getter's flat tuple decode identically.
 * TODO: swap for readAgent from @preflight/capline once it is published.
 */
export async function readLastReleaseBlock(chain: ChainKey, agent: string): Promise<number | null> {
  const vault = CHAINS[chain].vault();
  if (!vault) return null;
  const client = publicClient(chain);
  for (const functionName of ['agents', 'getAgent'] as const) {
    try {
      const a = await client.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName,
        args: [getAddress(agent)],
      });
      const n = Number(a.lastReleaseBlock);
      return n > 0 ? n : null;
    } catch {
      // try the other getter name
    }
  }
  return null;
}

export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
