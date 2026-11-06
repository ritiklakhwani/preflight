// Static chain facts from docs/CAPLINE_SPEC.md. Kept here so the phone can
// format amounts and link to explorers without asking anyone.
export type ChainKey = 'whitechain' | 'base';
export const CHAIN_KEYS: ChainKey[] = ['whitechain', 'base'];

export interface ChainMeta {
  id: number;
  name: string;
  symbol: string;
  decimals: number;
  explorer: string;
  nativeSymbol: string;
}

export const CHAIN_META: Record<ChainKey, ChainMeta> = {
  whitechain: {
    id: 1874,
    name: 'Whitechain testnet',
    symbol: 'USDT',
    decimals: 6,
    explorer: 'https://explorer.testnet.whitechain.io',
    nativeSymbol: 'WBT',
  },
  base: { id: 8453, name: 'Base', symbol: 'USDC', decimals: 6, explorer: 'https://basescan.org', nativeSymbol: 'ETH' },
};

export const isChainKey = (v: unknown): v is ChainKey => v === 'whitechain' || v === 'base';

/** Empty means same origin (server hosts the PWA, or the Vite dev proxy). */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export const txUrl = (chain: ChainKey, hash: string) => `${CHAIN_META[chain].explorer}/tx/${hash}`;
export const addressUrl = (chain: ChainKey, addr: string) => `${CHAIN_META[chain].explorer}/address/${addr}`;
