import type { AnalysisResult } from '@preflight/core';
import { fetchContractSource, fetchContractCreation } from './etherscan.js';
import { structural, mergeProxy } from './structural.js';
import { llmReview } from './llm.js';

export {
  fetchContractSource,
  fetchContractCreation,
  fetchDeployerProfile,
} from './etherscan.js';
export type { SourceCodeResult, CreationResult, DeployerResult } from './etherscan.js';

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

  // Independent calls, so they overlap. The creation record answers a question
  // the source cannot: whether this address is a contract at all. An agent
  // about to approve a wallet is in a different kind of trouble.
  const [srcResult, creation] = await Promise.all([
    fetchContractSource(address, chainId).catch((err: unknown) => {
      fetchError = err instanceof Error ? err.message : String(err);
      return null;
    }),
    fetchContractCreation(address, chainId),
  ]);
  src = srcResult;

  let base = structural(src);
  const notes: string[] = [];

  const identity = {
    isContract: creation.status === 'error' ? null : creation.status === 'contract',
    creator: creation.status === 'contract' ? creation.creator : null,
  };
  if (creation.status === 'error') {
    notes.push(`Creation record unavailable: ${creation.error}. Contract status unknown.`);
  }
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
      ...identity,
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
      ...identity,
      llmSummary: '',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: [],
      notes: [...notes, 'No verified source on this explorer, so no model review was attempted.'],
    };
  }

  const carried = notes.length ? { notes } : {};

  try {
    const llm = await llmReview(address, base.contractName, base.compilerVersion, reviewSource);
    return { ...base, ...identity, ...llm, ...carried };
  } catch (err) {
    return {
      ...base,
      ...identity,
      ...carried,
      llmSummary: '',
      llmRiskLabel: 'Unknown',
      llmRiskNotes: [],
      error: `llm review failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
