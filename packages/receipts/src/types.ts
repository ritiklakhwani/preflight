// Wire types come from @preflight/capline so there is one definition.
import type { Receipt, ReceiptsReport, Verdict } from '@preflight/capline';

export type { Receipt, ReceiptsReport, Verdict };

export type ChainKey = Receipt['chain'];
export type Hex = `0x${string}`;

/** One ERC-20 Transfer log out of the agent's wallet. No scoring, no timestamp. */
export interface RawTransfer {
  chain: ChainKey;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
  from: Hex;
  to: Hex;
  token: Hex;
  amount: string;
}

export interface Score {
  verdict: Verdict;
  reasons: string[];
}

export type Scorer = (chain: ChainKey, address: Hex) => Promise<Score>;
