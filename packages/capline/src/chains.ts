import { defineChain, type Address, type Chain } from 'viem';
import { base } from 'viem/chains';
import { readEnv } from './env.js';

export type ChainKey = 'whitechain' | 'base';

export interface ChainConfig {
  key: ChainKey;
  id: number;
  name: string;
  rpcUrl: string;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  explorer: string;
  vault: Address | undefined;
  chain: Chain;
}

export type ChainOverrides = Partial<Pick<ChainConfig, 'rpcUrl' | 'token' | 'vault' | 'explorer'>>;

/** Accepted wherever a chain is needed: a key, or a config from getChain. */
export type ChainRef = ChainKey | ChainConfig;

export const whitechainSepolia: Chain = defineChain({
  id: 1874,
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WhiteBIT Coin', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } },
  blockExplorers: {
    default: { name: 'Whitechain Explorer', url: 'https://explorer.testnet.whitechain.io' },
  },
  testnet: true,
});

function asAddress(v: string | undefined): Address | undefined {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;
}

function withRpc(chain: Chain, rpcUrl: string): Chain {
  return { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [rpcUrl] } } };
}

// Built on every call so env loaded after import (key ring, --env-file) counts.
function build(key: ChainKey): ChainConfig {
  if (key === 'whitechain') {
    const rpcUrl = readEnv('WHITECHAIN_RPC_URL') ?? 'https://rpc.testnet.whitechain.io';
    return {
      key,
      id: 1874,
      name: 'Whitechain Sepolia',
      rpcUrl,
      token: asAddress(readEnv('WHITECHAIN_USDT')) ?? '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7',
      tokenSymbol: 'USDT',
      tokenDecimals: 6,
      explorer: 'https://explorer.testnet.whitechain.io',
      vault: asAddress(readEnv('CAPLINE_VAULT_WHITECHAIN')),
      chain: withRpc(whitechainSepolia, rpcUrl),
    };
  }
  const rpcUrl = readEnv('BASE_RPC_URL') ?? 'https://mainnet.base.org';
  return {
    key,
    id: 8453,
    name: 'Base',
    rpcUrl,
    token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    explorer: 'https://basescan.org',
    vault: asAddress(readEnv('CAPLINE_VAULT_BASE')),
    chain: withRpc(base, rpcUrl),
  };
}

/** Snapshot at import time. Prefer getChain, which re-reads env. */
export const CHAINS: Record<ChainKey, ChainConfig> = {
  whitechain: build('whitechain'),
  base: build('base'),
};

export function getChain(key: ChainKey, overrides: ChainOverrides = {}): ChainConfig {
  const cfg = build(key);
  const rpcUrl = overrides.rpcUrl ?? cfg.rpcUrl;
  return {
    ...cfg,
    ...overrides,
    rpcUrl,
    chain: overrides.rpcUrl ? withRpc(cfg.chain, rpcUrl) : cfg.chain,
  };
}

export function resolveChain(ref: ChainRef): ChainConfig {
  return typeof ref === 'string' ? getChain(ref) : ref;
}

export function chainKeyById(id: number): ChainKey | undefined {
  return id === 1874 ? 'whitechain' : id === 8453 ? 'base' : undefined;
}

export function requireVault(ref: ChainRef): Address {
  const cfg = resolveChain(ref);
  if (!cfg.vault) {
    const envName = cfg.key === 'whitechain' ? 'CAPLINE_VAULT_WHITECHAIN' : 'CAPLINE_VAULT_BASE';
    throw new Error(`No CaplineVault address for ${cfg.name}. Set ${envName}.`);
  }
  return cfg.vault;
}
