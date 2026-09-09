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

printf '%s' "$ETHERSCAN_API_KEY"  | wallet-cli ring encrypt --key preflight-etherscan --out secrets/etherscan.enc
printf '%s' "$GRAPH_API_KEY"      | wallet-cli ring encrypt --key preflight-graph     --out secrets/graph.enc
printf '%s' "$ANTHROPIC_API_KEY"  | wallet-cli ring encrypt --key preflight-anthropic --out secrets/anthropic.enc

unset WALLET_PASS
```

Scoped key names rather than one key for everything, so a credential can be
rotated on its own.

## Using them

Nothing to do. `bin/preflight-mcp` pulls the passphrase from the OS keychain at
spawn and the server decrypts whatever is present into its own environment.
Values from the Key Ring take precedence over `.env`.

Neither encrypting nor decrypting needs the device. `ring init` provisions the
trustchain once with the Ledger attached; every operation after that runs
against local member credentials. That is what makes this usable on a server,
and it is the property Ledger's track asks about.
