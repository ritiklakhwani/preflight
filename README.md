# Preflight

**The check an AI agent clears before it signs.**

Preflight scores a contract on what it has actually done on-chain, not on what its source
code claims. When the verdict is bad, the approval does not resolve in software: it goes to
a Ledger device for a physical press.

It reads Uniswap V3 pool state through The Graph across Ethereum, Arbitrum and Base, and it
ships as an MCP server, so the check happens inside the agent that was about to sign.

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

| Package | Origin | State | What it does |
|---|---|---|---|
| `packages/core` | NEW | shipped | Shared types and the deterministic scoring function |
| `packages/analysis` | PORTED + extended | shipped | Etherscan fetch and LLM review from 2024, plus **new** deterministic structural checks and proxy implementation resolution |
| `packages/signals` | NEW | shipped | Eleven weighted signals. Four read the contract, seven read Uniswap V3 market history through The Graph and the deployer's own history |
| `packages/engine` | NEW | shipped | Composes analysis, signals and scoring into one verdict, and persists it |
| `packages/mcp` | NEW | shipped | The MCP server an agent installs. Three tools, with untrusted on-chain strings delimited before they reach a model |
| `packages/quarantine` | NEW | shipped | Injection detection on untrusted on-chain strings, and prompt spotlighting before a model reads contract source |
| `packages/gate` | NEW | shipped | Ledger device confirmation in front of a `high` verdict, and `wallet-cli ring` as the credential store for the keys this repo used to hold in plaintext |
| `packages/console` | NEW | cut | A verdict dashboard was planned and dropped. The MCP client is the product surface, and nothing in the project depends on a second one |

This table is updated as packages land, so what it claims and what runs stay the same thing.

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
pnpm db:up && pnpm db:init          # optional; without it verdicts stay in memory
pnpm analyse 0x6B175474E89094C44Da98b954EedeAC495271d0F
```

Then run it the way an agent does:

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

To install it into Claude Desktop or Cursor, see [SKILL.md](./SKILL.md).

### Chain coverage

Ethereum, Arbitrum and Base. One query shape runs against all three, since
Uniswap deploys identical subgraph code per chain and only the subgraph id
changes.

Coverage on Base is partial, and by billing rather than by bug: Etherscan's free
tier serves contract source there but not creation records, so `not-a-contract`
and `deployer-history` cannot run and report so. The verdict is computed from
the seven checks that did complete, and the response says which ones did not.
When fewer than 60% of checks complete, Preflight returns an error instead of a
verdict rather than let an outage read as a clean bill of health.

### Where the Ledger integration lives

Two things, both named directions in Ledger's Continuity track.

**A device confirmation in front of an action that previously had none.** A `high`
verdict used to print a policy line that nothing enforced. Now `preflight_check`
calls `packages/gate`, which asks a Ledger device to display something on its own
screen, and returns a refusal unless a person presses the button.

The property worth testing: unplug the device and the flow breaks. It does not
degrade, warn, or proceed with a note. `preflight_check` returns an error and the
agent is told not to sign.

Every path that is not an explicit approval is a refusal: no device, no
`wallet-cli`, a timeout, a crash, unparseable output. See
[`packages/gate/src/device.ts`](packages/gate/src/device.ts).

**`wallet-cli ring` as the key backend for the `.env` this repo already had.**
API keys are encrypted against the Key Ring, committed as ciphertext in
[`secrets/`](secrets/README.md), and decrypted at runtime. Neither encrypting nor
decrypting needs the device: `ring init` provisions the trustchain once with the
Ledger attached, and everything after runs against local member credentials.
That is what makes it usable on a server.

The passphrase comes from the OS keychain, injected by `bin/preflight-mcp` at
spawn, because wallet-cli refuses to prompt without a TTY and an MCP server
never has one. It is never written to a file and never appears in the client
configuration.

```
PREFLIGHT_GATE=off       skip the device. Records the verdict as not approved by a
                         human rather than as approved, because nobody pressed anything.
GATE_TIMEOUT_MS          how long someone has to press once a device is known to be
                         attached. Default 40000.
PREFLIGHT_SKIP_USB_PROBE disable the presence check and let wallet-cli discover the
                         device itself, which takes about a minute when there is none.
```

Neither `wallet-cli receive --verify` nor `genuine-check` fails fast with no device
attached: both scan for roughly a minute, measured at 61 and 62 seconds. The whole
`preflight_check` call has to finish inside the MCP client's 60 second request
timeout, and the analysis ahead of the gate already spends about twelve, so waiting
out that scan left under a second of margin. `deviceAttached()` reads the USB tree in
about 47 milliseconds instead. Absent means refuse now and say so; present means there
is budget to wait for a person.

### Where the Uniswap integration lives

Preflight deploys no contracts. It reads Uniswap V3 pool state and turns it into a risk
verdict, so the integration is in the query layer and the signals rather than in an SDK
call. For verification:

| What | Where |
|---|---|
| Chain-to-deployment mapping, the three subgraph ids | [`graph.ts:30-34`](packages/signals/src/graph.ts#L30-L34) |
| The two pool queries, both sides of the pair | [`graph.ts:161-173`](packages/signals/src/graph.ts#L161-L173) |
| The gateway call, authenticated with a Subgraph Studio key | [`graph.ts:219-244`](packages/signals/src/graph.ts#L219-L244) |
| `no-market`: no V3 pool on either side of the pair | [`behavioural.ts:118`](packages/signals/src/behavioural.ts#L118) |
| `pool-age`: `createdAtTimestamp` on the deepest pool | [`behavioural.ts:167`](packages/signals/src/behavioural.ts#L167) |
| `liquidity-reality`: value locked against transaction count | [`behavioural.ts:230`](packages/signals/src/behavioural.ts#L230) |
| `thin-liquidity`: whether a swap can be executed here at all | [`behavioural.ts:317`](packages/signals/src/behavioural.ts#L317) |
| How the thresholds were calibrated against real pools | [`docs/verifying-weights.md`](docs/verifying-weights.md) |
| Labelled addresses and the verdicts they produce | [`test/benchmark/addresses.json`](test/benchmark/addresses.json) |

Developer feedback for the Uniswap team is in [FEEDBACK.md](./FEEDBACK.md). Feedback for
Ledger is in [docs/feedback-ledger.md](docs/feedback-ledger.md).

### Verifying the risk model

The weights are a claim about how much each finding matters on its own. See
[docs/verifying-weights.md](./docs/verifying-weights.md) for how to check them,
plus `scripts/weights.ts` and `scripts/benchmark.ts`.

### Checking it yourself

| Document | What it is for |
|---|---|
| [docs/TEST-PLAN.md](./docs/TEST-PLAN.md) | Every case worth trying, including the hardware ones: device locked, unplugged mid-wait, rejected on the device. Exact commands and exact expected output |
| [docs/SUBMISSION-AUDIT.md](./docs/SUBMISSION-AUDIT.md) | What is built, what each partner integration does and where, the architecture, and the known limits |

## AI tool usage

See [AI_DISCLOSURE.md](./AI_DISCLOSURE.md).
