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

/**
 * Where the approval server lives. The app is static (GitHub Pages) while the
 * server sits behind a tunnel whose URL can change, so the push link carries it
 * as ?api=https://... and the app remembers the last one. Empty means same
 * origin (server hosts the PWA, or the Vite dev proxy). Only https or localhost
 * is accepted, and the phone re-derives the digest from chain state anyway, so a
 * hostile server cannot get a different release signed.
 */
function resolveApiUrl(): string {
  const KEY = 'capline.apiUrl';
  const ok = (u: string) => /^https:\/\/[^\s/]+/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(u);
  try {
    const fromLink = new URLSearchParams(window.location.search).get('api');
    if (fromLink && ok(fromLink)) {
      localStorage.setItem(KEY, fromLink);
      return fromLink.replace(/\/$/, '');
    }
    const saved = localStorage.getItem(KEY);
    if (saved && ok(saved)) return saved.replace(/\/$/, '');
  } catch {
    // Private mode or no window: fall through to the build-time value.
  }
  return (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
}

export const API_URL: string = resolveApiUrl();

export const txUrl = (chain: ChainKey, hash: string) => `${CHAIN_META[chain].explorer}/tx/${hash}`;
export const addressUrl = (chain: ChainKey, addr: string) => `${CHAIN_META[chain].explorer}/address/${addr}`;

/**
 * Display-only names for addresses we know. Never fed into receipts, hashes or
 * digests: it only changes how an address reads on screen. Keyed by chain and
 * lowercase address. Unknown contracts stay unlabelled on purpose.
 */
const LABELS: Record<string, string> = {
  'whitechain:0xc08add15dd046319730ff61150940136c2718429': 'Merchant API',
  'whitechain:0x31529ef8ec96f7a1bc5ea0166b3c040b1b95bbee': 'Capline vault',
  'base:0x5d00000873b6bf41539e6f5365b0ff7d3c368f78': 'Definitive Flash settlement',
  'base:0x25d1946ee739e53160be890fbec9a2c66fc61799': 'Capline vault',
};

export const addressLabel = (chain: ChainKey, addr: string | undefined): string | undefined =>
  addr ? LABELS[`${chain}:${addr.toLowerCase()}`] : undefined;
