import { getAddress } from 'viem';
import { CHAINS, publicClient, txLink } from './chains.js';
import { receiptsHash } from './canonical.js';
import { scoreCounterparty } from './score.js';
import { DEFAULT_LOOKBACK, blockTimestamps, mapLimit, rawTransfers, readLastReleaseBlock } from './transfers.js';
import type { ChainKey, Hex, RawTransfer, Receipt, ReceiptsReport, Score, Scorer } from './types.js';

export interface BuildOptions {
  chain: ChainKey;
  agent: string;
  fromBlock?: number;
  toBlock?: number;
  extra?: Receipt[];
  /** Override for tests or for a caller with its own cache. Defaults to scoreCounterparty. */
  scorer?: Scorer;
}

export async function buildReceipts(opts: BuildOptions): Promise<ReceiptsReport> {
  const { chain } = opts;
  const agent = getAddress(opts.agent);
  const client = publicClient(chain);

  const toBlock = opts.toBlock ?? Number(await client.getBlockNumber());
  let fromBlock = opts.fromBlock;
  if (fromBlock === undefined) {
    fromBlock = (await readLastReleaseBlock(chain, agent)) ?? Math.max(0, toBlock - DEFAULT_LOOKBACK);
  }

  const transfers = await rawTransfers(chain, agent, fromBlock, toBlock);
  const timestamps = await blockTimestamps(chain, transfers.map((t) => t.blockNumber));

  return assembleReport({
    chain,
    agent,
    fromBlock,
    toBlock,
    transfers: transfers.map((t) => ({ ...t, timestamp: timestamps.get(t.blockNumber) ?? 0 })),
    ...(opts.extra ? { extra: opts.extra } : {}),
    scorer: opts.scorer ?? scoreCounterparty,
  });
}

export interface AssembleInput {
  chain: ChainKey;
  agent: Hex;
  fromBlock: number;
  toBlock: number;
  transfers: (RawTransfer & { timestamp: number })[];
  extra?: Receipt[];
  scorer: Scorer;
}

/**
 * Scores each unique counterparty once, merges extra receipts, sorts, sums and
 * hashes. No chain reads of its own, so tests drive it with a stub scorer.
 */
export async function assembleReport(input: AssembleInput): Promise<ReceiptsReport> {
  const { chain, scorer } = input;

  const unique = [...new Set(input.transfers.map((t) => t.to))];
  const scores = new Map<Hex, Score>();
  await mapLimit(unique, 4, async (to) => {
    scores.set(to, await scorer(chain, to));
  });

  type Keyed = { r: Receipt; logIndex: number };
  const keyed: Keyed[] = input.transfers.map((t) => {
    const s = scores.get(t.to) ?? { verdict: 'unknown' as const, reasons: ['not scored'] };
    return {
      logIndex: t.logIndex,
      r: {
        chain,
        kind: 'transfer',
        txHash: t.txHash,
        blockNumber: t.blockNumber,
        timestamp: t.timestamp,
        to: t.to,
        token: t.token,
        amount: t.amount,
        verdict: s.verdict,
        reasons: [...s.reasons],
        link: txLink(chain, t.txHash),
      },
    };
  });

  for (const r of input.extra ?? []) {
    // Extra receipts (Flash fills) carry no log index; meta.logIndex if the
    // producer knows it, otherwise after this block's transfers.
    const li = Number(r.meta?.['logIndex']);
    keyed.push({ r, logIndex: Number.isFinite(li) ? li : Number.MAX_SAFE_INTEGER });
  }

  keyed.sort(
    (x, y) =>
      x.r.blockNumber - y.r.blockNumber ||
      x.logIndex - y.logIndex ||
      (x.r.txHash < y.r.txHash ? -1 : x.r.txHash > y.r.txHash ? 1 : 0),
  );
  const receipts = keyed.map((k) => k.r);
  const spent = receipts.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString();

  return {
    chain,
    agent: input.agent,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    receipts,
    spent,
    receiptsHash: receiptsHash(receipts),
  };
}

export { CHAINS };
