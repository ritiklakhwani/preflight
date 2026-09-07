/**
 * NEW during ETHOnline 2026.
 *
 * The 2024 build fetched the ABI and handed it straight to the model.
 * These checks are deterministic and run before any LLM call, so the
 * structural half of the verdict never depends on model output.
 */
import type { AnalysisResult } from '@preflight/core';
import type { SourceCodeResult } from './etherscan.js';

type AbiEntry = { type?: string; name?: string; stateMutability?: string };

const OWNER_HINTS = /only(owner|admin|role)|_checkowner|accesscontrol|ownable/i;
const DANGEROUS = [
  'mint', 'burnfrom', 'pause', 'unpause', 'blacklist', 'setfee', 'settax',
  'withdraw', 'rescue', 'sweep', 'setmaxtx', 'excludefromfee', 'upgradeto',
];

export function structural(src: SourceCodeResult | null): Pick<
  AnalysisResult,
  'verified' | 'contractName' | 'compilerVersion' | 'isProxy' |
  'ownerOnlyFunctions' | 'hasSelfDestruct' | 'hasTransferRestrictions'
> {
  if (!src) {
    return {
      verified: false, contractName: null, compilerVersion: null, isProxy: false,
      ownerOnlyFunctions: [], hasSelfDestruct: false, hasTransferRestrictions: false,
    };
  }

  const code = src.SourceCode ?? '';
  let abi: AbiEntry[] = [];
  try { abi = JSON.parse(src.ABI) as AbiEntry[]; } catch { /* unverified or proxy */ }

  const writeFns = abi
    .filter((e) => e.type === 'function' && e.stateMutability !== 'view' && e.stateMutability !== 'pure')
    .map((e) => e.name ?? '')
    .filter(Boolean);

  const ownerOnlyFunctions = writeFns.filter((n) =>
    DANGEROUS.some((d) => n.toLowerCase().includes(d)),
  );

  return {
    verified: true,
    contractName: src.ContractName || null,
    compilerVersion: src.CompilerVersion || null,
    isProxy: src.Proxy === '1' || /delegatecall|erc1967|transparentupgradeable/i.test(code),
    ownerOnlyFunctions: OWNER_HINTS.test(code) ? ownerOnlyFunctions : [],
    hasSelfDestruct: /selfdestruct|suicide\s*\(/i.test(code),
    hasTransferRestrictions:
      /require\s*\([^)]*(blacklist|blocked|banned|_canTransfer|tradingEnabled|isBot)/i.test(code),
  };
}
