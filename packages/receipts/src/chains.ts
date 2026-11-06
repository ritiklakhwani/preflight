// Self-contained chain config so receipts work before @preflight/capline exists.
// Values mirror the Chains table in docs/CAPLINE_SPEC.md.
import { createPublicClient, defineChain, getAddress, http, type Chain, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { ChainKey, Hex } from './types.js';

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

export const whitechainTestnet: Chain = defineChain({
  id: 1874,
  name: 'Whitechain Testnet',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.whitechain.io' } },
});

export interface ChainInfo {
  key: ChainKey;
  chainId: number;
  token: Hex;
  explorer: string;
  rpcUrl: () => string | undefined;
  vault: () => Hex | undefined;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  whitechain: {
    key: 'whitechain',
    chainId: 1874,
    token: getAddress(env('WHITECHAIN_USDT') ?? '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7'),
    explorer: 'https://explorer.testnet.whitechain.io',
    rpcUrl: () => env('WHITECHAIN_RPC_URL') ?? 'https://rpc.testnet.whitechain.io',
    vault: () => addr(env('CAPLINE_VAULT_WHITECHAIN')),
  },
  base: {
    key: 'base',
    chainId: 8453,
    token: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    explorer: 'https://basescan.org',
    // Undefined falls through to viem's public Base RPC.
    rpcUrl: () => env('BASE_RPC_URL'),
    vault: () => addr(env('CAPLINE_VAULT_BASE')),
  },
};

function addr(v: string | undefined): Hex | undefined {
  if (!v) return undefined;
  try {
    return getAddress(v);
  } catch {
    return undefined;
  }
}

export function isChainKey(v: string): v is ChainKey {
  return v === 'whitechain' || v === 'base';
}

const clients = new Map<ChainKey, PublicClient>();

export function publicClient(key: ChainKey): PublicClient {
  let c = clients.get(key);
  if (!c) {
    const info = CHAINS[key];
    c = createPublicClient({
      chain: key === 'base' ? base : whitechainTestnet,
      transport: http(info.rpcUrl(), { timeout: 15_000, retryCount: 2 }),
    }) as PublicClient;
    clients.set(key, c);
  }
  return c;
}

export function txLink(key: ChainKey, txHash: string): string {
  return `${CHAINS[key].explorer}/tx/${txHash}`;
}
