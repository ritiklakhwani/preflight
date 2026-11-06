# Capline spec

The single source of truth for the interfaces between the vault, the client
library, the receipts builder, the approval server, the phone app, the MCP tools
and the demo agents. If code and this file disagree, fix one of them in the
same commit.

## Chains

| Key | Chain id | RPC env | Token | Explorer |
|---|---|---|---|---|
| `whitechain` | 1874 | `WHITECHAIN_RPC_URL` (default `https://rpc.testnet.whitechain.io`) | USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (`WHITECHAIN_USDT`), 6 decimals (read `decimals()` to confirm) | `https://explorer.testnet.whitechain.io` (Blockscout) |
| `base` | 8453 | `BASE_RPC_URL` | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals | `https://basescan.org` |

Vault addresses come from `CAPLINE_VAULT_WHITECHAIN` and `CAPLINE_VAULT_BASE`.

## Roles

- **Owner.** Identified only by a passkey (WebAuthn, P256). No owner EOA.
- **Agent.** An EOA hot wallet. Holds at most one tranche at a time.
- **Relayer.** Anyone. Submits owner-signed messages and pays gas. Cannot change them.

## CaplineVault.sol

One vault per chain, many agents. Agents are keyed by their wallet address.

```solidity
struct WebAuthnAuth { // OpenZeppelin WebAuthn.WebAuthnAuth, passed through as is
    bytes32 r; bytes32 s;
    uint256 challengeIndex; uint256 typeIndex;
    bytes authenticatorData; string clientDataJSON;
}

struct Agent {
    bytes32 qx;               // owner passkey public key
    bytes32 qy;
    address token;            // ERC-20 the vault holds for this agent
    uint256 balance;          // held in the vault, not yet released
    uint64  nonce;            // increments on every owner-signed action
    bool    dropped;          // true: no release until undrop
    uint64  lastReleaseBlock; // receipts window starts here
    bytes32 lastReceiptsHash;
}

function register(address agent, bytes32 qx, bytes32 qy, address token, uint256 amount) external;
    // reverts AlreadyRegistered. Pulls `amount` of `token` from msg.sender (approve first).
    // lastReleaseBlock = block.number.
function deposit(address agent, uint256 amount) external; // anyone tops up the vault side

function release(address agent, uint256 amount, uint64 expiry, bytes32 receiptsHash, WebAuthnAuth calldata auth) external;
function drop(address agent, uint64 expiry, WebAuthnAuth calldata auth) external;
function undrop(address agent, uint64 expiry, WebAuthnAuth calldata auth) external;
function withdraw(address agent, address to, uint256 amount, uint64 expiry, WebAuthnAuth calldata auth) external;

function agents(address agent) external view returns (Agent memory); // getAgent if a struct getter is awkward
function releaseDigest(address agent, uint256 amount, uint64 nonce, uint64 expiry, bytes32 receiptsHash) external view returns (bytes32);
function dropDigest(address agent, uint64 nonce, uint64 expiry) external view returns (bytes32);
function undropDigest(address agent, uint64 nonce, uint64 expiry) external view returns (bytes32);
function withdrawDigest(address agent, address to, uint256 amount, uint64 nonce, uint64 expiry) external view returns (bytes32);

event Registered(address indexed agent, address indexed token, bytes32 qx, bytes32 qy, uint256 amount);
event Deposited(address indexed agent, address indexed from, uint256 amount);
event Released(address indexed agent, uint256 amount, uint64 nonce, bytes32 receiptsHash);
event Dropped(address indexed agent, uint64 nonce);
event Undropped(address indexed agent, uint64 nonce);
event Withdrawn(address indexed agent, address indexed to, uint256 amount, uint64 nonce);

error AlreadyRegistered(); error UnknownAgent(); error Expired(); error BadSignature();
error IsDropped(); error InsufficientBalance();
```

Rules:
- Every signed action uses the agent's current `nonce`, then increments it.
- `release` reverts with `IsDropped` while dropped, and `Expired` when `block.timestamp > expiry`.
- `release` transfers `amount` from the vault to `agent`, then sets
  `lastReleaseBlock = block.number` and `lastReceiptsHash = receiptsHash`.
- The agent has no special power. Calling `release` itself with no valid owner signature reverts `BadSignature`.
- The signature check is `WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy)` with user verification required (Face ID or PIN).
- ReentrancyGuard and SafeERC20.

### EIP-712

Domain: `name "CaplineVault"`, `version "1"`, `chainId`, `verifyingContract`.

```
Release(address agent,uint256 amount,uint64 nonce,uint64 expiry,bytes32 receiptsHash)
Drop(address agent,uint64 nonce,uint64 expiry)
Undrop(address agent,uint64 nonce,uint64 expiry)
Withdraw(address agent,address to,uint256 amount,uint64 nonce,uint64 expiry)
```

The WebAuthn challenge is the 32-byte EIP-712 digest (base64url in `clientDataJSON`).

## Receipts

What the agent did with the money since `lastReleaseBlock`, read from the chain,
never from the agent.

