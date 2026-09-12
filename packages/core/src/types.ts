/** Severity ladder. Deterministic, derived from signal weights - never from the LLM. */
export type Severity = 'clean' | 'low' | 'medium' | 'high';

/** One checkable fact behind a signal. `link` should open on a block explorer. */
export interface Evidence {
  label: string;
  value: string;
  link?: string;
  /**
   * True when `value` carries data the reviewed contract's author controls: a
   * contract name, an ABI function name, explorer metadata. Only these get
   * delimited before they reach a model. Our own prose does not, because a
   * marker applied to everything marks nothing.
   */
  untrusted?: boolean;
}

export interface SignalResult {
  name: string;
  fired: boolean;
  /** 0-1. Contribution to the score when fired. */
  weight: number;
  evidence: Evidence[];
  /** A signal that throws records the error and does not fail the verdict. */
  error?: string;
  /**
   * False when the check could not be performed at all, as opposed to being
   * performed and finding nothing.
   *
   * The distinction is not cosmetic. On an unverified contract the three
   * source-dependent checks cannot look, and they were being listed as
   * "found nothing" alongside checks that genuinely had. That reads as a
   * clean bill of health on exactly the category of address least deserving
   * of one.
   *
   * These stay out of the error path on purpose: an unverified contract is a
   * finding about the contract, not an outage on our side, and
   * `unverified-source` already fires and carries the weight. This flag only
   * stops the others from being reported as reassurance.
   */
  assessed?: boolean;
}

/** A string field from an untrusted source that matched one or more injection rules. */
export interface TaintEvent {
  /** e.g. "pools[0].inputTokens[1].name" */
  fieldPath: string;
  /** which subgraph / API it came from */
  source: string;
  raw: string;
  action: 'passed' | 'delimited' | 'stripped';
  matchedRules: string[];
}

/** Ported from Inspector AI 2024: Etherscan source + ABI, plus the LLM read of it. */
export interface AnalysisResult {
  verified: boolean;
  contractName: string | null;
  compilerVersion: string | null;
  isProxy: boolean;
  /**
   * For a proxy, the implementation it currently delegates to. Structural
   * checks are run against both and merged: the proxy holds the upgrade
   * authority, the implementation holds the behaviour, and reading only one
   * of them misses half of what a signer needs to know.
   */
  implementationAddress: string | null;
  /**
   * Whether the ABI carries the ERC-20 surface. Market signals only mean
   * something for tokens: "no Uniswap pool holds this" is a finding about a
   * token and noise about a lending pool or an NFT contract.
   */
  isErc20: boolean;
  /**
   * False when the explorer has no creation record, which means the address is
   * a wallet rather than a contract. Null when we could not check.
   */
  isContract: boolean | null;
  /** The address that deployed this contract. Feeds deployer-history. */
  creator: string | null;
  /** Function names gated on an owner/admin role, parsed from the ABI. */
  ownerOnlyFunctions: string[];
  hasSelfDestruct: boolean;
  hasTransferRestrictions: boolean;
  /** LLM prose. Never used for the risk decision - only for the human summary. */
  llmSummary: string;
  /** 2024 taxonomy carried forward: High Risk | Moderate Risk | Low Risk */
  llmRiskLabel: 'High Risk' | 'Moderate Risk' | 'Low Risk' | 'Unknown';
  llmRiskNotes: string[];
  /**
   * Non-fatal degradations, such as a proxy whose implementation could not be
   * read. The verdict still stands but is shallower than usual, and the caller
   * is told so rather than left to assume full coverage. Distinct from
   * `error`, which means the analysis did not produce a usable result.
   */
  notes?: string[];
  error?: string;
}

export interface Verdict {
  id: string;
  address: string;
  chainId: number;
  severity: Severity;
  /** 0-100, deterministic. */
  score: number;
  summary: string;
  analysis: AnalysisResult;
  signals: SignalResult[];
  /**
   * How much of the signal set actually ran.
   *
   * Without this, a rate-limited explorer produces a verdict where every
   * signal errored, none fired, and the score is 0. That renders as "no risk
   * signals fired", which an agent reads as safe. An outage must never be
   * presentable as a clean bill of health.
   */
  coverage: { ran: number; total: number };
  taint: TaintEvent[];
  /**
   * The hardware confirmation. Present only when the caller asked for one.
   *
   * `approved: false` means the action must not proceed, whatever the reason:
   * declined on the device, no device attached, wallet-cli missing, timed out.
   * Every one of those is a refusal.
   */
  gate?: {
    required: boolean;
    approved: boolean;
    method: 'auto' | 'device';
    reason?: string;
  };
  createdAt: string;
}
