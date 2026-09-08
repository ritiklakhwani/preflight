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
  taint: TaintEvent[];
  gate?: {
    required: boolean;
    approved: boolean;
    method: 'auto' | 'device';
  };
  hcs?: {
    topicId: string;
    sequenceNumber: number;
    hashscanUrl: string;
  };
  createdAt: string;
}
