// Wallet and HTTP helpers for the paying agent on Whitechain Sepolia (1874).
// Self-contained chain config so the agent runs even if @preflight/capline changes.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hash,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const RPC = process.env.WHITECHAIN_RPC_URL || 'https://rpc.testnet.whitechain.io';
export const USDT = getAddress(process.env.WHITECHAIN_USDT || '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7');
export const EXPLORER = 'https://explorer.testnet.whitechain.io';
export const MERCHANT_URL = process.env.MERCHANT_URL || `http://localhost:${process.env.MERCHANT_PORT || 8788}`;

export const whitechain = defineChain({
  id: 1874,
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
  testnet: true,
});

export const publicClient = createPublicClient({ chain: whitechain, transport: http(RPC) });

let account: PrivateKeyAccount | undefined;
export function agentAccount(): PrivateKeyAccount {
  if (account) return account;
  const pk = process.env.PAYER_AGENT_PRIVATE_KEY;
  if (!pk) throw new Error('PAYER_AGENT_PRIVATE_KEY is not set');
  account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`);
  return account;
}

/** The agent's address: from the key if present, else CAPLINE_AGENT_ADDRESS (read-only runs). */
export function agentAddress(): Address {
  if (process.env.PAYER_AGENT_PRIVATE_KEY) return agentAccount().address;
  const a = process.env.CAPLINE_AGENT_ADDRESS;
  if (!a) throw new Error('Set PAYER_AGENT_PRIVATE_KEY (or CAPLINE_AGENT_ADDRESS for read-only use)');
  return getAddress(a);
}

let decimalsCache: number | undefined;
export async function usdtDecimals(): Promise<number> {
  // Spec says 6; read it once to be sure.
  decimalsCache ??= await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: 'decimals' });
  return decimalsCache;
}

export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (addr: string) => `${EXPLORER}/address/${addr}`;

export async function usdtBalance(address?: Address): Promise<{ raw: bigint; human: string }> {
  const who = address ?? agentAddress();
  const [raw, dec] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
    usdtDecimals(),
  ]);
  return { raw, human: formatUnits(raw, dec) };
}

export async function toBaseUnits(amountHuman: string): Promise<bigint> {
  return parseUnits(amountHuman, await usdtDecimals());
}

/** Sends USDT and waits for the receipt, so the merchant can verify right away. */
export async function payUsdt(to: Address, amountHuman: string): Promise<{ hash: Hash; link: string }> {
  const acct = agentAccount();
  const wallet = createWalletClient({ account: acct, chain: whitechain, transport: http(RPC) });
  const value = await toBaseUnits(amountHuman);
  const hash = await wallet.writeContract({
    address: USDT,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(to), value],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`USDT transfer reverted: ${txLink(hash)}`);
  return { hash, link: txLink(hash) };
}

export interface ApiResponse {
  status: number;
  body: unknown; // parsed JSON when possible, else text
}

export async function fetchApi(url: string, paymentTx?: string): Promise<ApiResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (paymentTx) headers['X-Payment-Tx'] = paymentTx;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; hand back the text as is.
  }
  return { status: res.status, body };
}

/** Payment terms from a 402 body, per the spec ({ payTo, token, amount, memo }). */
export interface PaymentTerms {
  payTo: Address;
  token: Address;
  amount: string;
  memo?: string;
}
export function readTerms(body: unknown): PaymentTerms | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.payTo !== 'string' || typeof b.amount !== 'string') return undefined;
  return {
    payTo: getAddress(b.payTo),
    token: getAddress(typeof b.token === 'string' ? b.token : USDT),
    amount: b.amount,
    memo: typeof b.memo === 'string' ? b.memo : undefined,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
