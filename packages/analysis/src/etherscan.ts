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

async function call<T>(params: Record<string, string>): Promise<T> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) throw new Error('ETHERSCAN_API_KEY is not set');

  const url = `${V2}?${new URLSearchParams({ ...params, apikey: key })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Etherscan HTTP ${res.status}`);

  const body = (await res.json()) as { status: string; message: string; result: T };
  if (body.status !== '1') throw new Error(`Etherscan: ${body.message}`);
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

/** Contract creation tx + creator address. Feeds the deployer-history signal. */
export async function fetchContractCreation(
  address: string,
  chainId: number,
): Promise<{ contractCreator: string; txHash: string } | null> {
  try {
    const result = await call<Array<{ contractCreator: string; txHash: string }>>({
      chainid: String(chainId),
      module: 'contract',
      action: 'getcontractcreation',
      contractaddresses: address,
    });
    return result[0] ?? null;
  } catch {
    return null;
  }
}
