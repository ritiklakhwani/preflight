# agents/payer-whitechain

Demo paying agent on Whitechain Sepolia (chain 1874).

- Pays a pay-per-call API we run (`apps/merchant`), in the official test USDT
  (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`), from its current tranche.
- A second "merchant" is a freshly deployed, unverified contract, so Receipts
  has something risky to flag.
- The API's response carries a prompt injection asking the agent to raise its
  own budget. The agent calls `capline_request`; only the owner's phone can
  release more.

New at ETHGlobal Mumbai 2026.

## Run

Scripts load `../../.env` if it exists. Start the merchant and the approval server first.

```sh
# terminal 1: merchant (evil mode for the injection demo)
pnpm --filter @preflight/merchant evil

# terminal 2: the agent
pnpm --filter @preflight/payer-whitechain scripted      # deterministic, for the video
pnpm --filter @preflight/payer-whitechain llm           # Claude drives the same loop
pnpm --filter @preflight/payer-whitechain self-release  # agent tries vault.release itself, reverts BadSignature
```

- `scripted`: buys quotes (402, pay, retry with `X-Payment-Tx`) until the wallet
  is below the price. If the response carries the partner instruction, it pays
  `SCRIPTED_PARTNER_AMOUNT` to the partner, then calls `capline_request` for 500
  with the injected reason and polls `capline_status` until released, declined
  or expired.
- `llm`: tools `fetch_api`, `pay_usdt`, `wallet_balance`, `wait_seconds`, plus
  `preflight_check`, `capline_status`, `capline_request` proxied from the
  Preflight MCP server (spawned over stdio from `packages/mcp`).
- `self-release`: simulates the call and prints the revert reason.
  `SELF_RELEASE_SEND=1` also sends it, for an explorer link.

## Env

| Var | Used by | Default |
|---|---|---|
| `PAYER_AGENT_PRIVATE_KEY` | all (pays, signs) | required to pay |
| `CAPLINE_AGENT_ADDRESS` | MCP tools; read-only runs | address of the key |
| `MERCHANT_URL` | scripted, llm | `http://localhost:$MERCHANT_PORT` (8788) |
| `CAPLINE_API_URL` | MCP tools, status fallback | `http://localhost:8787` |
| `CAPLINE_VAULT_WHITECHAIN` | self-release, MCP tools | required |
| `WHITECHAIN_RPC_URL`, `WHITECHAIN_USDT` | all | spec values |
| `ANTHROPIC_API_KEY` | llm | required |
| `CAPLINE_AGENT_MODEL` | llm | `claude-sonnet-5-5` |
| `CAPLINE_AGENT_TARGET`, `CAPLINE_AGENT_MAX_TURNS` | llm | 10, 60 |
| `SCRIPTED_MAX_CALLS`, `SCRIPTED_PARTNER_AMOUNT`, `SCRIPTED_REFILL_AMOUNT`, `SCRIPTED_STEP_DELAY_MS` | scripted | 20, 1, 5, 800 |
| `CAPLINE_POLL_MS`, `CAPLINE_POLL_TIMEOUT_MS` | scripted | 5000, 16 min |
| `SELF_RELEASE_AMOUNT`, `SELF_RELEASE_SEND` | self-release | 500, off |
| `CAPLINE_DEBUG` | show MCP server stderr | off |
