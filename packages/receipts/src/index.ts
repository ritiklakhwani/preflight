// @preflight/receipts
//
// Rebuilds what an agent did with its last tranche from chain data, never from
// the agent's own report: token Transfer logs out of the agent wallet, plus
// extra receipts (Flash fills) supplied by the caller. Each counterparty gets a
// Preflight verdict. Output is the report the owner sees and the receiptsHash
// the owner signs. Interface: docs/CAPLINE_SPEC.md, section Receipts.

export { buildReceipts, assembleReport } from './build.js';
export type { BuildOptions, AssembleInput } from './build.js';
export { scoreCounterparty, mapEngineVerdict, whitechainVerdict, whitechainFacts, SCORE_TIMEOUT_MS } from './score.js';
export type { WhitechainFacts } from './score.js';
export { canonicalJson, receiptsHash } from './canonical.js';
export { rawTransfers, readLastReleaseBlock, DEFAULT_LOOKBACK } from './transfers.js';
export { CHAINS, publicClient, txLink, isChainKey } from './chains.js';
export type { ChainKey, Hex, Verdict, Receipt, ReceiptsReport, RawTransfer, Score, Scorer } from './types.js';
