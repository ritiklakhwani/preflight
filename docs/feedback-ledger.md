# Ledger developer-experience feedback

Written during ETHOnline 2026 while building Preflight, which uses the Ledger Key Ring
Protocol as the credential backend for an autonomous agent service and the Ledger device
as the human confirmation step before a high-severity verdict is allowed to proceed.

Everything below is first-run experience, recorded as it happened, not reconstructed.

| | |
|---|---|
| Tool | `@ledgerhq/wallet-cli` v2.1.0 |
| Device | Ledger Nano S Plus, purchased at ETHGlobal Singapore 2024 |
| Host | macOS, Darwin 23.6.0, Apple silicon |
| Date | 2026-09-06 |
| Prior Ledger CLI experience | None |

---

## 1. What worked, and why it mattered to us

**Headless decrypt after one provisioning tap is the whole reason this project exists.**

We needed to know one thing before committing an architecture: can a service holding
Ledger-encrypted credentials decrypt them while the device is unplugged? We ran the canary
before writing any application code.

```
wallet-cli ring init          # device connected, one confirmation
# device physically unplugged
printf '%s' "preflight-canary" | wallet-cli ring encrypt -k preflight-canary -o /tmp/canary.enc
wallet-cli ring decrypt -k preflight-canary -i /tmp/canary.enc
```

Result: encrypt and decrypt both succeeded with the device disconnected. That single
property is what makes it possible to enroll a CI runner or a hosted agent, and it is the
property we built on.

`genuine-check` passing against a two-year-old device with no fuss was also reassuring in
a way that is easy to under-value. It answered "is this thing still trustworthy" in one
command.

## 2. Where we got stuck

### 2.1 The command `ring init` tells you to run next blocks on stdin with no indication

Verbatim output on successful provisioning:

```
wallet-cli ring init

✔ Member credentials created
✔ Ledger Key Ring ready

Member:  Ritiks-MacBook-Air.local (darwin)
Root ID: <redacted>
Encrypt/decrypt with: wallet-cli ring encrypt --key <name>
```

The printed next step omits `-i` and `-o`. Copying it literally gives you a command that
silently waits on stdin. Nothing is printed, no prompt appears, and the natural read is
that the CLI has hung after a device operation. `ring encrypt --help` does document the
behaviour clearly:

```
Encrypt data with a key from your Ledger Key Ring. Files via -i/-o, text via stdin/stdout.
```

So the gap is between the hint and the help, not a missing feature. The completion screen
is the highest-attention moment in the whole flow and it is the one place a new user has
not yet learned to run `--help`.

**Suggested fix:** print a runnable example rather than a shape.

```
Encrypt:  printf '%s' "secret" | wallet-cli ring encrypt --key my-app --out my-app.enc
Decrypt:  wallet-cli ring decrypt --key my-app --in my-app.enc
```

### 2.2 `ring keys` reports "No keys yet" immediately after a success screen

Run back to back:

```
wallet-cli ring init
✔ Member credentials created
✔ Ledger Key Ring ready

wallet-cli ring keys
No keys yet. Use `ring encrypt --key <name>` to create one.
```

Both messages are correct. `init` provisions member credentials; named keys are derived
lazily on first `encrypt`. But read in sequence, twenty seconds apart, it looks like the
provisioning that just required a physical confirmation did not persist. We re-ran
`ring init` to check, which is exactly the wrong instinct to encourage on a command that
touches a trustchain.

**Suggested fix:** distinguish the two states in the message.

```
Key ring provisioned. No named keys derived yet.
Keys are created on first use: wallet-cli ring encrypt --key <name> ...
```

### 2.3 The device requirement matrix is the most valuable fact and the hardest to find

For anyone building an agent, "which of these commands needs the device plugged in" is the
first architectural question, and answering it wrong costs a day. It exists in the docs,
but it is prose, not a table, and it is not surfaced anywhere in `--help`.

**Suggested fix:** a device-required column in the command reference, and a one-line note
in `ring --help`:

```
Device required for: init. Not required for: encrypt, decrypt, keys.
```

## 3. What we would use next if it existed

**A `ring` entry in `LedgerHQ/agent-skills`.** The repo teaches agents to wire Ledger into
applications. Nothing there covers using the Key Ring as a credential store for a service
that decrypts headlessly after one provisioning tap, which is the pattern we ended up
building and, we suspect, the pattern most agent authors actually need. We are happy to
contribute ours.

**A non-transacting confirmation primitive.** Our gate needs a human to physically approve
a decision that is not a transaction. Today the options are to sign something on a testnet
or to use `receive` for its on-device verification prompt, both of which are proxies for
what we mean. A `ring confirm <message>` that shows text on the device and exits non-zero
on rejection would be exact, and would generalise well beyond us.

## 4. Smaller notes

- `--unsecure-no-password` is well named. It made the risk obvious enough that we routed
  the passphrase through the macOS Keychain instead, on the first try.
- Scoped key names (`--key preflight-etherscan`, `--key preflight-anthropic`) map cleanly
  onto per-credential separation. We did not have to invent a convention.
- Install via `pnpm add -g @ledgerhq/wallet-cli` worked first time with no native build
  step, which is not the norm for hardware tooling.

---

Filed against `@ledgerhq/wallet-cli` v2.1.0. Items 2.1 and 2.2 are small enough that we
would rather send patches than file issues; see the pull request linked from the project
README.
