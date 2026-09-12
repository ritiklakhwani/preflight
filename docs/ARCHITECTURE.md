# Architecture and verification

Written 2026-09-11, two days before the ETHOnline 2026 deadline. Every claim here was
checked against the repository by running the command shown. Where something is broken it
says so.

---

## 1. What is built and actually running

### Verified by running it

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm check` | Exit 0 |
| Tests | `pnpm test` | 167 passed, 8 files |
| Repo | `gh repo view` | Public, `main` only, everything pushed |
| Live flow | `scripts/mcp-smoke.ts 0x6B17…0F 1` | LOW 20, coverage 11/11, about 12s |
| Credentials | same run, first stderr line | `key ring: decrypted ETHERSCAN_API_KEY, GRAPH_API_KEY, OPENAI_API_KEY` |
| Storage | same run | `postgres connected`, 3 tables, 200+ verdict rows |
| Device refusal | `scripts/mcp-smoke.ts 0x160d…B1 1`, no Ledger | HIGH 94, refused in about 13s |

Note the script is `pnpm check`. There is no `pnpm typecheck`.

### Packages

| Package | Lines | Tests | State |
|---|---|---|---|
| `core` | 237 | 8 | Shipped. Types and the scoring function |
| `analysis` | 893 | 9 | Shipped. Ported from Inspector AI 2024, extended |
| `signals` | 1352 | 28 | Shipped. Eleven weighted signals |
| `quarantine` | 910 | 75 | Shipped. 12 rules, 37-payload corpus |
| `engine` | 364 | via others | Shipped. Verdict composition and storage |
| `mcp` | 417 | 9 | Shipped. Three tools over stdio |
| `gate` | 975 | 27 | Shipped. Device confirmation and Key Ring credentials, tested across 13 hardware cases |
| `console` | 0 | — | **Cut.** Never started, and nothing depends on it |

### Embarrassment sweep

Zero `TODO`, zero `FIXME`, zero mock or stub data, zero commented-out code. Grepping for
`mock|fake|stub|dummy|placeholder` returns five lines, all of them scenario names or English
prose inside comments. No fabricated data reaches a verdict: every number comes from a live
call to Etherscan or The Graph.

The only non-ASCII characters in the repository are two heavy check marks inside a fenced block in
`docs/feedback-ledger.md`, which is verbatim wallet-cli output quoted in a bug report to
Ledger. They are evidence, not decoration.

### Known limits, stated rather than hidden

- **Four injection payloads out of 37 are not detected**, by design and asserted by the test
  suite: two non-English imperatives, one authority-flavoured but legal Solidity identifier,
  and one comment forging the JSON shape the model is asked to return. None can change a
  severity, because severity never passes through a model.
- **`self-destruct` and `pool-age` did not fire** in the latest benchmark, so those weights are
  assertions rather than measurements. `pool-age` is time-relative: the address added to exercise
  it has aged past the 48-hour window, which is the signal correctly switching off. Its
  deterministic test lives in `packages/signals/test/behavioural.test.ts`.
- `self-destruct`'s weight of 0.45 is an assertion EIP-6780 made `selfdestruct` inert for already-deployed
  contracts, so finding a live example is not worth the remaining time.
- **`deployer-history` cannot recognise an established serial scammer.** An address five years
  old that shipped honeypots in 2021 looks identical to one that shipped infrastructure. That
  needs a labelled database, which is a different product. Said plainly in the source.

---

## 2. Partner integrations

Three integrations, each load-bearing rather than decorative. Remove any one and the project
loses something it cannot do another way.

### The Graph — Best AI Tooling or AI Use Case with The Graph (Continuity), $5,000

1st $2,500, 2nd $1,500, 3rd $1,000.

**How it works.** Preflight reads the official Uniswap V3 subgraphs through The Graph's
decentralised gateway, authenticated with a Subgraph Studio API key. Uniswap wrote the schema
and the mapping handlers; The Graph's Indexers run that code and serve the result.

Deployment ids, compiled in as defaults at `packages/signals/src/graph.ts:30-34` so a judge
needs only a `GRAPH_API_KEY` to reproduce everything:

| Chain | Subgraph deployment id |
|---|---|
| Ethereum, 1 | `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` |
| Arbitrum One, 42161 | `FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM` |
| Base, 8453 | `HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1` |

Endpoint shape: `https://gateway.thegraph.com/api/{KEY}/subgraphs/id/{ID}`, at `graph.ts:227`.

Data flow: `preflight_check` to `runPreflight` to `queryMarket`, which fires three parallel
requests, one for token aggregates and one for each side of the pair, because a Uniswap pair is
directional and a token on the wrong side would be invisible. Results are deduplicated and
sorted by depth, then seven of eleven signals read them.