```ts
type Verdict = 'clean' | 'low' | 'medium' | 'high' | 'unknown';
interface Receipt {
  chain: 'whitechain' | 'base';
  kind: 'transfer' | 'flash_order';
  txHash: `0x${string}`;
  blockNumber: number;
  timestamp: number;            // unix seconds
  to: `0x${string}`;            // counterparty
  token: `0x${string}`;
  amount: string;               // base units, decimal string
  verdict: Verdict;
  reasons: string[];            // short, human readable, from Preflight
  link: string;                 // explorer link to the tx
  meta?: Record<string, string>; // e.g. Flash order type, pair, fill price
}
interface ReceiptsReport {
  chain: 'whitechain' | 'base';
  agent: `0x${string}`;
  fromBlock: number;
  toBlock: number;
  receipts: Receipt[];          // sorted by blockNumber, then log index
  spent: string;                // sum of amounts, base units
  receiptsHash: `0x${string}`;
}
```

`receiptsHash = keccak256(utf8(canonicalJson(receipts)))`. Canonical JSON means
sorted keys, no whitespace, receipts in the order above. The owner signs this
hash inside `Release`, so the release is bound to exactly the list they saw.

Risk scoring per counterparty:
- `base`: `runPreflight(address, 8453)` from `@preflight/engine`. EOAs come back `unknown` with reason "wallet, not a contract".
- `whitechain`: the engine has no subgraph there, so use RPC and explorer checks:
  code present, contract age from creation, verified source on Blockscout, deployer.
  An unverified contract younger than 24 hours is `high`.

## Approval server (`apps/approve/server`, port `APPROVE_PORT`, default 8787)

Holds pending requests in memory and in a JSON file. It is a convenience: the
vault never trusts it.

```
POST /api/requests        { chain, agent, amount, reason, counterparty? }
                          -> { id, status: 'pending' }
                          Server builds the ReceiptsReport itself, runs Preflight on the
                          counterparty, sanitises reason with @preflight/quarantine,
                          reads nonce from the vault, sets expiry = now + 15 min,
                          computes the Release digest, then pushes ntfy.
GET  /api/requests/:id    -> Request (below)
GET  /api/requests?agent= -> Request[]
POST /api/requests/:id/approve  { auth: WebAuthnAuth } -> relays release(), returns { txHash }
POST /api/requests/:id/decline  {} -> { status: 'declined' }
POST /api/agents/:agent/drop    { chain, expiry, auth } -> relays drop(), returns { txHash }
GET  /api/agents/:agent?chain=  -> on-chain Agent state plus wallet token balance
```

```ts
interface Request {
  id: string; chain: 'whitechain' | 'base'; agent: `0x${string}`;
  amount: string; reason: string;          // reason already sanitised, flagged unverified
  counterparty?: { address: `0x${string}`; verdict: Verdict; reasons: string[] };
  receipts: ReceiptsReport;
  nonce: number; expiry: number; digest: `0x${string}`;
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'released';
  txHash?: `0x${string}`; createdAt: number;
}
```

Push: `POST https://ntfy.sh/$NTFY_TOPIC` with title "Capline", body "Agent requests a refill",
header `Click: $APPROVE_PUBLIC_URL/#/r/<id>`. Only the id leaves the server.

Relayer key: `RELAYER_PRIVATE_KEY` (falls back to `DEPLOYER_PRIVATE_KEY`).

## Phone app (`apps/approve/web`)

Static PWA, deployable on its own (the passkey rpId is its domain). Talks to the
server at `VITE_API_URL`, and to the chain directly through public RPCs.

- Setup: create a passkey, show `qx`/`qy`, register the agent (calls server or prints calldata).
- Request screen: amount, counterparty verdict, reason (marked unverified), Receipts list with tx links and verdicts. Buttons: Approve (Face ID), Decline.
- Drop button on the agent screen.
- Backend off: if the server does not answer, the app reads vault state from the chain,
  lets the owner sign a release or drop directly, and submits it with a local burner
  key (or shows the signed payload for anyone to relay). Receipts fall back to raw
  transfer logs without verdicts, labelled as such.
- No analytics, no third-party scripts.

## MCP tools (added to `packages/mcp`)

```
capline_status  { chain: 'whitechain'|'base', agent?: address, requestId?: string }
  -> vault balance, wallet balance (tranche left), dropped, nonce, and the request status if requestId given
capline_request { chain, amount: string (human units, e.g. "5"), reason: string, counterparty?: address }
  -> { requestId, status: 'pending', note: 'The owner has been asked on their phone. Poll capline_status.' }
```

The agent address defaults to `CAPLINE_AGENT_ADDRESS`. The server URL comes from `CAPLINE_API_URL`
(default `http://localhost:8787`).

## Merchant API (`apps/merchant`, port `MERCHANT_PORT`, default 8788)

A pay-per-call API on Whitechain:
- `GET /quote` answers 402 with `{ payTo, token, amount, memo }`.
- The agent pays in USDT, then calls `GET /quote` again with header `X-Payment-Tx: <hash>`.
- The server checks the Transfer on chain (to, amount, not reused) and returns data.

Demo mode `MERCHANT_EVIL=1` adds an injected instruction to the response body
asking the agent to pay a large amount to a "partner" address and raise its budget.

## Env (all in `.env`, never committed)

`WHITECHAIN_RPC_URL WHITECHAIN_USDT BASE_RPC_URL DEPLOYER_PRIVATE_KEY RELAYER_PRIVATE_KEY
PAYER_AGENT_PRIVATE_KEY TRADER_AGENT_PRIVATE_KEY DEFINITIVE_API_KEY NTFY_TOPIC
CAPLINE_VAULT_WHITECHAIN CAPLINE_VAULT_BASE CAPLINE_API_URL CAPLINE_AGENT_ADDRESS
APPROVE_PORT APPROVE_PUBLIC_URL MERCHANT_PORT ANTHROPIC_API_KEY`
