# Preflight

**The check an AI agent clears before it signs.**

Preflight scores a contract on what it has actually done on-chain, not on what its source
code claims. When the verdict is bad, the approval does not resolve in software: it goes to
a Ledger device for a physical press. Every verdict is written to Hedera Consensus Service,
so anyone can verify it without running this code.

---

## What existed before ETHOnline 2026

**Base project:** Inspector AI, built at ETHGlobal Singapore, September 2024.
**Repository:** https://github.com/Krane-Apps/inspector-ai-eth-singapore-2024
**Base commit:** `b9737ffde8c0e599a1187e815fcba9cf4642423d` (2024-09-22)
**Prize:** Worldcoin pool prize.

Inspector AI was a **team project**. Original contributors: Ritik Lakhwani, Ishan Lakhwani,
resatu. Verify with `git log` in the base repository.

It was a Chrome extension. A human pasted a contract address, the extension fetched source
and ABI from Etherscan plus market data from 1inch, sent both to a model, and displayed a
High / Moderate / Low risk label alongside community reviews.

### Reused from 2024

| What | Where it lives now |
|---|---|
| Etherscan source + ABI fetch | `packages/analysis/src/etherscan.ts` |
| The LLM review prompt and its analytical structure | `packages/analysis/src/llm.ts` |
| The risk taxonomy: High Risk / Moderate Risk / Low Risk | `packages/analysis/src/llm.ts` |

Every ported file carries a header comment naming the original file and line range.

### Not revived, documented in [LEGACY.md](./LEGACY.md)

The Chrome extension UI, the GaiaNet LLAMA 3.1 model (endpoint dead), the 1inch proxy
(Replit app no longer running), the community review system, the NFT rewards, CCIP
cross-chain review aggregation.

---

## What was built during ETHOnline 2026

Everything after the `ethonline-2026-start` tag:

```bash
git diff ethonline-2026-start..HEAD
```

| Package | Status | What it does |
|---|---|---|
| `packages/core` | NEW | Shared types and the deterministic scoring function |
| `packages/analysis` | PORTED + extended | Etherscan fetch, LLM review, **new** deterministic structural checks on the ABI |
| `packages/signals` | NEW | Behavioural risk signals over The Graph standardized subgraphs |
| `packages/quarantine` | NEW | Taint tracking and prompt-injection detection on untrusted on-chain strings |
| `packages/gate` | NEW | Ledger confirmation service; Key Ring credential storage |
| `packages/attest` | NEW | Hedera Consensus Service verdict log |
| `packages/mcp` | NEW | The MCP server an agent installs |
| `packages/console` | NEW | Live verdict stream and quarantine diff |

---

## Why the 2024 premise no longer holds

Inspector AI assumed a human clicked "AI Audit" before approving. That assumption is dead,
and not because the analysis got worse. It is dead because **the human is frequently no
longer in the signing loop.** Agents read contracts and sign transactions autonomously, and
nothing sits between the decision and an irreversible approval.

Two consequences drove this rebuild:

**Source code is the weaker signal.** What predicts a rug is behaviour: who deployed this,
what did that deployer ship before, is the liquidity real. Source analysis answers none of
that. Indexed on-chain data does.

**The data the agent reads is itself attacker-controlled.** Token names, symbols, ENS text
records, NFT metadata. Anyone can write anything into those fields for the price of gas, and
it lands directly in the model's context. That channel is unauthenticated, permanently
hosted, and unguarded.

---

## Setup

```bash
cp .env.example .env    # fill in the keys
pnpm install
pnpm db:up && pnpm db:init
pnpm analyse 0x6B175474E89094C44Da98b954EedeAC495271d0F
```

## AI tool usage

See [AI_DISCLOSURE.md](./AI_DISCLOSURE.md).
