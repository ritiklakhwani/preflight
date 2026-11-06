#!/usr/bin/env bash
# Deploys CaplineVault to Base with BASE_DEPLOYER_PRIVATE_KEY and verifies it on
# Sourcify (no explorer API key needed; Basescan reads Sourcify matches).
set -euo pipefail
cd "$(dirname "$0")/.."
get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
rpc=$(get BASE_RPC_URL); rpc=${rpc:-https://mainnet.base.org}
key=$(get BASE_DEPLOYER_PRIVATE_KEY)
[ -n "$key" ] || { echo "BASE_DEPLOYER_PRIVATE_KEY missing"; exit 1; }
cd contracts
DEPLOYER_PRIVATE_KEY="$key" WHITECHAIN_RPC_URL=https://rpc.testnet.whitechain.io BASE_RPC_URL="$rpc" \
  forge script script/Deploy.s.sol --rpc-url "$rpc" --broadcast >/dev/null
vault=$(python3 -c "import json;d=json.load(open('broadcast/Deploy.s.sol/8453/run-latest.json'));print([t['contractAddress'] for t in d['transactions'] if t.get('contractAddress')][0])")
echo "CaplineVault on Base: $vault"
forge verify-contract "$vault" src/CaplineVault.sol:CaplineVault --chain 8453 --verifier sourcify --watch || true
cd ..
grep -q '^CAPLINE_VAULT_BASE=.\+' .env || printf 'CAPLINE_VAULT_BASE=%s\n' "$vault" >> .env
echo "Saved CAPLINE_VAULT_BASE to .env"
