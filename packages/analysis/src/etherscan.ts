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
  if (!key) throw new Error('ETHERSCAN_API_KEY is not set');

  const url = `${V2}?${new URLSearchParams({ ...params, apikey: key })}`;
  const res = await fetch(url);
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
  if (!key) return { status: 'error', error: 'ETHERSCAN_API_KEY is not set' };

  const url = `${V2}?${new URLSearchParams({
    chainid: String(chainId),
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: address,
    apikey: key,
  })}`;

  try {
    const res = await fetch(url);
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
 * The scam-factory pattern is an address that appeared recently and has
 * already shipped a handful of contracts. A deployer with years of history
 * behind it is not proof of anything, but it is a different risk profile, and
 * it is knowable before signing.
 *
 * Two calls, because they need opposite ends of the history. The first
 * transaction ever gives the address's age. The most recent transactions give
 * what it is doing now.
 *
 * The first version asked for the oldest 100 transactions and counted
 * deployments in those, which is structurally wrong: for any address with
 * history, the contract under review was deployed long after that window
 * closed. It reported zero deployments for a deployer that had demonstrably
 * deployed the contract being checked.
 */
export type DeployerResult =
  | {
      status: 'ok';
      /** Unix seconds of the deployer's first ever transaction. */
      firstSeen: number;
      /** Contract creations within the most recent sampled transactions. */
      deployments: number;
      /** How many transactions were sampled for that count. */
      sampled: number;
      /** True when the window filled, so `deployments` is a floor. */
      truncated: boolean;
    }
  | { status: 'error'; error: string };

const DEPLOYER_PAGE = 100;

interface RawTx {
  to: string;
  timeStamp: string;
  contractAddress: string;
}

export async function fetchDeployerProfile(
  creator: string,
  chainId: number,
): Promise<DeployerResult> {
  const base = {
    chainid: String(chainId),
    module: 'account',
    action: 'txlist',
    address: creator,
    startblock: '0',
    endblock: '99999999',
    page: '1',
  };

  try {
    const [oldest, recent] = await Promise.all([
      call<RawTx[]>({ ...base, offset: '1', sort: 'asc' }),
      call<RawTx[]>({ ...base, offset: String(DEPLOYER_PAGE), sort: 'desc' }),
    ]);

    // A contract creation has an empty `to` and returns the created address.
    const deployments = recent.filter((t) => !t.to && t.contractAddress).length;

    return {
      status: 'ok',
      firstSeen: Number(oldest[0]?.timeStamp ?? 0),
      deployments,
      sampled: recent.length,
      truncated: recent.length >= DEPLOYER_PAGE,
    };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
