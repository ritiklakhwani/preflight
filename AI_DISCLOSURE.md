# AI tool usage disclosure

Required by the ETHGlobal rules: "Clearly document in your submission where and how AI
tools were used in the project."

This file separates two questions that are easy to blur together: who wrote the code, and
who decided what to build. Both are answered plainly below, because a disclosure that
flatters the author invites the reader to check the rest of the submission for the same
habit.

## Tool used

**Claude Code (Claude Opus 5)**, used throughout, as a pair-programming and research
partner. Sessions ran from 2026-09-05 to 2026-09-13.

## Who wrote the code

Most of it was drafted by the model. That is the honest answer and it applies to nearly
every TypeScript file in this repository.

| Area | How it was produced |
|---|---|
| Repository scaffolding, workspace layout, tsconfig | Model-drafted |
| `packages/core` types and the scoring function | Model-drafted |
| `packages/analysis` | Port from Inspector AI 2024 planned and executed by the model. Which 2024 code to keep and which to abandon was decided jointly against what still ran |
| `packages/signals`, all eleven signals | Model-drafted, including the threshold values |
| `packages/quarantine`, rules and the 37-payload corpus | Model-drafted |
| `packages/engine`, `packages/mcp` | Model-drafted |
| `packages/gate` | Model-drafted. Its shape was corrected repeatedly by the author's hardware testing, which is described below |
| Developer tooling in `scripts/` | Model-drafted |
| Documentation, including this file | Model-drafted, corrected by the author where wrong |

An earlier version of this file claimed the behavioural signals and the injection corpus
were the author's domain knowledge. That was not accurate and has been corrected.

## Who made the decisions

The following were the author's calls. They are listed with the reasoning because they are
the part of this project that a language model did not supply, and several of them changed
what got built.

**Continuity over Classic, 2026-09-06.** Registration was originally Classic. The author
chose Continuity after establishing that its entry gates are compound: a Continuity project
needs a prior open-source repository, and the Ledger track additionally needs the hardware.
Fields that small suit a goal of placing rather than winning outright.

**The no-forced-fits rule, set at the outset.** Verbatim: if the reasoning ever reaches "we
could also integrate X to qualify for Y," the idea is disqualified. This rule killed
several candidate integrations, including one the author personally wanted.

**Dropping Hedera, 2026-09-08.** The model had proposed Hedera and had wrongly claimed the
2024 base project already used Hedera Consensus Service. The author identified the flaw in
the eligibility argument independently: reading the requirement loosely enough to admit us
also admits every other Continuity entrant with any prior hackathon project, so the loose
reading does not help. Combined with the integration being removable without breaking
anything, Hedera was dropped and Uniswap took the slot.

**Rejecting Bazantic despite preferring it, 2026-09-09.** The author correctly identified
that Bazantic had a better thematic fit and a far smaller field than Uniswap, and argued
for it. It was dropped anyway because its qualification requires standing up an x402
payment gateway, and a security tool that meters itself per call is the forced fit the
author's own rule prohibits.

**Demanding proof of The Graph integration, 2026-09-09.** The author challenged whether
querying a Uniswap-authored subgraph constitutes using The Graph at all. The answer was
established empirically rather than argued: the gateway rejects an invalid Graph API key,
Uniswap's own legacy endpoint is gone, and no Uniswap-operated API serves this data. That
exchange is why `docs/verifying-weights.md` exists in the form it does.

**Multi-chain support, 2026-09-09.** The author asked why the implementation queried one
subgraph on one chain. The model had not examined that default. It turned out to be a
correctness bug rather than a scope choice: `preflight_check` already accepted a `chainId`,
so a Base query would have been answered with Ethereum data and no error. Ethereum,
Arbitrum and Base are supported because the author questioned an assumption.

**Address verification, 2026-09-09.** The author checked seven tokens on Etherscan by hand,
recording holder counts, market capitalisation, price and websites. That data exposed the
most serious defect in the project: the risk model was inverted, scoring FDUSD and sUSDat,
two real stablecoins, as more dangerous than an unverified three-holder token. It also
supplied the discriminator that fixed it. No benchmark of well-known tokens would have
found this, and the model did not find it.

