# Whitechain feedback

Written as we build, so each line is something we hit, not something recalled
afterwards.

## What worked

- Chain id 1874 and `https://rpc.testnet.whitechain.io` were reliable all weekend.
- Cancun opcodes work, so the vault deployed and ran without changing the EVM target.
- The P256 precompile (RIP-7212) is present. Our passkey check costs about 129k gas per
  release with it, against about 361k with the Solidity fallback.
- `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.whitechain.io/api/`
  verified CaplineVault first try. The trailing `/api/` is needed.
- The Etherscan-style `getsourcecode` call on the explorer works, so we read verified
  status the same way we do on other chains.

## Where we got stuck

- `eth_getLogs` is capped at 10,000 blocks per query. With 1-second blocks that is under
  three hours, so reading an agent's USDT transfers means paging through many ranges.
- Test USDT is owner-mint only, so every builder depends on DevRel to get any.
- The faucet needs a GitHub account older than 30 days.
- Blockscout v2 `/api/v2/smart-contracts/<address>` has no `is_verified` field for the
  USDT proxy, so it cannot be used to check verification. `getsourcecode` works.

## What the docs were missing

- Contract verification is not mentioned. The forge command above is the one
  that worked for us; a line with it in the deploy guide would save every team the search.
