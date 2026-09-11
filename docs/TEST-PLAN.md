# Test plan

A judge will type things we did not anticipate. This is the list of things we did
anticipate, written so it can be executed without thinking.

Every step gives the exact command, the exact expected result, what a failure looks like,
and what it costs if it fails. Run part 0 and part 1 any time. Run part 2 with the Ledger
Nano S Plus in your hand. Part 5 is the five-minute check before recording.

Severity means: **Critical** breaks a prize claim, **High** breaks the demo, **Medium** looks
unfinished, **Low** cosmetic.

---

## Part 0 — Setup, once

| # | Command | Expected |
|---|---|---|
| 0.1 | `cd preflight && pnpm install` | Completes without error |
| 0.2 | `pnpm db:up && pnpm db:init` | Container healthy. Re-running init prints "already exists" errors, which are harmless |
| 0.3 | `security find-generic-password -a default -s ledger-wallet-cli -w > /dev/null && echo FOUND` | Prints `FOUND`. Never drop the redirect: without it the command prints your Key Ring passphrase to the terminal, where it lands in scrollback and in anything you paste |
| 0.4 | `wallet-cli --version` | `2.1.0` or later |
| 0.5 | `pnpm check` | Exit 0, no output |
| 0.6 | `pnpm test` | **142 passed**, 8 files |

If 0.3 fails, create the entry:

```bash
security add-generic-password -a default -s ledger-wallet-cli -w
```

---

## Part 1 — Software flow, no device needed

**`PREFLIGHT_GATE=off` is only needed for a HIGH address.** The gate is summoned by severity, so
a `clean`, `low` or `medium` verdict never touches the device and the variable changes nothing.
The benchmark and the probes never gate at all. You need it only when running `mcp-smoke.ts`
against a HIGH address without a Ledger attached, and it goes at the front of the command:

```bash
PREFLIGHT_GATE=off node --env-file=.env --import tsx scripts/mcp-smoke.ts <address> <chainId>
```

Without it, a HIGH address with no device now refuses in about 13 seconds rather than hanging,
so forgetting it costs you 13 seconds, not a broken run.

### 1.1 The server starts and decrypts its credentials

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x6B175474E89094C44Da98b954EedeAC495271d0F 1
```

**Expected**, in the first four lines of stderr:

```
[mcp] key ring: decrypted ETHERSCAN_API_KEY, GRAPH_API_KEY, OPENAI_API_KEY
[store] postgres connected
[mcp] storage: postgres
[mcp] ready on stdio
```

Then `TOOLS` listing `preflight_check`, `preflight_explain`, `preflight_recent`, and a verdict
reading **LOW 20/100, coverage 11/11**, in roughly 12 seconds.

**Failure looks like:** `key ring:` lines reporting errors, or `storage: memory`. The first
means no credentials, and every network signal will report it could not run. **Critical.**

### 1.2 The full benchmark

```bash
node --env-file=.env --import tsx scripts/benchmark.ts
```

**Expected:** `21 cases   0 scored above their label (false positives)   0 below (missed risk)`.

**Failure looks like:** any row marked `OVER` or `under`. An `OVER` on a blue chip is the
expensive one. **Critical.**

### 1.3 Real addresses, one per band

Run each as `node --env-file=.env --import tsx scripts/mcp-smoke.ts <address> <chainId>`.

| Address | Chain | Expected | Why it is here |
|---|---|---|---|
| `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 1 | CLEAN 0 | WETH. Immutable, no owner, nothing to find |
| `0x6B175474E89094C44Da98b954EedeAC495271d0F` | 1 | LOW 20 | DAI. Auth-gated mint is real centralisation, correctly minor |
| `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409` | 1 | MEDIUM 52 | FDUSD. A real stablecoin whose V3 depth lives elsewhere |
| `0x160de4468586B6B2F8a92FEB0c260fc6cFC743B1` | 1 | HIGH 94 | ease.org. The demo asset |
| `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | 1 | MEDIUM 35 | vitalik.eth. A wallet, not a contract |
| `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 42161 | LOW 32 | USDC on Arbitrum. Proves multi-chain |
| `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | 137 | LOW 32, **or** an inconclusive error | USDC on Polygon. Regression: read HIGH 66 before the throughput guard. See the note below |

**Failure looks like:** any blue chip above its band. **Critical.**

**On Polygon, two answers are both correct.** We index no Uniswap V3 subgraph for chain 137, so
the four market signals cannot run and coverage lands at 6 or 7 of 11 depending on whether the
holder sample succeeds. The floor is 60%. At 7/11 you get LOW 32; at 6/11 `preflight_check`
returns an inconclusive error instead, which is the system refusing to judge on too little
evidence. Either is right. **HIGH is not**, and that is what this case exists to catch.

### 1.4 The demo asset tells its story

```bash
node --env-file=.env --import tsx scripts/probe-market.ts 0x160de4468586B6B2F8a92FEB0c260fc6cFC743B1 1
```

**Expected:** a pool holding over a trillion dollars against almost no volume and a handful of
transactions. This is the number the video points at. **High** if the pool has been drained,
in which case pick a fresh one with `scripts/find-candidates.ts`.

### 1.5 Persistence survives a restart

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x6B175474E89094C44Da98b954EedeAC495271d0F 1
```

