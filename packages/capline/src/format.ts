import { formatUnits, parseUnits, type Address, type Hex } from 'viem';
import { resolveChain, type ChainRef } from './chains.js';

/** "5" or "0.25" in token units to base units. Throws on junk input. */
export function parseAmount(chain: ChainRef, human: string): bigint {
  const s = human.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a positive decimal amount: "${human}"`);
  const { tokenDecimals } = resolveChain(chain);
  const frac = s.split('.')[1];
  // parseUnits silently rounds extra digits; refuse instead of moving money we did not mean.
  if (frac && frac.length > tokenDecimals) {
    throw new Error(`Too many decimals: token has ${tokenDecimals}`);
  }
  return parseUnits(s, tokenDecimals);
}

export function formatAmount(chain: ChainRef, units: bigint): string {
  return formatUnits(units, resolveChain(chain).tokenDecimals);
}

export function txLink(chain: ChainRef, hash: Hex): string {
  return `${resolveChain(chain).explorer}/tx/${hash}`;
}

export function addressLink(chain: ChainRef, address: Address): string {
  return `${resolveChain(chain).explorer}/address/${address}`;
}
