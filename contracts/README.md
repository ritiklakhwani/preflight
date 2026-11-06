# contracts

`CaplineVault.sol` holds the owner's funds per agent and releases budget tranches
to the agent wallet only when the owner's passkey (WebAuthn, P256, user
verification required) signs an EIP-712 approval. Owner actions: `release`,
`drop` (kill switch), `undrop`, `withdraw`. Anyone can relay; the agent has no
special power. Interface: `docs/CAPLINE_SPEC.md`. ABI: `abi/CaplineVault.json`.
State getter: `getAgent(address)` (alias `agents(address)`), returns the struct.

`src/demo/PartnerSink.sol` is a demo-only fresh, unverified "partner" that a
hijacked agent gets tricked into paying. Do not verify it.

| Network | Chain id | Why |
|---|---|---|
| Whitechain Sepolia | 1874 | Paying agent, settles in the official test USDT |
| Base | 8453 | Trading agent, places Flash advanced orders |

New at ETHGlobal Mumbai 2026; Preflight had no contracts before this event.

## Test

```bash
cd contracts
forge build
forge test -vv          # real P256 WebAuthn signatures via vm.signP256
forge test --gas-report
```

Release costs about 361k gas with OZ's Solidity P256 fallback and about 129k
with the RIP-7212 precompile (Whitechain and Base both have it).

## Deploy

```bash
set -a; source ../.env; set +a
forge script script/Deploy.s.sol --rpc-url whitechain_sepolia --broadcast
forge script script/DeployPartnerSink.s.sol --rpc-url whitechain_sepolia --broadcast
forge script script/Deploy.s.sol --rpc-url base --broadcast
forge inspect CaplineVault abi --json > abi/CaplineVault.json   # after any change
```

## Verify

Whitechain (Blockscout, trailing `/api/` required):

```bash
forge verify-contract <VAULT> src/CaplineVault.sol:CaplineVault --chain 1874 \
  --verifier blockscout --verifier-url https://explorer.testnet.whitechain.io/api/ --watch
```

Base: `forge verify-contract <VAULT> src/CaplineVault.sol:CaplineVault --chain base --etherscan-api-key $ETHERSCAN_API_KEY --watch`

## Register an agent

The funder (`DEPLOYER_PRIVATE_KEY`) approves the token and funds the vault side.
`QX`/`QY` come from the phone app's passkey setup screen. `AMOUNT` is base units
(USDT has 6 decimals).

```bash
VAULT=$CAPLINE_VAULT_WHITECHAIN AGENT=0x... QX=0x... QY=0x... \
TOKEN=$WHITECHAIN_USDT AMOUNT=20000000 \
forge script script/Register.s.sol --rpc-url whitechain_sepolia --broadcast
```
