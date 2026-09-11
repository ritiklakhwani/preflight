/**
 * PORTED from Inspector AI 2024
 *   packages/chrome-extension/background.js :: fetchAllTokenData (lines 110-148)
 *
 * Changes made during ETHOnline 2026:
 *   - API key moved from a hardcoded literal to the environment, and in the
 *     gate service to a Ledger Key Ring scoped key. The 2024 original had the
 *     key in plaintext at background.js:111, committed to a public repo.
 *   - Migrated to the Etherscan V2 unified endpoint (chainid param) so the
 *     same call works across chains.
 *   - Dropped the txlist fetch: The Graph standardized subgraphs give better
 *     protocol-level data than a raw transaction list ever could.
 */

const V2 = 'https://api.etherscan.io/v2/api';

/**
 * Etherscan's free tier allows three calls a second, and it says so in the
 * error rather than in a header. One verdict now makes up to five: source,
 * creation record, proxy implementation, deployer history, holder diversity.
 * Several of those were deliberately fired in parallel for latency, which is
 * exactly how the limit gets hit.
 *
 * A throttled request is slower. A rate-limited one silently becomes a signal
 * that could not run, and a verdict with fewer checks behind it, which is a
 * worse trade. This spaces every call in the process so that cannot happen.
 */
const MIN_CALL_INTERVAL_MS = 360;

/**
 * No request may hang for longer than this.
 *
 * There was no timeout here at all, and it cost us a live run. fetch() without
 * a signal waits indefinitely, so a slow Etherscan response blocked
 * preflight_check past the MCP client's 60 second limit. The agent got a
 * transport timeout instead of a verdict, which is the one answer shape this
 * project is built to avoid: not a finding, not an honest error, just nothing.
 *
 * Eight seconds is generous against a measured 0.3 to 1.9 seconds. A call that
 * exceeds it becomes a signal reporting it could not run, which the coverage
 * floor then accounts for.
 */
const CALL_TIMEOUT_MS = 8_000;
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_CALL_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // Keep the chain alive even when a call rejects, or one failure stalls
  // every request behind it.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface SourceCodeResult {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  Proxy: string;
  Implementation: string;
}

/** Etherscan puts the real reason in `result` when `message` is just NOTOK. */
function detail(body: { message: string; result: unknown }): string {
  const extra = typeof body.result === 'string' ? body.result.trim() : '';
  if (!extra) return body.message;
  return /notok/i.test(body.message) ? extra : `${body.message}: ${extra}`;
}

async function call<T>(params: Record<string, string>): Promise<T> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) {
    throw new Error(
      'ETHERSCAN_API_KEY is not set. One free key covers every chain: https://etherscan.io/apis',
    );
  }

  const url = `${V2}?${new URLSearchParams({ ...params, apikey: key })}`;
  const res = await throttle(() => fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }));
  if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);

  const body = (await res.json()) as { status: string; message: string; result: T };
  // On failure the useful text is in `result`, not `message`, which is only
  // ever "NOTOK". Plan and coverage errors are invisible otherwise.
  if (body.status !== '1') throw new Error(`Etherscan: ${detail(body)}`);
  return body.result;
}

export async function fetchContractSource(
  address: string,
  chainId: number,
): Promise<SourceCodeResult | null> {
  const result = await call<SourceCodeResult[]>({
    chainid: String(chainId),
    module: 'contract',
    action: 'getsourcecode',
    address,
  });
  const first = result[0];
  if (!first || !first.SourceCode) return null;
  return first;
}

/**
 * Three outcomes, deliberately distinguished.
 *
 * Etherscan answers a wallet address with status 0 and "No data found", which
 * is a fact about the address. A rate limit or a bad key also arrives as a
 * non-success status, which is a fact about us. Collapsing both into null,
 * as the first version of this did, makes every API hiccup look like the
 * caller is about to sign against a wallet.
 */
export type CreationResult =
  | { status: 'contract'; creator: string; txHash: string; createdAt: number; factory: string | null }
  | { status: 'not-a-contract' }
  | { status: 'error'; error: string };

interface RawCreation {
  contractCreator: string;
  txHash: string;
  timestamp?: string;
  contractFactory?: string;
}

