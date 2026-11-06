// What the phone checks before it lets Face ID sign a server-built release.
// The server (and the ?api= link that picks it) is untrusted: everything that
// goes into the digest is re-derived here from local config, the chain, and
// the receipts actually on screen. Pure, so it runs under vitest too.
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { getChain, releaseDigest, type ChainKey, type Receipt, type ReceiptsReport } from '@preflight/capline';
import { hashReceipts } from './receipts.js';

/** The server uses 15 min; anything longer is a request to sign for later. */
export const MAX_EXPIRY_WINDOW = 20 * 60;

export interface ChainView {
  nonce: bigint;
  dropped: boolean;
  balance: bigint;
  lastReleaseBlock: bigint;
}

export interface RequestLike {
  chain: ChainKey;
  agent: string;
  amount: string;
  nonce: number;
  expiry: number;
  digest: string;
  receipts: Pick<ReceiptsReport, 'chain' | 'agent' | 'fromBlock' | 'receipts' | 'spent' | 'receiptsHash'>;
}

export interface Check {
  /** Safe to sign: the digest below is exactly what the screen shows. */
  ok: boolean;
  /** Locally computed digest; sign this, never the server's. */
  digest?: Hex;
  /** Sum of the displayed receipts, in base units. */
  spent?: bigint;
  receiptsOk: boolean;
  /** Nonce confirmed against the chain (false if the chain could not be read). */
  nonceOnChain: boolean;
  problems: string[];
  warnings: string[];
}

const sumReceipts = (rs: Receipt[]): bigint => rs.reduce((t, r) => t + BigInt(r.amount), 0n);

export function checkRequest(
  r: RequestLike,
  ctx: { vault: Address; now: number; chain?: ChainView },
): Check {
  const problems: string[] = [];
  const warnings: string[] = [];
  let receiptsOk = false;
  let spent: bigint | undefined;
  let digest: Hex | undefined;

  if (r.chain !== 'whitechain' && r.chain !== 'base') return { ok: false, receiptsOk, nonceOnChain: false, problems: ['Unknown chain.'], warnings };
  if (typeof r.agent !== 'string' || !isAddress(r.agent)) problems.push('Agent is not an address.');
  if (typeof r.amount !== 'string' || !/^\d+$/.test(r.amount) || BigInt(r.amount) === 0n) {
    problems.push('Amount is not a positive whole number of base units.');
  }
  if (!Number.isSafeInteger(r.nonce) || r.nonce < 0) problems.push('Bad nonce.');
  if (!Number.isSafeInteger(r.expiry)) problems.push('Bad expiry.');
  else if (r.expiry <= ctx.now) problems.push('Expired.');
  else if (r.expiry > ctx.now + MAX_EXPIRY_WINDOW) problems.push('Expiry is too far ahead; this would stay signable for too long.');

  try {
    const rc = r.receipts;
    spent = sumReceipts(rc.receipts);
    const sameAgent = isAddress(rc.agent) && isAddress(r.agent) && getAddress(rc.agent) === getAddress(r.agent);
    receiptsOk =
      hashReceipts(rc.receipts) === rc.receiptsHash &&
      rc.chain === r.chain &&
      sameAgent &&
      rc.receipts.every((x) => x.chain === r.chain) &&
      BigInt(rc.spent) === spent;
  } catch {
    receiptsOk = false;
  }
  if (!receiptsOk) problems.push('Receipts hash does not match the list shown.');

  let nonceOnChain = false;
  if (ctx.chain) {
    if (BigInt(r.nonce) !== ctx.chain.nonce) problems.push(`Nonce ${r.nonce} is not the vault's current nonce ${ctx.chain.nonce}.`);
    else nonceOnChain = true;
    if (ctx.chain.dropped) problems.push('Agent is dropped on chain.');
    if (/^\d+$/.test(String(r.amount)) && BigInt(r.amount) > ctx.chain.balance) problems.push('The vault does not hold this much.');
    if (BigInt(r.receipts.fromBlock) > ctx.chain.lastReleaseBlock) {
      warnings.push('Receipts start after the last refill block, so some spending may be missing.');
    }
  } else {
    warnings.push('Could not read the vault from this phone; the nonce is unconfirmed.');
  }

  if (problems.length === 0) {
    try {
      digest = releaseDigest({
        chain: getChain(r.chain).id,
        vault: ctx.vault,
        agent: getAddress(r.agent),
        amount: BigInt(r.amount),
        nonce: r.nonce,
        expiry: r.expiry,
        receiptsHash: r.receipts.receiptsHash,
      });
      if (digest.toLowerCase() !== String(r.digest).toLowerCase()) problems.push('Server digest differs from the one built here.');
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  return { ok: problems.length === 0, digest, spent, receiptsOk, nonceOnChain, problems, warnings };
}
