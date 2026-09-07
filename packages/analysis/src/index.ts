import type { AnalysisResult } from '@preflight/core';
import { fetchContractSource, fetchContractCreation } from './etherscan.js';
import { structural } from './structural.js';
import { llmReview } from './llm.js';

export { fetchContractSource, fetchContractCreation } from './etherscan.js';
export type { SourceCodeResult } from './etherscan.js';

/**
 * The single entry point the rest of Preflight uses.
 * Structural checks are deterministic and always run.
 * The LLM pass is best-effort: if it fails, the verdict still stands.
 *
 * Failures are never silently converted into "unverified" - an unverified
 * contract and an unreachable API are different facts and the verdict
 * must not conflate them.
 */
export async function analyse(address: string, chainId = 1): Promise<AnalysisResult> {
  let src = null;
  let fetchError: string | undefined;

  try {
    src = await fetchContractSource(address, chainId);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const base = structural(src);

  if (fetchError) {
    return {
      ...base,
      llmSummary: '',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: [],
      error: `source fetch failed: ${fetchError}`,
    };
  }

  if (!src) {
    return {
      ...base,
      llmSummary: 'Contract source is not verified on this explorer.',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: ['Unverified source. Structural checks unavailable.'],
    };
  }

  try {
    const llm = await llmReview(address, base.contractName, base.compilerVersion, src.SourceCode);
    return { ...base, ...llm };
  } catch (err) {
    return {
      ...base,
      llmSummary: '',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: [],
      error: `llm review failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