| Their requirement | Our evidence |
|---|---|
| The Graph load-bearing | Seven of eleven signals read it. Remove it and the project cannot answer its own question |
| Live data, mocked does not qualify | `graph.ts:219-244` is a live gateway call. No fixture reaches a verdict |
| Meaningful work, not printing a query | The query feeds a deterministic risk score which gates a hardware confirmation |
| Reusable infrastructure, not one app | An MCP server with three tools, installable in Claude Code, Claude Desktop and Cursor |
| Open source with README or SKILL.md | Both at the repository root |
| Continuity, document prior work | `README.md`, `LEGACY.md`, and the `ethonline-2026-start` tag |
| 2 to 4 minute video | Not recorded yet |

**Why the fit is real.** A node can tell you a token's balance. It cannot tell you that the only
pool holding it was created six hours ago and has never been traded, or that a pool holding
$1.1 trillion has seen four transactions in its life. That is indexed history, and it is the
difference between reading a contract and knowing what it has done.

### Ledger — Continuity, $1,500

1st $1,000, 2nd $500. Two places, so the field is small.

Their track lists four example directions. We built two of them completely.

**Direction: "Put a device confirmation in front of an action your product already performs."**

A `high` verdict used to print a policy line. Nothing enforced it, and an agent that can read a
policy line can ignore one. Now `packages/gate` asks a Ledger to display something on its own
screen, and `preflight_check` returns an **error** unless a person presses a physical button
(`packages/mcp/src/index.ts:88-105`).

Every path that is not an explicit `ok: true` is a refusal: no device, no `wallet-cli`, a
timeout, a crash, unparseable output. The parser used to accept `status: "success"`, which is
wallet-cli's generic "the command ran" envelope, and `session view` returns it without ever
touching the device. That bug meant "the process exited normally" was being read as "a human
pressed a button", on the one path where the distinction is the entire product. It was found by
an agent reading our source during a live test, which is a better argument for readable code
than anything in the README.

**Direction: "Make `wallet-cli ring` the key backend for the `.env` your repo already has."**

`packages/gate/src/secrets.ts` decrypts scoped credentials at startup. Verified load-bearing:

```
$ grep -cE '^(ETHERSCAN_API_KEY|GRAPH_API_KEY|OPENAI_API_KEY)=.+' .env
0
```

No plaintext credential exists on disk. The ciphertext in `secrets/*.enc` is the only copy, and
a run with that file set still returns a verdict at 11/11 coverage.

Neither encrypting nor decrypting needs the device. `ring init` provisions the trustchain once
with the Ledger attached; everything after runs against local member credentials. That is what
makes it usable on a server, and it is the property their track asks about.

| Their direction | Status |
|---|---|
| Device confirmation in front of an existing action | Done, verified live |
| `wallet-cli ring` as the key backend | Done, verified load-bearing |
| Add a Ledger signer using DMK skills | Not applicable, Preflight signs nothing |
| Land a fix on a Ledger repository | Issues we hit are written up in [docs/feedback-ledger.md](feedback-ledger.md) |

### Uniswap Foundation — Best Uniswap Stack Contribution (Continuity), $2,000

Two places at $1,000 each.

Preflight deploys no contracts. It reads Uniswap V3 pool state and turns it into a risk verdict,
so the integration lives in the query layer and the signals.

| What | Where |
|---|---|
| Chain to deployment mapping | `packages/signals/src/graph.ts:30-34` |
| The two pool queries | `graph.ts:161-173` |
| The gateway call | `graph.ts:219-244` |
| `no-market` | `packages/signals/src/behavioural.ts:118` |
| `pool-age` | `behavioural.ts:167` |
| `liquidity-reality` | `behavioural.ts:230` |
| `thin-liquidity` | `behavioural.ts:317` |

| Their requirement | Status |
|---|---|
| Build on or integrate part of the Uniswap stack | Done. V3 subgraph across three chains |
| Public GitHub repo, open source | Done |
| `FEEDBACK.md` | Done, with dated measurements |
| Completed feedback form linking FEEDBACK.md | Submitted |
| README points at the relevant lines | Done, line anchors added |

---

## 3. Current state

**Branches:** `main` only, local and remote in sync. **Open PRs:** none. **Merged PRs:** none.
**CI:** none; `pnpm check && pnpm test` is the whole build and runs in under ten seconds.
**Deployed:** nothing, and nothing needs to be. Preflight is a local MCP server plus an
optional local Postgres container, and it is meant to run on the machine that does the
signing.

