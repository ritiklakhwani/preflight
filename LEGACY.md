# Legacy: what came from Inspector AI (2024) and its current state

Base repo: https://github.com/Krane-Apps/inspector-ai-eth-singapore-2024
Base commit: `b9737ffde8c0e599a1187e815fcba9cf4642423d`

## Ported and still in use

| 2024 location | Now | Notes |
|---|---|---|
| `background.js` `fetchAllTokenData` (110-148) | `packages/analysis/src/etherscan.ts` | Migrated to the Etherscan V2 unified endpoint. API key moved out of source. `txlist` fetch dropped in favour of The Graph. |
| `background.js` `getAIReview` (150-222) | `packages/analysis/src/llm.ts` | Prompt structure and risk taxonomy preserved. Moved to `@anthropic-ai/sdk`, current model, structured JSON output. |
| `background.js` `generateSummary` (224-230) | `packages/analysis/src/llm.ts` `parseReview` | Kept as the fallback path when JSON parsing fails. |

## Dead, deliberately not revived

| 2024 component | Why |
|---|---|
| `background.js` `getGaiaAnalysis` (232-273) | GaiaNet node URL no longer resolves. |
| `background.js` `fetch1inchData` (53-88) | Routed through `inspector-proxy.replit.app`, which no longer runs. Replaced by The Graph standardized subgraphs, which see protocol-level positions rather than token metadata. |
| `background.js` `fetchTokenTransactions` (90-108) | Dead code in the original; never called by `analyzeContract`. |
| `packages/chrome-extension/*` UI | The 2026 surface is an MCP server, not a browser popup. |
| Community review system, NFT rewards | Not relevant to an agent-facing tool. |
| CCIP cross-chain review aggregation | Chainlink is not a selected partner for this submission. |

## Security defect inherited from the base

The 2024 build hardcoded live API credentials in source, committed to a public repository:

- `background.js:151` - Anthropic API key
- `background.js:91` and `background.js:111` - Etherscan API key

Both have been revoked, confirmed 2026-09-09. In the 2026 build no credential appears in
source: keys are read from the environment, and `.env` is ignored on the first line of
`.gitignore`. Moving them onto the Ledger Key Ring, so the service holds ciphertext rather
than secrets, is what `packages/gate` is for and is not built yet.
