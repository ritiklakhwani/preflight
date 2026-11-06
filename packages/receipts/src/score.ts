import { getAddress, isAddress } from 'viem';
import type { Verdict as EngineVerdict } from '@preflight/core';
import { CHAINS, publicClient } from './chains.js';
import type { ChainKey, Hex, Score } from './types.js';

export const SCORE_TIMEOUT_MS = 20_000;
const EXPLORER_TIMEOUT_MS = 8_000;
const WALLET: Score = { verdict: 'unknown', reasons: ['wallet, not a contract'] };

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Risk verdict for one counterparty. Never throws, never exceeds SCORE_TIMEOUT_MS. */
export async function scoreCounterparty(chain: ChainKey, address: string): Promise<Score> {
  if (!isAddress(address)) return { verdict: 'unknown', reasons: ['not an address'] };
  const a = getAddress(address);
  const work = chain === 'base' ? scoreBase(a) : scoreWhitechain(a);
  return withTimeout(work, SCORE_TIMEOUT_MS, {
    verdict: 'unknown',
    reasons: [`scoring timed out after ${SCORE_TIMEOUT_MS / 1000}s`],
  });
}

export async function withTimeout(p: Promise<Score>, ms: number, onTimeout: Score): Promise<Score> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Score>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      p.catch((err: unknown): Score => ({
        verdict: 'unknown',
        reasons: [`scoring failed: ${short(err instanceof Error ? err.message : String(err))}`],
      })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function short(s: string, n = 90): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}

function knownLabel(chain: ChainKey, a: Hex): string | null {
  const info = CHAINS[chain];
  if (a === info.token) return chain === 'whitechain' ? 'known token: Whitechain USDT' : 'known token: USDC';
  if (a === info.vault()) return 'Capline vault';
  return null;
}

// ---------------------------------------------------------------------------
// Base: the Preflight engine
// ---------------------------------------------------------------------------

async function scoreBase(a: Hex): Promise<Score> {
  const known = knownLabel('base', a);
  if (known) return { verdict: 'clean', reasons: [known] };

  const code = await publicClient('base').getCode({ address: a });
  if (!code || code === '0x') return WALLET;

  // Lazy so the Whitechain path never loads pg, the analysis stack or the gate.
  const { runPreflight } = await import('@preflight/engine');
  // No-op store: a receipts build must not wait on Postgres or fill it with
  // one row per counterparty per refill request.
  const v = await runPreflight(a, 8453, {
    gate: false,
    store: {
      kind: 'memory',
      save: async () => {},
      get: async () => null,
      recent: async () => [],
      close: async () => {},
    },
  });
  return mapEngineVerdict(v);
}

/** Engine verdict to receipts verdict. Pure, so it is unit tested without network. */
export function mapEngineVerdict(
  v: Pick<EngineVerdict, 'severity' | 'signals' | 'coverage'> & {
    analysis?: Pick<EngineVerdict['analysis'], 'isContract'>;
  },
): Score {
  if (v.analysis?.isContract === false) return WALLET;

  const { ran, total } = v.coverage;
  // Same threshold as @preflight/core MIN_COVERAGE. An outage must not read as clean.
  if (total === 0 || ran / total < 0.6) {
    const reasons = [`Preflight inconclusive: ${ran} of ${total} checks ran`];
    const firstError = v.signals.find((s) => s.error)?.error;
    if (firstError) reasons.push(short(firstError));
    return { verdict: 'unknown', reasons };
  }

  const fired = v.signals.filter((s) => s.fired).sort((x, y) => y.weight - x.weight);
  if (fired.length === 0) {
    return { verdict: v.severity, reasons: [`no risk signals fired (${ran} of ${total} checks)`] };
  }
  return { verdict: v.severity, reasons: fired.slice(0, 3).map((s) => s.name.replace(/-/g, ' ')) };
}

// ---------------------------------------------------------------------------
// Whitechain: RPC plus Blockscout
// ---------------------------------------------------------------------------

/** Everything the Whitechain rule looks at. Null means "could not find out". */
export interface WhitechainFacts {
  known?: string | null;
  hasCode: boolean | null;
  verified: boolean | null;
  createdAt: number | null; // unix seconds
  deployer: string | null;
  txCount: number | null;
  isScam?: boolean;
}

