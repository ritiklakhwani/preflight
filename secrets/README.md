# Encrypted credentials

Files here are ciphertext, encrypted against a Ledger Key Ring trustchain. They
are committed on purpose: without the trustchain they are useless, and the
repository is how they travel between machines.

Plaintext is never committed. `.gitignore` allows `*.enc` in this directory and
nothing else.

## Creating them

Provision the machine once, with the device attached:

```bash
wallet-cli ring init
```

Then, for each credential. The passphrase comes from the OS keychain rather
than the shell, so it never enters shell history:

```bash
export WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w)

read -rs NEWKEY   # typed, never echoed, never in history
printf '%s' "$NEWKEY" | wallet-cli ring encrypt --key preflight-etherscan --out secrets/etherscan.enc
unset NEWKEY
```

The four scoped keys this project uses:

| Key | File | Holds |
|---|---|---|
| `preflight-etherscan` | `secrets/etherscan.enc` | Etherscan V2, one key covers every chain |
| `preflight-graph` | `secrets/graph.enc` | The Graph gateway, from Subgraph Studio |
| `preflight-openai` | `secrets/openai.enc` | Advisory model summary |
| `preflight-anthropic` | `secrets/anthropic.enc` | Alternative to the above |

Verify a round trip without ever printing the value:

```bash
wallet-cli ring decrypt --key preflight-etherscan --input secrets/etherscan.enc | shasum -a 256
```

Then remove the plaintext from `.env`. That last step is the one that matters: an encrypted
copy sitting beside a working plaintext copy is decoration. Confirm it:

```bash
grep -cE '^(ETHERSCAN_API_KEY|GRAPH_API_KEY|OPENAI_API_KEY)=.+' .env   # must print 0
```

Scoped key names rather than one key for everything, so a credential can be
rotated on its own.

## Using them

Nothing to do. `loadRingSecrets` resolves the passphrase from the OS keychain
itself, so every entry point gets credentials: the MCP server, the benchmark,
the probes and `pnpm analyse`. Values from the Key Ring take precedence over
`.env`.

That was not always true. For a day the only thing that decrypted was the MCP
server, and because the plaintext had been removed from `.env` there was nothing
to fall back to. The failure was silent in the worst way: the benchmark ran all
twenty addresses, every network signal reported that it could not run, every
address scored clean, and the summary line read zero false positives.

Neither encrypting nor decrypting needs the device. `ring init` provisions the
trustchain once with the Ledger attached; every operation after that runs
against local member credentials. That is what makes this usable on a server,
and it is the property Ledger's track asks about.
