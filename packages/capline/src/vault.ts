import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, vaultAbi } from './abi.js';
import { requireVault, resolveChain, type ChainKey, type ChainRef } from './chains.js';
import type { AgentStateJson, WebAuthnAuthJson } from './types.js';

export type WebAuthnAuth = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

export type AgentState = {
  qx: Hex;
  qy: Hex;
  token: Address;
  balance: bigint;
  nonce: bigint;
  dropped: boolean;
  lastReleaseBlock: bigint;
  lastReceiptsHash: Hex;
};

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** An agent slot with no passkey has never been registered. */
export function isRegistered(state: AgentState): boolean {
  return state.qx !== ZERO32 || state.qy !== ZERO32;
}

// One client per (chain, rpc) so the app and MCP do not open a socket per call.
const clients = new Map<string, PublicClient>();

export function publicClient(ref: ChainRef): PublicClient {
  const cfg = resolveChain(ref);
  const cacheKey = `${cfg.id}:${cfg.rpcUrl}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) }) as PublicClient;
    clients.set(cacheKey, c);
  }
  return c;
}

export function walletClient(ref: ChainRef, privateKey: Hex): WalletClient<Transport, Chain, Account> {
  const cfg = resolveChain(ref);
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });
}

export async function readAgent(ref: ChainRef, agent: Address): Promise<AgentState> {
  const a = await publicClient(ref).readContract({
    address: requireVault(ref),
    abi: vaultAbi,
    functionName: 'getAgent',
    args: [agent],
  });
  return {
    qx: a.qx,
    qy: a.qy,
    token: a.token,
    balance: a.balance,
    nonce: a.nonce,
    dropped: a.dropped,
    lastReleaseBlock: a.lastReleaseBlock,
    lastReceiptsHash: a.lastReceiptsHash,
  };
}

/** Token balance of any address, in base units. Defaults to the chain's token. */
export async function walletBalance(ref: ChainRef, address: Address, token?: Address): Promise<bigint> {
  return publicClient(ref).readContract({
    address: token ?? resolveChain(ref).token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
}

// Simulate first so a revert surfaces as a decoded custom error (IsDropped,
// Expired, BadSignature) instead of a blind failed tx that still costs gas.
async function send(
  ref: ChainRef,
  relayerKey: Hex,
  call:
    | { functionName: 'release'; args: readonly [Address, bigint, bigint, Hex, WebAuthnAuth] }
    | { functionName: 'drop' | 'undrop'; args: readonly [Address, bigint, WebAuthnAuth] },
): Promise<Hex> {
  const pc = publicClient(ref);
  const wc = walletClient(ref, relayerKey);
  const { request } = await pc.simulateContract({
    address: requireVault(ref),
    abi: vaultAbi,
    account: wc.account,
    ...call,
  } as Parameters<typeof pc.simulateContract>[0]);
  const hash = await wc.writeContract(request as Parameters<typeof wc.writeContract>[0]);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${call.functionName} reverted: ${hash}`);
  return hash;
}

export function submitRelease(
  ref: ChainRef,
  relayerKey: Hex,
  p: { agent: Address; amount: bigint; expiry: bigint | number; receiptsHash: Hex; auth: WebAuthnAuth },
): Promise<Hex> {
  return send(ref, relayerKey, {
    functionName: 'release',
    args: [p.agent, p.amount, BigInt(p.expiry), p.receiptsHash, p.auth],
  });
}

export function submitDrop(
  ref: ChainRef,
  relayerKey: Hex,
  p: { agent: Address; expiry: bigint | number; auth: WebAuthnAuth },
): Promise<Hex> {
  return send(ref, relayerKey, { functionName: 'drop', args: [p.agent, BigInt(p.expiry), p.auth] });
}

export function submitUndrop(
  ref: ChainRef,
  relayerKey: Hex,
  p: { agent: Address; expiry: bigint | number; auth: WebAuthnAuth },
): Promise<Hex> {
  return send(ref, relayerKey, { functionName: 'undrop', args: [p.agent, BigInt(p.expiry), p.auth] });
}

export function authToJson(a: WebAuthnAuth): WebAuthnAuthJson {
  return { ...a, challengeIndex: a.challengeIndex.toString(), typeIndex: a.typeIndex.toString() };
}

export function authFromJson(a: WebAuthnAuthJson): WebAuthnAuth {
  return { ...a, challengeIndex: BigInt(a.challengeIndex), typeIndex: BigInt(a.typeIndex) };
}

export function agentStateToJson(
  chain: ChainKey,
  agent: Address,
  s: AgentState,
  wallet: bigint,
): AgentStateJson {
  return {
    chain,
    agent,
    qx: s.qx,
    qy: s.qy,
    token: s.token,
    balance: s.balance.toString(),
    nonce: s.nonce.toString(),
    dropped: s.dropped,
    lastReleaseBlock: s.lastReleaseBlock.toString(),
    lastReceiptsHash: s.lastReceiptsHash,
    walletBalance: wallet.toString(),
  };
}
