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

// Privileged-modifier vocabulary. `onlyOwner` alone is not enough: USDC's proxy
// gates upgradeTo on `onlyAdmin`, MakerDAO uses `auth`, OZ v5 uses `_checkOwner`.
const OWNER_HINTS =
  /(only|if)(Owner|Admin|Role|Governance|Operator|Minter|Manager)|_checkOwner|AccessControl|Ownable|\bauth\b|require\s*\(\s*msg\.sender\s*==\s*(owner|admin)/i;
const DANGEROUS = [
  'mint', 'burnfrom', 'pause', 'unpause', 'blacklist', 'setfee', 'settax',
  'withdraw', 'rescue', 'sweep', 'setmaxtx', 'excludefromfee', 'upgradeto',
];

export function structural(src: SourceCodeResult | null): Pick<
  AnalysisResult,
  'verified' | 'contractName' | 'compilerVersion' | 'isProxy' | 'implementationAddress' |
  'isErc20' | 'ownerOnlyFunctions' | 'hasSelfDestruct' | 'hasTransferRestrictions'
> {
  if (!src) {
    return {
      verified: false, contractName: null, compilerVersion: null, isProxy: false,
      implementationAddress: null, isErc20: false,
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

  const implementation = /^0x[a-fA-F0-9]{40}$/.test(src.Implementation ?? '')
    ? src.Implementation
    : null;

  // The ERC-20 surface. A proxy's own ABI will not have these even when the
  // token behind it does, which mergeProxy resolves by OR-ing the two reads.
  const abiNames = new Set(abi.map((e) => (e.name ?? '').toLowerCase()));
  const isErc20 = ['transfer', 'balanceof', 'totalsupply', 'approve'].every((n) =>
    abiNames.has(n),
  );

  return {
    verified: true,
    contractName: src.ContractName || null,
    compilerVersion: src.CompilerVersion || null,
    isProxy: src.Proxy === '1' || /delegatecall|erc1967|transparentupgradeable/i.test(code),
    implementationAddress: implementation,
    isErc20,
    ownerOnlyFunctions: OWNER_HINTS.test(code) ? ownerOnlyFunctions : [],
    hasSelfDestruct: /selfdestruct|suicide\s*\(/i.test(code),
    hasTransferRestrictions:
      /require\s*\([^)]*(blacklist|blocked|banned|_canTransfer|tradingEnabled|isBot)/i.test(code),
  };
}

type Structural = ReturnType<typeof structural>;

/**
 * Unions a proxy's structural facts with its implementation's.
 *
 * Reading only the proxy sees the upgrade authority and no behaviour. Reading
 * only the implementation sees the behaviour and no upgrade authority. A
 * signer needs both, so privileged functions are concatenated and the boolean
 * risks are OR-ed. The proxy keeps naming rights because that is the address
 * the user is actually about to interact with.
 */
export function mergeProxy(proxy: Structural, impl: Structural): Structural {
  return {
    verified: proxy.verified,
    contractName: proxy.contractName,
    compilerVersion: impl.compilerVersion ?? proxy.compilerVersion,
    isProxy: true,
    implementationAddress: proxy.implementationAddress,
    isErc20: proxy.isErc20 || impl.isErc20,
    ownerOnlyFunctions: [...new Set([...proxy.ownerOnlyFunctions, ...impl.ownerOnlyFunctions])],
    hasSelfDestruct: proxy.hasSelfDestruct || impl.hasSelfDestruct,
    hasTransferRestrictions: proxy.hasTransferRestrictions || impl.hasTransferRestrictions,
  };
}
