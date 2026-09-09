# Verifying the risk model

Preflight's severity is arithmetic, not a model output. That makes it auditable,
and it also makes it someone's responsibility. This is how to check it.

## What a weight actually claims

Each signal carries a weight between 0 and 1. It means one specific thing:

> Given only this signal firing, and nothing else known about the address, how
> likely is it that the caller should not proceed?

The score combines fired signals as independent evidence:

```
score = 1 - product of (1 - weight) over every signal that fired
```

So a weight of 0.85 is a claim that this finding alone justifies stopping about
85% of the time. That is arguable on its own terms, which is the point. Nobody
can check whether 0.5 is "correct" relative to 0.2, but anyone can argue about
whether an unverified contract with nothing else wrong should be reported to the
user before acting.

## Do not review the weights. Review the decisions.

```bash
node --import tsx scripts/weights.ts
```

This prints what each weight produces on its own, and what realistic
combinations produce, in the units the agent actually acts on:

| Band | Score | What the agent does |
|---|---|---|
| clean | 0-14 | proceed |
| low | 15-34 | proceed, mention it |
| medium | 35-59 | report to the user before acting |
| high | 60-100 | stop, require a human on hardware |

Read that output and ask, for each row, whether the action in the last column is
what you would want. If it is not, change the weight in
`packages/signals/src/structural.ts` or `behavioural.ts` and run it again. No
network calls, so the loop is instant.

## Then measure it against addresses you have opinions about

```bash
node --env-file=.env --import tsx scripts/benchmark.ts
```

`test/benchmark/addresses.json` holds labelled addresses. `expect` is the worst
band that address should ever produce. The runner reports two kinds of
disagreement, and they are not equally important.

**Scoring above the label is a false positive.** This is the failure that
matters. A rug detector that flags WETH does not get called cautious, it gets
uninstalled, and an agent that stops on every third call has its guard rail
switched off by whoever is tired of it. Fix these before anything else.

**Scoring below the label is a missed risk, or a wrong label.** Check which
before touching a weight. WETH and LINK score `clean` because they genuinely
have no privileged functions and no upgrade path, so the label was wrong, not
the model. USDC scoring `low` when you believe a blacklistable upgradeable token
deserves `medium` is a real disagreement about the weights.

The benchmark found a real defect the first time it ran: UNI scored `clean`
because the privileged-modifier pattern matched `msg.sender == owner` and
`msg.sender == admin` but not `msg.sender == minter`, which is how UNI gates
`mint`. Enumerating role names missed a role. The pattern now matches the
construct instead.

Etherscan's free tier allows five calls a second and one verdict makes up to
five, so the runner pauses between addresses. Without that pause the run
rate-limits itself and every address comes back `clean`, which is worth knowing
because it is exactly the failure the coverage check exists to catch.

## Where to source addresses you can label

The benchmark is only as good as its labels. Ground truth for "this was a rug"
is not something to take from a model, including this one. Verify anything you
add against the chain itself.

**Known-good is the easy half.** Anything with years of history, deep liquidity
and public governance. The list already includes eight.

**Known-bad needs sourcing.** Places to look, roughly in order of how much you
should trust them:

| Source | What it gives | Caution |
|---|---|---|
| Etherscan address nametags | Labels like Phish / Hack, applied by Etherscan | Only covers reported incidents |
| rekt.news, DeFiLlama hacks | Post-mortems of large incidents with addresses | Skewed to big losses, not small rugs |
| Chainabuse | Community-reported scam addresses | Unverified reports, check each one |
| Token Sniffer, GoPlus Security | Automated scam scoring per token | Another tool's opinion, not ground truth |

**The strongest method is finding candidates in the data yourself.** Query the
subgraph for pools whose shape matches the pattern, then verify each candidate
on the explorer before labelling it. That is how the `ease.org` case in the list
was found: $1.1 trillion in reported value locked against four lifetime
transactions, confirmed by opening the pool on Etherscan.

`scripts/probe-market.ts <address> [chainId]` prints what the subgraph knows
about any token, which is the fastest way to check a candidate before adding it.

## Open questions on the current weights

Three judgment calls that move real numbers, none of which have an obviously
correct answer:

1. USDC and USDT score `low`. Both are upgradeable and both can freeze a
   holder's balance. Should an agent report that before swapping, which would
   mean `medium`?
2. A wallet scores `medium`. Sending to a wallet instead of a contract is
   usually a user mistake rather than an attack. Is `low` the honest reading?
3. `unverified-source` scores `medium` alone. Not being able to read what you
   are signing against is the most basic red flag there is. Is `high` right, or
   would that make the tool too loud on the long tail of unverified contracts?
