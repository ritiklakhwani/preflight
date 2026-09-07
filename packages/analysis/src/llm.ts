/**
 * PORTED from Inspector AI 2024
 *   packages/chrome-extension/background.js :: getAIReview (150-222)
 *                                              generateSummary (224-230)
 *
 * The inherited asset is the *risk taxonomy* and the analytical structure,
 * not the code. Both are preserved: High Risk / Moderate Risk / Low Risk.
 *
 * Changes made during ETHOnline 2026:
 *   - API key moved out of source. The 2024 original had a live Anthropic key
 *     at background.js:151, committed to a public repo for two years.
 *   - Replaced the raw fetch() with @anthropic-ai/sdk.
 *   - Model updated from claude-3-opus-20240229 (two generations old).
 *   - Fixed a contradiction in the 2024 prompt: it demanded twelve numbered
 *     analyses and then capped the answer at 150 words, which produced mush.
 *     Now returns structured JSON with a hard cap per field.
 *   - Dropped getGaiaAnalysis entirely (GaiaNet node URL is dead) and
 *     fetch1inchData (routed through a Replit proxy that no longer runs).
 *     The 1inch liquidity view is replaced by The Graph standardized
 *     subgraphs, which see protocol-level positions instead of token metadata.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult } from '@preflight/core';

const MODEL = 'claude-sonnet-5';
const MAX_SOURCE_CHARS = 60_000;

export type LlmPart = Pick<AnalysisResult, 'llmSummary' | 'llmRiskLabel' | 'llmRiskNotes'>;

const SYSTEM = `You are a smart contract security reviewer.
You read Solidity source and report what you observe. You do not speculate.
You always reply with a single JSON object and nothing else.`;

function buildPrompt(address: string, name: string, compiler: string, source: string) {
  return `Review this contract.

Address: ${address}
Name: ${name}
Compiler: ${compiler}

Source:
${source.slice(0, MAX_SOURCE_CHARS)}

Assess, in this order:
1. Stated purpose and main features
2. Token economics, if applicable
3. Security measures present
4. Vulnerabilities or red flags
5. Unusual or noteworthy functions
6. Deviation from standard practice

Then assign exactly one risk label:
- "High Risk": significant vulnerabilities or suspicious features
- "Moderate Risk": issues that require caution
- "Low Risk": appears relatively safe, still requires care

Reply with JSON only:
{
  "summary": "<= 60 words, plain language, what this contract is and does",
  "riskLabel": "High Risk" | "Moderate Risk" | "Low Risk",
  "riskNotes": ["<= 20 words each", "3 to 6 items", "most severe first"]
}`;
}

export async function llmReview(
  address: string,
  name: string | null,
  compiler: string | null,
  source: string,
): Promise<LlmPart> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      { role: 'user', content: buildPrompt(address, name ?? 'N/A', compiler ?? 'N/A', source) },
      { role: 'assistant', content: '{' },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseReview('{' + text);
}

/** PORTED in spirit from generateSummary (224-230): pull the risk label out of the reply. */
export function parseReview(raw: string): LlmPart {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      summary?: string; riskLabel?: string; riskNotes?: string[];
    };
    const label = parsed.riskLabel ?? '';
    return {
      llmSummary: parsed.summary ?? '',
      llmRiskLabel:
        label === 'High Risk' || label === 'Moderate Risk' || label === 'Low Risk'
          ? label
          : 'Unknown',
      llmRiskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes : [],
    };
  } catch {
    // 2024 fallback: regex the label out of prose.
    const m = raw.match(/(High|Moderate|Low) Risk/);
    return {
      llmSummary: raw.slice(0, 300),
      llmRiskLabel: m ? (m[0] as LlmPart['llmRiskLabel']) : 'Unknown',
      llmRiskNotes: [],
    };
  }
}