| Variable | Required | Where it comes from |
|---|---|---|
| `ETHERSCAN_API_KEY` | Yes | Key Ring, `secrets/etherscan.enc` |
| `GRAPH_API_KEY` | Yes | Key Ring, `secrets/graph.enc` |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | One, advisory only | Key Ring, `secrets/openai.enc` |
| `DATABASE_URL` | No, memory fallback | `.env` |
| `PREFLIGHT_GATE`, `GATE_TIMEOUT_MS`, `PREFLIGHT_SKIP_USB_PROBE`, `WALLET_CLI_PATH`, `LEDGER_ACCOUNT_LABEL` | No | Defaults in code |
| `SG_UNISWAP_V3_*` | No | Defaults in `graph.ts:30-34` |

External dependencies: The Graph gateway, Etherscan V2, one LLM provider, `wallet-cli` 2.1.0,
Postgres 16, Node 22 or later.

---

## 4. How it works, in plain language

**MCP, the Model Context Protocol**, is how an AI assistant talks to tools that are not built
into it. An **MCP server** is a program that advertises some tools and answers when they are
called. Ours speaks over **stdio**, meaning the client starts it as a subprocess and they
exchange JSON messages over standard input and output. That is why nothing in the process may
print to stdout except the protocol itself; all diagnostics go to stderr.

A **tool call** is the agent deciding, on its own, to invoke one of those tools. We advertise
three: `preflight_check`, `preflight_explain`, `preflight_recent`.

Here is what happens when an agent is about to approve a token and calls `preflight_check`.

**Step 1, identity.** We ask Etherscan whether the address is a contract at all, and if so who
deployed it and when. An address with no creation record is a wallet, and most of our questions
do not apply to it. We say so rather than reporting a shallow verdict as a thorough one.

**Step 2, what it can do.** We fetch the verified source and ABI. If it is a **proxy**, a
contract that forwards calls to an implementation an admin can swap out, we follow it and merge
both. Without that step every upgradeable token reads as inert. Deterministic pattern matching
then finds privileged functions, transfer restrictions and self-destruct paths.

**Step 3, what it has done.** In parallel we query a **subgraph**, which is a program that reads
a blockchain and turns raw events into a queryable database. Uniswap wrote theirs; The Graph's
**Indexers** run it and serve queries through a **gateway** we authenticate against. We ask for
every V3 pool holding this token, on both sides of the pair, and we ask Etherscan for the last
hundred transfers to see how widely it is held.

**Step 4, the score.** Eleven **signals** each look at that evidence and answer one yes-or-no
question with a **weight**: given only this firing and nothing else known, how likely is it that
the caller should not proceed. The score is **deterministic**, meaning the same address in the
same on-chain state always produces the same answer. No model is involved. A language model does
write one paragraph of prose summarising the source, and that paragraph is explicitly advisory
and cannot move the number.

**Step 5, the untrusted boundary.** Several strings in the evidence were written by the person
being investigated: the contract name they submitted to the explorer, the function names in
their ABI, and the source the model read. Anyone can deploy a contract named `IGNORE ALL
PREVIOUS INSTRUCTIONS`. That is **prompt injection**, and it is not hypothetical when the reader
is an agent holding a private key.

Two defences. On the way in, **taint tracking** scans those fields against twelve rules and
records what matched, so the finding travels with the verdict. Before the model reads contract
source, **spotlighting** seals it in a block delimited by a random **nonce** the author cannot
predict, so no payload can close the block it sits in. On the way out, every attacker-controlled
value is wrapped in `<untrusted id="...">` with a trailer telling the agent to treat it as data.

**Step 6, the gate.** If the severity is `high`, approval leaves software. `wallet-cli` asks a
Ledger to display something on its own screen and waits for a physical button press. This is
**clear signing**: the device shows a human what is being approved, so a compromised computer
cannot lie about it. The opposite, **blind signing**, is approving a payload the device cannot
interpret. We deliberately use `receive --verify` rather than `send`, because it requires the
same physical press but needs no gas and no blind-signing toggle, which is two fewer things to
fail on camera.

Before blocking, we read the USB tree directly, in about 47 milliseconds, to learn whether a
device is there at all. `wallet-cli` takes roughly a minute to reach the same conclusion, and we
do not have a minute.

**Step 7, the answer.** The verdict is written to Postgres and rendered as text. If the gate was
required and not granted, `preflight_check` returns an **error**, not a verdict with a note
attached, so a caller cannot read past it.

One term we do not use: **EIP-712**, the standard for signing structured data so a wallet can
display it meaningfully. It is the right tool for signing a transaction. Preflight signs
nothing; it gates whether someone else may. So the device is used for confirmation of presence
and intent, not for producing a signature.

---

## 5. Architecture

