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
//
// The final alternative is deliberately generic. Naming the roles it compares
// against missed UNI, which gates mint on `require(msg.sender == minter)`.
// Any equality test on msg.sender is an access control gate whatever the
// variable is called, so matching the construct beats enumerating the names.
const OWNER_HINTS =
  /(only|if)(Owner|Admin|Role|Governance|Operator|Minter|Manager)|_checkOwner|AccessControl|Ownable|\bauth\b|require\s*\(\s*msg\.sender\s*==/i;
const DANGEROUS = [
  'mint', 'burnfrom', 'pause', 'unpause', 'blacklist', 'setfee', 'settax',
  'withdraw', 'rescue', 'sweep', 'setmaxtx', 'excludefromfee', 'upgradeto',
];

/**
 * Transfers can be stopped two ways, and the first version of this only knew
 * about one of them.
 *
 * Per-address gating: a mapping consulted on the transfer path. This is what
 * USDC and USDT do, and matching the vocabulary works because the names are
 * conventional.
 */
const ADDRESS_GATE =
  /require\s*\([^)]*(blacklist|blocklist|denylist|blocked|banned|frozen|_canTransfer|tradingEnabled|isBot)/i;

/**
 * Global halt: a pause flag consulted on the transfer path. This is the more
 * common mechanism of the two, and we matched none of it. WBTC guards its
 * `transfer` with OpenZeppelin's `whenNotPaused` modifier and an owner can
 * call `pause`, so every holder can be frozen at once, and the signal stayed
 * silent.
 *
 * Both patterns below require the guard to sit on a transfer entry point.
 * Checking for `whenNotPaused` anywhere in the file would fire on contracts
 * that only pause an admin function, which is not a risk to a holder.
 *
 * This is the third time enumerating vocabulary has missed a real case, after
 * `msg.sender == minter` on UNI. Match the construct.
 */
const PAUSABLE_TRANSFER =
  /function\s+(transfer|transferFrom|_update|_beforeTokenTransfer)\s*\([^)]*\)[^{;]*\bwhenNotPaused\b/i;
const INLINE_PAUSE_CHECK = /require\s*\(\s*!\s*(paused|_paused)\b/i;

function canHaltTransfers(code: string): boolean {
  return PAUSABLE_TRANSFER.test(code) || INLINE_PAUSE_CHECK.test(code);
}

/**
 * A transfer hook that constrains who may send or receive.
 *
 * The third mechanism, and the one that produced the sharpest miss. Both
 * patterns above look for blocklists: named lists of addresses that may not
 * trade. This looks for the inverse, an allowlist, which is strictly worse for
 * a holder and reads nothing like a blacklist in source.
 *
 * ease.org, which our own demo scores HIGH for other reasons, contains:
 *
 *   function _beforeTokenTransfer(address from, address to, uint256 amount)
 *     internal virtual override {
 *       require(from == owner || to == owner, "Only owner may interact");
 *   }
 *
 * Buy it and you cannot sell to anyone but the deployer. That is a honeypot in
 * the purest sense and transfer-restrictions reported the token clean.
 *
 * Vocabulary cannot find this, because there is no vocabulary: it is an
 * ordinary require on ordinary parameter names. So this walks the transfer-path
 * hooks and looks for a require that constrains `from` or `to`, discarding the
 * zero-address guard that every OpenZeppelin token carries in the same place.
 */
const TRANSFER_HOOKS =
  /function\s+(_beforeTokenTransfer|_afterTokenTransfer|_update|_transfer)\s*\([^)]*\)[^{]*\{[\s\S]{0,800}?\n\s*\}/gi;
const PARTY_NAMES = /\b(from|to|sender|recipient|_from|_to|src|dst)\b/i;
/** `require(to != address(0))` is boilerplate, not a restriction. */
const ZERO_ADDRESS_GUARD = /address\s*\(\s*0\s*\)|!=\s*0\b|== address\(0\)/i;

function restrictsParties(code: string): boolean {
  const hooks = code.match(TRANSFER_HOOKS) ?? [];
  for (const body of hooks) {
    for (const clause of body.match(/require\s*\([^;]*\)/gi) ?? []) {
      if (ZERO_ADDRESS_GUARD.test(clause)) continue;
      if (PARTY_NAMES.test(clause)) return true;
    }
  }
  return false;
}

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
      ADDRESS_GATE.test(code) || canHaltTransfers(code) || restrictsParties(code),
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
