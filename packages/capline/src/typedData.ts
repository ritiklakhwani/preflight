import { hashTypedData, type Address, type Hex } from 'viem';
import { resolveChain, type ChainRef } from './chains.js';

// Must match CaplineVault's EIP712("CaplineVault", "1").
export const DOMAIN_NAME = 'CaplineVault';
export const DOMAIN_VERSION = '1';

export const caplineTypes = {
  Release: [
    { name: 'agent', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'receiptsHash', type: 'bytes32' },
  ],
  Drop: [
    { name: 'agent', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
  Undrop: [
    { name: 'agent', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
  Withdraw: [
    { name: 'agent', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

type Int = bigint | number;

/** `chain` may be a key, a config, or a raw chain id (tests, other chains). */
interface Base {
  chain: ChainRef | number;
  vault: Address;
  agent: Address;
  nonce: Int;
  expiry: Int;
}
export interface ReleaseParams extends Base {
  amount: Int;
  receiptsHash: Hex;
}
export type DropParams = Base;
export type UndropParams = Base;
export interface WithdrawParams extends Base {
  to: Address;
  amount: Int;
}

function domain(chain: ChainRef | number, vault: Address) {
  const chainId = typeof chain === 'number' ? chain : resolveChain(chain).id;
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: vault } as const;
}

export function releaseTypedData(p: ReleaseParams) {
  return {
    domain: domain(p.chain, p.vault),
    types: { Release: caplineTypes.Release },
    primaryType: 'Release' as const,
    message: {
      agent: p.agent,
      amount: BigInt(p.amount),
      nonce: BigInt(p.nonce),
      expiry: BigInt(p.expiry),
      receiptsHash: p.receiptsHash,
    },
  };
}

export function dropTypedData(p: DropParams) {
  return {
    domain: domain(p.chain, p.vault),
    types: { Drop: caplineTypes.Drop },
    primaryType: 'Drop' as const,
    message: { agent: p.agent, nonce: BigInt(p.nonce), expiry: BigInt(p.expiry) },
  };
}

export function undropTypedData(p: UndropParams) {
  return {
    domain: domain(p.chain, p.vault),
    types: { Undrop: caplineTypes.Undrop },
    primaryType: 'Undrop' as const,
    message: { agent: p.agent, nonce: BigInt(p.nonce), expiry: BigInt(p.expiry) },
  };
}

export function withdrawTypedData(p: WithdrawParams) {
  return {
    domain: domain(p.chain, p.vault),
    types: { Withdraw: caplineTypes.Withdraw },
    primaryType: 'Withdraw' as const,
    message: {
      agent: p.agent,
      to: p.to,
      amount: BigInt(p.amount),
      nonce: BigInt(p.nonce),
      expiry: BigInt(p.expiry),
    },
  };
}

// The 32-byte digest is the WebAuthn challenge the passkey signs.
export const releaseDigest = (p: ReleaseParams): Hex => hashTypedData(releaseTypedData(p));
export const dropDigest = (p: DropParams): Hex => hashTypedData(dropTypedData(p));
export const undropDigest = (p: UndropParams): Hex => hashTypedData(undropTypedData(p));
export const withdrawDigest = (p: WithdrawParams): Hex => hashTypedData(withdrawTypedData(p));
