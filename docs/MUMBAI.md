# ETHGlobal Mumbai 2026: Preflight Capline (Continuity track)

> Your agent stays under the line until you've seen the receipts.

## Starting point

| What | Value |
|---|---|
| Base project | Preflight, ETHOnline 2026 (Ledger Continuity, 2nd place) |
| Starting commit | `a187cf313d4d769e165e4332e8f165cd11d976a1`, 2026-09-13 |
| Tag | `mumbai-2026-start` points at that commit |
| Earlier submission | ETHOnline 2026 showcase page: _link to add_ |

Everything judged for Mumbai is the diff:

```bash
git diff mumbai-2026-start..HEAD
```

## Before: what existed at the starting commit

Preflight, an MCP server an agent calls before it signs. It scores a contract on
what it has done onchain (Uniswap V3 history through The Graph, Etherscan), seals
untrusted onchain strings before a model reads them, and sends a HIGH verdict to
a Ledger device for a physical press. Packages: `core`, `analysis`, `signals`,
`engine`, `mcp`, `quarantine`, `gate`. No contracts, no web app. See the main
README for the full before-state.

## During: what this weekend adds

**Capline.** Preflight checks what an agent touches; Capline decides whether it
gets more money.

| Piece | Path | What it does |
|---|---|---|
| CaplineVault | `contracts/` | Holds the owner's funds; releases a tranche only on the owner's passkey signature |
| Vault client | `packages/capline/` | Chain config, EIP-712 types, release and status calls |
| Receipts | `packages/receipts/` | What the last tranche bought, rebuilt from chain data, each counterparty risk-scored by Preflight |
| MCP tools | `packages/mcp/` | `capline_status`, `capline_request`, next to the existing three tools |
| Pocket Approve | `apps/approve/` | Phone PWA: receipts, Face ID approve, decline, drop |
| Demo agents | `agents/` | Paying agent on Whitechain (USDT), trading agent on Base (Flash) |

Partners: Whitechain (Continuity), Definitive (Continuity), Ethereum Foundation
(CROPS upgrade).

## Deployments

| Contract | Chain | Address |
|---|---|---|
| CaplineVault (verified) | Whitechain Sepolia 1874 | [`0x31529ef8ec96f7a1bc5ea0166b3c040b1b95bbee`](https://explorer.testnet.whitechain.io/address/0x31529ef8ec96f7a1bc5ea0166b3c040b1b95bbee) |
| PartnerSink (demo, left unverified on purpose) | Whitechain Sepolia 1874 | [`0x4FECAE863ef2A0c64e211336C2bFCc822165c98a`](https://explorer.testnet.whitechain.io/address/0x4FECAE863ef2A0c64e211336C2bFCc822165c98a) |

## Changelog

| Date (IST) | Change |
|---|---|
| 2026-11-06 | Workspace scaffolded: `contracts/`, `packages/capline`, `packages/receipts`, `apps/approve`, `agents/`, this file, WHITECHAIN_FEEDBACK.md |
| 2026-11-06 | CaplineVault with passkey (WebAuthn P256) releases, 21 forge tests with real P256 signatures |
| 2026-11-06 | `@preflight/capline` client, MCP tools `capline_status` and `capline_request` |
| 2026-11-06 | Receipts builder: Whitechain via Blockscout and RPC, Base via the Preflight engine |
| 2026-11-06 | Pocket Approve server and phone app, merchant API, paying agent, Flash trading agent |
| 2026-11-06 | Preflight engine fix: market signals use the most-traded pool, so priced-up junk pools no longer flag WETH on Base |