**Expected:** the `preflight_recent` section lists verdicts from **earlier runs**, not just this
one. That is Postgres working. **Medium** if only one row appears.

---

## Part 2 — Hardware, with the Nano S Plus

Remove `PREFLIGHT_GATE=off` for all of part 2. Every case uses the same command:

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x160de4468586B6B2F8a92FEB0c260fc6cFC743B1 1
```

ease.org scores HIGH, which is what summons the device. Note the elapsed `[Nms]` line each time.

| # | Set up | Expected | Severity if wrong |
|---|---|---|---|
| 2.1 | **No device plugged in** | Refused in **about 13 seconds total**. Reason: `no Ledger detected over USB. Connect the device, unlock it, and run this check again` | **Critical.** This is the Ledger claim |
| 2.2 | **Plugged in, locked, PIN not entered** | Refused. wallet-cli reports no usable device. Must not hang past 40s | High |
| 2.3 | **Plugged in, unlocked, no app open** | Device shows the address to verify. Press both buttons. Verdict returns `GATE: approved by a human on a Ledger device` | **Critical** |
| 2.4 | **Plugged in, unlocked, press reject** | Refused with the device's own reason. Agent told not to sign | **Critical** |
| 2.5 | **Plugged in, press nothing** | Refused after about 40 seconds with `no confirmation within 40s`. Total call under 55s | High |
| 2.6 | **Unplug while it is waiting** | Refused. Must not hang. The reason will be wallet-cli's, not the probe's | High |
| 2.7 | **Unplug, then plug back in, run again** | Approves normally. Nothing is left in a bad state | Medium |
| 2.8 | **A different Ledger app open, for example Bitcoin** | Refused or the device prompts to open Ethereum. Either is acceptable, a hang is not | Medium |
| 2.9 | **`PREFLIGHT_GATE=off` on a HIGH address** | Refused with `device confirmation disabled by PREFLIGHT_GATE=off; not approved by a human`. Never approved | **Critical.** Disabling a guard rail must not read as approval |
| 2.10 | **A LOW address with the device unplugged** | Succeeds normally. The gate is only summoned by HIGH | High |

### 2.11 The credential store is load-bearing

```bash
grep -cE '^(ETHERSCAN_API_KEY|GRAPH_API_KEY|OPENAI_API_KEY)=.+' .env
```

**Expected: `0`.** No plaintext credential exists anywhere on disk. Then run 1.1 again and
confirm it still returns a verdict with 11/11 coverage. The ciphertext in `secrets/` is the
only copy. **Critical**, this is half the Ledger claim.

### 2.12 The Key Ring works with the device unplugged

Unplug the Nano and run 1.1. **Expected:** credentials still decrypt. `ring init` provisions the
trustchain once; everything after runs against local member credentials. That property is what
makes this usable on a server, and it is what Ledger's track asks about. **Critical.**

### 2.13 Break the passphrase deliberately

```bash
WALLET_PASS=wrong node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x6B175474E89094C44Da98b954EedeAC495271d0F 1
```

**Expected:** `key ring:` error lines naming each credential, and signals reporting they could
not run. Coverage falls below 60% and `preflight_check` returns an **error, not a clean
verdict**. **Critical.** An outage must never read as a pass.

---

## Part 3 — Adversarial and edge data

### 3.1 Malformed input, rejected before any network call

| Input | Expected |
|---|---|
| `0x123` | Schema rejection: "must be a 20-byte hex address" |
| `not-an-address` | Same |
| `0xZZZZ…` (non-hex) | Same |
| Empty string | Same |
| `0x6B175474E89094C44Da98b954EedeAC495271d0F` with chainId `99999` | Verdict returns. Market signals report `no Uniswap V3 subgraph indexed for chain 99999` |

**Failure looks like:** a crash, or a verdict for a malformed address. **High.**

### 3.2 An address that has never existed

```bash
PREFLIGHT_GATE=off node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x1111111111111111111111111111111111111111 1
```

**Expected:** MEDIUM 35, coverage 11/11, `not-a-contract` fired, every other signal saying
"not applicable, the address is a wallet" rather than erroring. **Medium.**

### 3.3 Injection payloads are contained, not executed

```bash
pnpm test -- corpus
```

**Expected:** 37 payloads across 6 sites and 10 attack classes, **33 detected, 4 known misses**,
10 cells documented as impossible. The four misses are listed by name and are deliberate.

Then check the containment itself is visible in a real verdict. Any run in part 1 should show
values wrapped like:

```
<untrusted id="8ae3a03d">Dai</untrusted>
```

and a trailer explaining that the id is generated per response and cannot be predicted by the
contract author. **Critical if absent**: the delimiter is the whole prompt-injection defence.

### 3.4 Unicode, homoglyphs and invisible characters

Covered deterministically by the corpus. To see it by hand:

```bash
pnpm test -- rules
```

**Expected:** 22 passing, including bidi overrides, zero-width characters and mixed-script
identifiers. **High** if any fail.

### 3.5 An unverified contract

```bash
PREFLIGHT_GATE=off node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x27c4D500d5db8c9112aE3847beB8042fE3413BdE 1
```

**Expected:** DOTT, HIGH 75. `unverified-source` fires. The three source-dependent checks say
"not assessable: contract source is not verified" rather than reporting clean. **Critical**:
not seeing a risk is not the same as finding none.

### 3.6 A token with no Uniswap market at all

```bash
PREFLIGHT_GATE=off node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x514910771AF9Ca656af840dff83E8264EcF986CA 8453
```

LINK's Ethereum address queried on Base, which is a real mistake a user makes. **Expected:**
HIGH 65, `no-market` and `unverified-source` fire, and three checks report they could not run
because Etherscan's free tier does not serve Base creation records. **Medium.**

### 3.7 Score exactly on a boundary

Bands are `clean` 0-14, `low` 15-34, `medium` 35-59, `high` 60-100.

```bash
pnpm test -- score
```

**Expected:** 8 passing, including the boundary values. A single signal of weight 0.35 produces
exactly 35, which must read MEDIUM, not LOW. **Medium.**

### 3.8 Concurrent calls

Run three checks at once in three terminals, different addresses. **Expected:** three
independent verdicts, three distinct ids, no interleaved output, no crash. Etherscan calls are
throttled process-wide to one every 360ms, so each process is internally serialised but they do
not coordinate with each other; expect the runs to be slower, not wrong. **Medium.**

### 3.9 Network failure

```bash
GRAPH_API_KEY=invalid PREFLIGHT_GATE=off node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x6B175474E89094C44Da98b954EedeAC495271d0F 1
```

Note this only works if the Key Ring does not overwrite it; the Key Ring wins, so instead move
`secrets/graph.enc` aside temporarily.

**Expected:** the four market signals report an error each. Coverage 7/11 is above the floor, so
a verdict still returns with the gap stated. **High** if a gateway failure is reported as "this
token has no market".

### 3.9b The call always answers inside the caller's deadline

The MCP client gives a tool call sixty seconds. Preflight must always return something
inside that, because a transport timeout is not an answer: the agent learns nothing, and a
judge sees a broken tool rather than a working refusal.

Three things enforce it. Etherscan calls time out at 8s each, the model at 15s with retries
disabled, and the gate is handed only the budget the analysis did not already spend.

To see the last one, run a HIGH address with the device attached and do not press:

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x160de4468586B6B2F8a92FEB0c260fc6cFC743B1 1
```