/** Creator, creation time, and whether this is a contract at all. */
export async function fetchContractCreation(
  address: string,
  chainId: number,
): Promise<CreationResult> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) {
    return {
      status: 'error',
      error:
        'ETHERSCAN_API_KEY is not set. One free key covers every chain: https://etherscan.io/apis',
    };
  }

  const url = `${V2}?${new URLSearchParams({
    chainid: String(chainId),
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: address,
    apikey: key,
  })}`;

  try {
    const res = await throttle(() => fetch(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }));
    if (!res.ok) return { status: 'error', error: `Etherscan HTTP ${res.status}` };

    const body = (await res.json()) as {
      status: string;
      message: string;
      result: RawCreation[] | string | null;
    };

    if (body.status !== '1') {
      // "No data found" is the explorer telling us there is no creation
      // record, which is what an externally owned account looks like.
      if (/no data found/i.test(body.message)) return { status: 'not-a-contract' };
      return { status: 'error', error: `Etherscan: ${detail(body)}` };
    }

    const first = Array.isArray(body.result) ? body.result[0] : undefined;
    if (!first) return { status: 'not-a-contract' };

    return {
      status: 'contract',
      creator: first.contractCreator.toLowerCase(),
      txHash: first.txHash,
      createdAt: Number(first.timestamp ?? 0),
      factory: first.contractFactory ? first.contractFactory.toLowerCase() : null,
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What else this deployer has done.
 *
 * One call over the address's whole history, oldest first. The first entry
 * gives its age; contract creations anywhere in the window give what it has
 * shipped.
 *
 * This has been wrong twice, in opposite directions, and both were found by
 * checking a real address rather than by reading the code.
 *
 * The first version sampled the OLDEST 100 transactions and counted deploys in
 * those, so for any address with history the contract under review had been
 * deployed long after that window closed. It reported zero for a deployer that
 * had demonstrably deployed the contract being checked.
 *
 * The second sampled the NEWEST 100, which fixed that case and broke another.
 * ease.org's deployer shipped 38 contracts between April and November 2021 and
 * has transacted since, so a hundred-transaction window five years later saw
 * none of them. An external scanner flagged eight of those 38 as honeypots
 * while we reported the deployer as clean.
 *
 * A wide window costs one request either way, so there is no reason to guess
 * which end of the history matters.
 */
export type DeployerResult =
  | {
      status: 'ok';
      /** Unix seconds of the deployer's first ever transaction. */
      firstSeen: number;
      /** Contract creations found in the sampled window. */
      deployments: number;
      /** How many transactions were sampled. */
      sampled: number;
      /** True when the window filled, so the counts are floors. */
      truncated: boolean;
      /** Unix seconds of the most recent deployment, when there is one. */
      lastDeployedAt: number | null;
    }
  | { status: 'error'; error: string };

/** Etherscan caps a page well below this; asking for more costs nothing. */
const DEPLOYER_PAGE = 1000;

interface RawTx {
  to: string;
  timeStamp: string;
  contractAddress: string;
}

export async function fetchDeployerProfile(
  creator: string,
  chainId: number,
): Promise<DeployerResult> {
  try {
    const txs = await call<RawTx[]>({
      chainid: String(chainId),
      module: 'account',
      action: 'txlist',
      address: creator,
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: String(DEPLOYER_PAGE),
      sort: 'asc',
    });

    // A contract creation has an empty `to` and returns the created address.
    const deploys = txs.filter((t) => !t.to && t.contractAddress);
    const last = deploys[deploys.length - 1];

    return {
      status: 'ok',
      firstSeen: Number(txs[0]?.timeStamp ?? 0),
      deployments: deploys.length,
      sampled: txs.length,
      truncated: txs.length >= DEPLOYER_PAGE,
      lastDeployedAt: last ? Number(last.timeStamp) : null,
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * How widely a token is actually held.
 *
 * Etherscan's holder-count endpoint is Pro-only, but transfer history is free,
 * and unique addresses across a recent window separates a distributed token
 * from a closed loop just as well. Measured against tokens whose character was
 * confirmed by hand on 2026-09-09:
 *
 *   FDUSD   57 unique per 100 transfers   real, 4,252 holders
 *   sUSDat  45                            real, 1,259 holders
 *   ONJAI   11 per 64                     dead, 9 holders
 *   MEX      8 per 100                    dead, 14 holders
 *   DOTT     7 per 15                     throwaway, 3 holders
 *
 * The gap between 11 and 45 has nothing in it. MEX is the sharpest case: a
 * hundred transfers circulating among eight addresses is how a $104m volume
 * figure gets manufactured without anyone ever buying the token.
 */
export type HolderResult =
  | {
      status: 'ok';
      sampled: number;
      uniqueAddresses: number;
      /**
       * Wall-clock seconds between the oldest and newest transfer in the
       * sample. A fixed count of transfers means very different things on
       * chains with different block times, and this is what tells them apart.
       */
      spanSeconds: number;
    }
  | { status: 'error'; error: string };

const HOLDER_SAMPLE = 100;

export async function fetchHolderDiversity(
  token: string,
  chainId: number,
): Promise<HolderResult> {
  try {
    // timeStamp comes back on this response already. Reading it costs nothing
    // and is what makes the sample interpretable across chains.
    const txs = await call<Array<{ from: string; to: string; timeStamp?: string }>>({
      chainid: String(chainId),
      module: 'account',
      action: 'tokentx',
      contractaddress: token,
      page: '1',
      offset: String(HOLDER_SAMPLE),
      sort: 'desc',
    });

    const addresses = new Set<string>();
    const times: number[] = [];
    for (const t of txs) {
      if (t.from) addresses.add(t.from.toLowerCase());
      if (t.to) addresses.add(t.to.toLowerCase());
      const ts = Number(t.timeStamp);
      if (Number.isFinite(ts) && ts > 0) times.push(ts);
    }

    return {
      status: 'ok',
      sampled: txs.length,
      uniqueAddresses: addresses.size,
      spanSeconds: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