**Insisting on verification before every commit.** The author repeatedly refused to accept
"it works" without evidence. That standard is why the benchmark, the weight-inspection tool
and the candidate discovery script exist, and those tools found four defects between them:
UNI scoring clean, WBTC's pause path going undetected, an Etherscan rate limit rendering as
a clean bill of health, and the inversion above.

**Correcting the model on Ledger, 2026-09-07.** The model concluded from a workshop
screenshot that documentation feedback was a scored requirement weighted equally with code,
and told the author they were about to submit without half of what they would be judged on.
The author had attended the session live and corrected this. The claim was wrong.

**Hardware provisioning and the headless decrypt canary, 2026-09-06.** Run by the author on
a physical Ledger Nano S Plus. Establishing that `ring encrypt` and `ring decrypt` work with
the device unplugged, after a single provisioning tap, is what made the credential-store
half of the Ledger integration viable at all.

**Rejecting the proposed gate timeout, 2026-09-11.** The model found that a `high` verdict
could exceed the MCP client's sixty-second limit and proposed cutting the device wait from
forty-five seconds to twenty-five. The author refused, on the grounds that forty-five seconds
is a reasonable window for someone to reach a device and unlock it, and asked what the
reduction was actually buying. That objection was correct and the proposal was poor. Being
made to justify it produced the measurement that mattered: `wallet-cli` does not fail fast
when no device is attached, it scans for about a minute, and that scan was what consumed the
budget. Reading the USB tree instead answers in 47 milliseconds. The human window grew rather
than shrank, and the race disappeared. The design in `packages/gate/src/device.ts` exists
because the author would not accept the first answer.

**Requiring an audit where every claim was executed, 2026-09-11.** The author asked for a
survey of the project in which nothing was reported as working unless the command had been
run and its output shown. Doing that exposed the most embarrassing defect of the build: moving
the API keys onto the Key Ring had left the MCP server as the only entry point that decrypted
them, so the benchmark had been running twenty addresses with no credentials, scoring every
one of them clean, and printing `0 false positives`. It was measuring nothing and reporting
success. Nothing in the test suite could have caught it.

**Testing the device paths on real hardware, 2026-09-11 and 2026-09-12.** The author worked
through thirteen physical cases: device absent, locked, unlocked and approved, rejected,
unplugged mid-wait, reconnected, left untouched until timeout. Nine defects surfaced, every
one of them in code with a passing test suite. The most serious was a parser that refused
every genuine approval, because `receive --verify` reports success as `status: "success"` with
`verified` and `source` fields and never emits the `ok: true` the model had decided to require.
No amount of reading would have found that. Someone had to press the button.

**Demanding the output be readable, 2026-09-11.** The author's objection was that a run
printed the verdict twice and they had to scroll to find what happened. That is the entire
reason the response now leads with the severity, orders findings by weight, and collapses
checks that found nothing. Following it up exposed three further defects of the same shape,
where partial knowledge was being presented with full confidence: checks that could not run
listed as having found nothing, a rate-limited proxy read reported as a complete analysis, and
an outage displayed as `CLEAN 0/100`.

**Testing as a judge rather than as the author, 2026-09-12.** Asked to verify the project,
the author specified that it be done from scratch, the way someone encountering the repository
would, rather than in the working directory. That reframing found that the published repository
did not build at all: two files were uncommitted while a file depending on them had been
pushed. Every check until then had been run against a local tree that had been correct for
days. The distinction between what works here and what is published was the author's.

## Where AI was not used

Nothing in this project was produced without AI assistance to the code. The division above
is the accurate one, and inventing a cleaner line would be worse than the truth.

## Runtime use of models

Preflight calls an Anthropic or OpenAI model at runtime to summarise contract source. That
output is **never** used to make the risk decision. Severity is computed in
`packages/core/src/score.ts` by arithmetic over weighted on-chain signals, and the same
address in the same on-chain state produces the same severity every time. The model's role
is explanatory only.

The source it reads is sealed in a nonce-delimited block before it sees it, because that
source is written by the party under review. See `packages/quarantine/src/spotlight.ts`.
