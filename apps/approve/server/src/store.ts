// Requests live in memory and in one JSON file. The vault never trusts this
// file; it only saves the owner from re-reading the chain on every tap.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from '@preflight/capline';

/** Server-only extras kept beside the spec fields. */
export type StoredRequest = Request & {
  /** Quarantine rule ids the reason matched; shown as a warning. */
  reasonFlags?: string[];
  /** Last relay error, so the phone can show why approve failed. */
  error?: string;
};

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = process.env.APPROVE_DATA_FILE ?? join(here, '..', 'data', 'requests.json');

const requests = new Map<string, StoredRequest>();

export function load(): void {
  try {
    const list = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as StoredRequest[];
    for (const r of list) requests.set(r.id, r);
  } catch {
    // Missing or unreadable file: start empty rather than refuse to boot.
  }
}

function persist(): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  // Write then rename, so a crash mid-write never leaves half a file.
  writeFileSync(tmp, JSON.stringify([...requests.values()], null, 2));
  renameSync(tmp, DATA_FILE);
}

/** Pending requests past expiry can no longer land onchain; say so. */
function expire(r: StoredRequest, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if ((r.status === 'pending' || r.status === 'approved') && nowSec > r.expiry) {
    r.status = 'expired';
    return true;
  }
  return false;
}

export function expireAll(): void {
  let changed = false;
  for (const r of requests.values()) changed = expire(r) || changed;
  if (changed) persist();
}

export function get(id: string): StoredRequest | undefined {
  const r = requests.get(id);
  if (r && expire(r)) persist();
  return r;
}

export function list(filter: { agent?: string; chain?: string }): StoredRequest[] {
  expireAll();
  return [...requests.values()]
    .filter((r) => !filter.agent || r.agent.toLowerCase() === filter.agent.toLowerCase())
    .filter((r) => !filter.chain || r.chain === filter.chain)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function put(r: StoredRequest): void {
  requests.set(r.id, r);
  persist();
}
