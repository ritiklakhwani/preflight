# AI tool usage disclosure

Required by the ETHGlobal rules: "Clearly document in your submission where and how AI tools
were used in the project."

## Tools used

- **Claude Code (Claude Opus 5)** - planning, scaffolding, code review, and pair
  implementation across the packages listed below.

## Where

| Area | Nature of assistance |
|---|---|
| Repository scaffolding, tsconfig, workspace layout | Generated, reviewed and edited by hand |
| `packages/core` types and scoring | Drafted with assistance, thresholds and weights chosen by the author |
| `packages/analysis` port from Inspector AI 2024 | Port strategy and structure assisted; the decision of what to keep and what to discard is the author's |
| `packages/signals` structural signals | Drafted with assistance. Weights reviewed and set by the author |
| `packages/signals` behavioural signals over The Graph | **Author's domain knowledge.** Which behaviours predict a rug is not a code-generation question |
| `packages/engine`, `packages/mcp` | Drafted with assistance, reviewed by the author |
| `packages/quarantine` injection corpus | **Author's domain knowledge.** Attack payloads written by the author |
| Documentation, README, this file | Drafted with assistance, reviewed and corrected by the author |

## Where AI was not used

The parts of the risk model that required practitioner knowledge rather than code
generation: which behavioural signals matter, the severity thresholds, and the
prompt-injection corpus.

The four structural signals shipped first were drafted with assistance from their
specification. The author reviewed each weight against contracts with known properties
before accepting it. Stating this precisely matters more than claiming a cleaner line than
the one that exists.

## Runtime use of models

Preflight calls an Anthropic model at runtime to summarise contract source. That model output
is **never** used to make the risk decision. Severity is computed deterministically in
`packages/core/src/score.ts` from weighted on-chain signals. The model's role is explanatory
only, which is also why its output passes through the quarantine layer.