async function explorerJson(path: string): Promise<unknown> {
  try {
    const res = await fetch(`${CHAINS.whitechain.explorer}${path}`, {
      signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);

export async function whitechainFacts(a: Hex): Promise<WhitechainFacts> {
  const known = knownLabel('whitechain', a);
  const client = publicClient('whitechain');

  let hasCode: boolean | null = null;
  try {
    const code = await client.getCode({ address: a });
    hasCode = !!code && code !== '0x';
  } catch {
    hasCode = null;
  }
  if (hasCode === false || known) {
    return { known, hasCode, verified: null, createdAt: null, deployer: null, txCount: null };
  }

  // Blockscout v2 is_verified is missing on proxies whose implementation is
  // verified, while the Etherscan-style getsourcecode resolves the proxy and
  // returns the implementation's source. Ask both and take either.
  const [addrInfo, counters, source, creation] = await Promise.all([
    explorerJson(`/api/v2/addresses/${a}`),
    explorerJson(`/api/v2/addresses/${a}/counters`),
    explorerJson(`/api?module=contract&action=getsourcecode&address=${a}`),
    explorerJson(`/api?module=contract&action=getcontractcreation&contractaddresses=${a}`),
  ]);

  const info = obj(addrInfo);
  const src = obj(source);
  const srcRow = Array.isArray(src?.['result']) ? obj((src['result'] as unknown[])[0]) : null;
  const cre = obj(creation);
  const creRow = Array.isArray(cre?.['result']) ? obj((cre['result'] as unknown[])[0]) : null;

  let verified: boolean | null = null;
  if (info || srcRow) {
    const sourceCode = typeof srcRow?.['SourceCode'] === 'string' ? (srcRow['SourceCode'] as string) : '';
    verified = info?.['is_verified'] === true || sourceCode.length > 0;
  }

  let createdAt: number | null = null;
  const ts = Number(creRow?.['timestamp']);
  if (Number.isFinite(ts) && ts > 0) createdAt = ts;

  const deployerRaw = (creRow?.['contractCreator'] ?? info?.['creator_address_hash']) as string | undefined;
  const deployer = deployerRaw && isAddress(deployerRaw) ? getAddress(deployerRaw) : null;

  // Creation timestamp missing from the explorer: read it from the chain.
  const creationTx = (creRow?.['txHash'] ?? info?.['creation_transaction_hash']) as Hex | undefined;
  if (createdAt === null && creationTx) {
    try {
      const r = await client.getTransactionReceipt({ hash: creationTx });
      const b = await client.getBlock({ blockNumber: r.blockNumber });
      createdAt = Number(b.timestamp);
    } catch {
      // age stays unknown
    }
  }

  const tc = Number(obj(counters)?.['transactions_count']);
  return {
    known,
    hasCode,
    verified,
    createdAt,
    deployer,
    txCount: Number.isFinite(tc) ? tc : null,
    isScam: info?.['is_scam'] === true,
  };
}

function fmtAge(seconds: number): string {
  if (seconds < HOUR) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < DAY) return `${Math.round(seconds / HOUR)}h`;
  return `${Math.round(seconds / DAY)} days`;
}

function fmtAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

/**
 * The Whitechain rule. Pure so it is unit tested.
 * Unverified and younger than 24h is high (the spec's hard rule). Unverified
 * and older, or of unknown age, is medium. Verified is low, or clean when it
 * is at least a week old and has seen 100+ transactions.
 */
export function whitechainVerdict(f: WhitechainFacts, now = Math.floor(Date.now() / 1000)): Score {
  if (f.known) return { verdict: 'clean', reasons: [f.known] };
  if (f.hasCode === null) return { verdict: 'unknown', reasons: ['could not read code from RPC'] };
  if (f.hasCode === false) return WALLET;
  if (f.isScam) return { verdict: 'high', reasons: ['explorer flags this address as a scam'] };
  if (f.verified === null) {
    return { verdict: 'unknown', reasons: ['contract; explorer unreachable, source and age unchecked'] };
  }

  const age = f.createdAt !== null ? Math.max(0, now - f.createdAt) : null;
  const ageReason = age === null ? 'contract age unknown' : `deployed ${fmtAge(age)} ago`;
  const deployerReason = f.deployer ? `deployer ${fmtAddr(f.deployer)}` : null;

  if (!f.verified) {
    const reasons = ['unverified contract', ageReason, ...(deployerReason ? [deployerReason] : [])];
    if (age !== null && age < DAY) return { verdict: 'high', reasons };
    return { verdict: 'medium', reasons };
  }

  if (age !== null && age >= 7 * DAY && (f.txCount ?? 0) >= 100) {
    return { verdict: 'clean', reasons: ['verified source', ageReason, `${f.txCount} transactions`] };
  }
  const activity = f.txCount !== null ? `${f.txCount} transactions` : deployerReason;
  return { verdict: 'low', reasons: ['verified source', ageReason, ...(activity ? [activity] : [])] };
}

async function scoreWhitechain(a: Hex): Promise<Score> {
  return whitechainVerdict(await whitechainFacts(a));
}
