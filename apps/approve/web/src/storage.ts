// localStorage holds public data only, plus a gas-only burner key that never
// controls funds: the vault pays the agent, never the relayer.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from './webauthn.js';
import type { ChainKey } from './config.js';

const K = { passkey: 'capline.passkey', agents: 'capline.agents', burner: 'capline.burner' } as const;

function read<T>(key: string): T | undefined {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the app still works for this session.
  }
}

export interface StoredPasskey {
  credentialId: string; // base64url
  qx: Hex;
  qy: Hex;
  rpId: string;
  createdAt: number;
}

export const getPasskey = () => read<StoredPasskey>(K.passkey);
export const setPasskey = (p: StoredPasskey | undefined) => write(K.passkey, p);

export interface KnownAgent {
  chain: ChainKey;
  agent: `0x${string}`;
}

export const getAgents = () => read<KnownAgent[]>(K.agents) ?? [];

export function rememberAgent(a: KnownAgent): void {
  const list = getAgents().filter((x) => !(x.chain === a.chain && x.agent.toLowerCase() === a.agent.toLowerCase()));
  write(K.agents, [a, ...list].slice(0, 10));
}

export function forgetAgent(a: KnownAgent): void {
  write(K.agents, getAgents().filter((x) => !(x.chain === a.chain && x.agent.toLowerCase() === a.agent.toLowerCase())));
}

/** A local key that only pays gas for direct submissions when the server is down. */
export function getBurner(): { key: Hex; address: `0x${string}` } {
  let key = read<Hex>(K.burner);
  if (!key) {
    key = generatePrivateKey();
    write(K.burner, key);
  }
  return { key, address: privateKeyToAccount(key).address };
}

export function resetBurner(): void {
  write(K.burner, undefined);
}
