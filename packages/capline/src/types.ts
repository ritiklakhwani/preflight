// Shared wire types, exactly as in docs/CAPLINE_SPEC.md. Used by the approval
// server, the phone app, @preflight/receipts and the MCP tools.

export type Verdict = 'clean' | 'low' | 'medium' | 'high' | 'unknown';

export interface Receipt {
  chain: 'whitechain' | 'base';
  kind: 'transfer' | 'flash_order';
  txHash: `0x${string}`;
  blockNumber: number;
  timestamp: number; // unix seconds
  to: `0x${string}`; // counterparty
  token: `0x${string}`;
  amount: string; // base units, decimal string
  verdict: Verdict;
  reasons: string[]; // short, human readable, from Preflight
  link: string; // explorer link to the tx
  meta?: Record<string, string>; // e.g. Flash order type, pair, fill price
}

export interface ReceiptsReport {
  chain: 'whitechain' | 'base';
  agent: `0x${string}`;
  fromBlock: number;
  toBlock: number;
  receipts: Receipt[]; // sorted by blockNumber, then log index
  spent: string; // sum of amounts, base units
  receiptsHash: `0x${string}`;
}

export type RequestStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'released';

export interface Request {
  id: string;
  chain: 'whitechain' | 'base';
  agent: `0x${string}`;
  amount: string; // base units, decimal string
  reason: string; // already sanitised, flagged unverified
  counterparty?: { address: `0x${string}`; verdict: Verdict; reasons: string[] };
  receipts: ReceiptsReport;
  nonce: number;
  expiry: number;
  digest: `0x${string}`;
  status: RequestStatus;
  txHash?: `0x${string}`;
  createdAt: number;
}

/** POST /api/requests body. `amount` is base units (use parseAmount). */
export interface CreateRequestInput {
  chain: 'whitechain' | 'base';
  agent: `0x${string}`;
  amount: string;
  reason: string;
  counterparty?: `0x${string}`;
}

/**
 * WebAuthnAuth over JSON. bigint does not survive JSON.stringify, so the two
 * indexes travel as decimal strings. Convert with authToJson / authFromJson.
 */
export interface WebAuthnAuthJson {
  r: `0x${string}`;
  s: `0x${string}`;
  challengeIndex: string;
  typeIndex: string;
  authenticatorData: `0x${string}`;
  clientDataJSON: string;
}

/** GET /api/agents/:agent?chain= response. Numbers as strings for the same reason. */
export interface AgentStateJson {
  chain: 'whitechain' | 'base';
  agent: `0x${string}`;
  qx: `0x${string}`;
  qy: `0x${string}`;
  token: `0x${string}`;
  balance: string; // vault side, base units
  nonce: string;
  dropped: boolean;
  lastReleaseBlock: string;
  lastReceiptsHash: `0x${string}`;
  walletBalance: string; // agent wallet token balance = tranche left, base units
}