```
                         AGENT  (Claude Code, Claude Desktop, Cursor)
                              holds signing capability
                                        |
                     tool call: preflight_check { address, chainId }
                                        |
  ================================ TRUST BOUNDARY 1 =========================
   Everything below returns text into a context window that can act on it.
                                        |
                                        v
                          packages/mcp   bin/preflight-mcp
                          three tools, stdio transport
                                        |
                                        v
                          packages/engine   runPreflight()
                       one definition of what a verdict is
                                        |
                +-----------------------+------------------------+
                |                       |                        |
                v                       v                        v
        packages/analysis        packages/signals          packages/gate
                |                       |                        |
                v                       v                        v
        Etherscan V2             The Graph gateway         wallet-cli 2.1.0
        source, ABI, proxy,      Uniswap V3 subgraphs      device confirm +
        deployer, transfers      chains 1 / 42161 / 8453   Key Ring decrypt
                |                       |                        |
  ============= TRUST BOUNDARY 2 =======+                        |
   Contract names, ABI names, source: written by the            |
   party under review. Tainted at ingress, sealed before        |
   a model reads them, delimited at egress.                     |
                |                       |                        |
                +-----------+-----------+                        |
                            v                                    v
                    packages/core score()              TRUST BOUNDARY 3
                 deterministic, no model             approval leaves software
                            |                        and becomes a button press
                            +------------------+-----------+
                                               v
                                    Postgres 16, three tables
                                verdicts / signal_results / taint_events
```

### The three boundaries and how each fails

**Boundary 1, verdict to agent.** Everything we emit lands in a context window belonging to
something that can sign transactions. Defence: attacker-controlled values are wrapped in a
nonce-delimited tag, control characters and angle brackets are stripped, and a trailer explains
the tag. **Failure mode:** an agent that reasons past the delimiter anyway. We cannot prevent
that in software, which is why a `high` verdict is returned as an error rather than as text the
agent may weigh.

**Boundary 2, chain to us.** Token names, symbols, ABI function names and contract source are
unauthenticated, permanently hosted and free to write. Defence: twelve injection rules at
ingress recording what matched, nonce spotlighting before the model reads source, and
independent stripping at egress. **Failure mode:** a payload our rules do not match. Four are
known and asserted by the test suite. The containment that matters is structural, not
rule-based: the model cannot move the severity no matter what it reads.

**Boundary 3, software to hardware.** Defence: only an explicit `ok: true` from the device is an
approval. **Failure mode:** a genuine approval that does not carry `ok: true` would be refused.
That is the safe direction to be wrong in, and the raw output is returned in the reason so the
shape can be corrected in one pass.

### How the score is computed

Signals are independent evidence, not components of an average:

```
score = 1 - product over fired signals of (1 - weight)
```

The first version divided fired weight by total weight. It produced a defensible-looking number
and a wrong answer, because averaging assumes findings dilute each other. A pool holding $1.1
trillion that four transactions have ever touched is damning on its own, and it does not become
less damning because the source happens to be verified. Under averaging that address scored 18
and read LOW. It now reads HIGH 94.

| Signal | Weight | Source |
|---|---|---|
| `unverified-source` | 0.50 | Etherscan |
| `privileged-control` | 0.20 | Etherscan |
| `transfer-restrictions` | 0.15 | Etherscan |
| `self-destruct` | 0.45 | Etherscan |
| `not-a-contract` | 0.35 | Etherscan |
| `no-market` | 0.30 | The Graph |
| `pool-age` | 0.50 | The Graph |
| `liquidity-reality` | 0.85 | The Graph + Etherscan |
| `thin-liquidity` | 0.30 | The Graph |
| `holder-concentration` | 0.50 | Etherscan |
| `deployer-history` | 0.55 | Etherscan |

Bands: `clean` 0-14, `low` 15-34, `medium` 35-59, `high` 60-100. A signal that errored
contributes nothing, so a broken check cannot dilute a real finding into looking safe. If fewer
than 60% of checks complete, `preflight_check` returns an error instead of a verdict, because an
outage must never read as a clean bill of health.

### Why it is built this way

**One verdict definition.** The MCP server, the benchmark and the gate all call `runPreflight`.
There is no second path that could disagree with the first.

**Signals as a flat weighted set** rather than a decision tree. Each weight is arguable on its
own terms, which is what you want when defending the number to a judge, and adding a signal
costs no extra network calls because the context is assembled once and shared.

**Errors are values, not exceptions.** `MarketResult` distinguishes "the gateway timed out" from
"this token has no market" because collapsing those produces confident false positives on the
exact day the network is having trouble.

**The model is advisory and structurally cannot decide.** That is the answer to the first
question a security-minded judge asks.