**Expected:** a refusal naming the wait, with the total call comfortably under 60 seconds.
**Failure looks like:** `McpError: MCP error -32001: Request timed out`, followed by an EPIPE
stack trace from the server. **Critical.** That combination is exactly the bug this section
exists to catch, and it happened on 2026-09-11.

### 3.10 Rate limit

Run 1.2 twice back to back. Etherscan's free tier allows three calls a second and says so in the
body rather than a header. **Expected:** either everything passes because of the client-side
throttle, or signals report `Max rate limit reached` as errors and coverage falls. **Critical**
if a rate limit produces a CLEAN verdict.

---

## Part 4 — What the agent actually sees

The point of the project is that this runs inside an agent, so test it there.

1. From inside the repository, run `claude`. The project ships `.mcp.json`, so nothing else is
   needed. Approve the server when prompted.
2. `/mcp` should list **preflight** with three tools.
3. Ask, in plain language: *"I am about to approve a token at 0x160de4468586B6B2F8a92FEB0c260fc6cFC743B1 on Ethereum. Is that safe?"*

**Expected:** the agent calls `preflight_check` on its own, receives the refusal, and tells you
not to sign. **The thing to watch for:** the agent must not talk itself past the refusal using
the contract's own name or the model summary. If it does, the delimiter trailer is not doing its
job. **Critical.**

4. Plug the Ledger in, ask again, press the button. The agent should report that a human
   approved it on hardware.

---

## Part 5 — Five-minute pre-demo checklist

Run this immediately before recording. Nothing here takes thought.

```bash
cd preflight
pnpm check                                    # exit 0
pnpm test                                     # 142 passed
docker compose ps                             # db healthy
security find-generic-password -a default -s ledger-wallet-cli -w > /dev/null && echo PASS_OK
wallet-cli --version                          # 2.1.0
grep -cE '^(ETHERSCAN_API_KEY|GRAPH_API_KEY|OPENAI_API_KEY)=.+' .env   # must print 0
```

Then, with the Ledger plugged in and unlocked:

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x6B175474E89094C44Da98b954EedeAC495271d0F 1
```

- Credentials decrypt, storage postgres, **LOW 20, coverage 11/11**, about 12 seconds.

Then unplug the Ledger and run:

```bash
node --env-file=.env --import tsx scripts/mcp-smoke.ts 0x160de4468586B6B2F8a92FEB0c260fc6cFC743B1 1
```

- **HIGH 94, refused in about 13 seconds**, agent told not to sign.

Plug it back in, run the same command, press the button.

- **Approved on hardware.**

If all three behave, record. If any of them does not, fix it before recording, because the
demo is these three moments.
