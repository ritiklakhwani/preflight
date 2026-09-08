import type { AnalysisResult } from '@preflight/core';
import { fetchContractSource, fetchContractCreation } from './etherscan.js';
import { structural, mergeProxy } from './structural.js';
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

  let base = structural(src);
  const notes: string[] = [];
  // The proxy holds the upgrade authority; the implementation holds the
  // behaviour. Reading the proxy alone makes every upgradeable token look
  // inert, which covers most of the tokens anyone actually signs against.
  let reviewSource = src?.SourceCode ?? '';

  if (src && base.isProxy && base.implementationAddress) {
    try {
      const impl = await fetchContractSource(base.implementationAddress, chainId);
      if (impl) {
        base = mergeProxy(base, structural(impl));
        reviewSource = impl.SourceCode;
      } else {
        notes.push(`Implementation ${base.implementationAddress} has no verified source.`);
      }
    } catch (err) {
      notes.push(
        `Implementation ${base.implementationAddress} could not be read: ${
          err instanceof Error ? err.message : String(err)
        }. Behaviour behind the proxy was not analysed.`,
      );
    }
  }

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
    // Our own prose must not travel in llmSummary: the renderer delimits that
    // field as attacker-controlled, and marking our text as untrusted teaches
    // the reader to ignore the marker.
    return {
      ...base,
      llmSummary: '',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: [],
      notes: ['No verified source on this explorer, so no model review was attempted.'],
    };
  }

  const carried = notes.length ? { notes } : {};

  try {
    const llm = await llmReview(address, base.contractName, base.compilerVersion, reviewSource);
    return { ...base, ...llm, ...carried };
  } catch (err) {
    return {
      ...base,
      ...carried,
      llmSummary: '',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: [],
      error: `llm review failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
