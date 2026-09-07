/** Severity ladder. Deterministic, derived from signal weights - never from the LLM. */
export type Severity = 'clean' | 'low' | 'medium' | 'high';

/** One checkable fact behind a signal. `link` should open on a block explorer. */
export interface Evidence {
  label: string;
  value: string;
  link?: string;
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
  /** Function names gated on an owner/admin role, parsed from the ABI. */
  ownerOnlyFunctions: string[];
  hasSelfDestruct: boolean;
  hasTransferRestrictions: boolean;
  /** LLM prose. Never used for the risk decision - only for the human summary. */
  llmSummary: string;
  /** 2024 taxonomy carried forward: High Risk | Moderate Risk | Low Risk */
  llmRiskLabel: 'High Risk' | 'Moderate Risk' | 'Low Risk' | 'Unknown';
  llmRiskNotes: string[];
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
