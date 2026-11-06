// Typed client for the Definitive Flash REST API (https://flash.definitive.fi/v1).
//
// Custody model (docs: non-custodial, evm-overview, security): funds stay in the
// funder EOA until the fill. The EOA approves the Flash settlement contract once
// per token (evm.approveTx), signs an EIP-712 order offchain, and Definitive's
// "performers" land the settlement tx and pay its gas. Output returns to the same
// EOA. So the trader agent's own wallet is the funder: no portfolio to fund.
//
// Only documented trading endpoints are called. Nothing else leaves this process.

import { erc20Abi, formatUnits, parseUnits, type Address, type Hex } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { txLink, type Receipt, type Verdict } from '@preflight/capline';

export const FLASH_BASE_URL = 'https://flash.definitive.fi/v1';

/** EVM settlement contract, same address on every EVM chain (docs: security). Spender of approveTx. */
export const FLASH_SETTLEMENT: Address = '0x5d00000873b6BF41539e6f5365B0Ff7d3c368f78';

export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BASE_WETH: Address = '0x4200000000000000000000000000000000000006';

export type FlashChain = 'base';
export type Side = 'buy' | 'sell';
export type OrderType =
  | 'market'
  | 'limit'
  | 'twap'
  | 'stop'
  | 'stop-loss'
  | 'take-profit'
  | 'bracket'
  | 'trailing-stop'
  | 'trailing-stop-limit';

export interface PriceTrigger {
  notionalPrice?: string;
  crossPrice?: string;
  triggerType: 'upper' | 'lower';
  limitPrice?: string; // bracket legs only
}

export interface AttachedBracketLeg {
  notionalPrice?: string;
  crossPrice?: string;
  limitPrice?: string;
}

export interface AttachedBracket {
  takeProfit: AttachedBracketLeg;
  stopLoss: AttachedBracketLeg;
  expireTime?: string;
}

/** POST /quote body. Fields the order body must echo are shared via OrderParams. */
export interface OrderParams {
  targetChain: FlashChain;
  contraChain: FlashChain;
  targetAsset: Address;
  contraAsset: Address;
  side: Side;
  qty: string; // spent asset, decimal string: contra units on buy, target units on sell
  orderType: OrderType;
  maxSlippage?: string;
  maxPriceImpact?: string;
  limitNotionalPrice?: string;
  limitCrossPrice?: string;
  triggers?: PriceTrigger[];
  expireTime?: string;
  startTime?: string;
  twapBucketCount?: number;
  flashIntegratorFeeBps?: string;
}

export interface QuoteRequest extends OrderParams {
  funderAddress: Address;
  durationSeconds?: number; // TWAP only, quote-time only, min 300
  attachedBracket?: AttachedBracket;
}

export interface QuoteResponse {
  quoteId: string;
  orderType: OrderType;
  side: Side;
  targetAsset: string;
  contraAsset: string;
  from: { asset: 'target' | 'contra'; amount: string; notional: string };
  to: { asset: 'target' | 'contra'; amount: string; notional: string };
  fees: { estimatedFeeNotional: string };
  estimatedPriceImpact: string | null;
  recommendedSlippage?: string | null;
  evm: {
    approveTx: { to: Address; data: Hex } | null;
    permitTypedData: string | null;
    orderTypedData: string | null;
  } | null;
  attachedBracket?: {
    evm: {
      approveTx: { to: Address; data: Hex } | null;
      permitTypedData: string | null;
      orderTypedData: string;
    } | null;
    salt: string | null;
    deadline: string;
    signedMaxFromAmount: string;
  };
}

export interface OrderRequest extends OrderParams {
  funderAddress: Address;
  userSignature: Hex;
  quoteId?: string;
  evmOrderTypedData?: string;
  evmPermitTypedData?: string;
  evmPermitSignature?: Hex;
  erc8021AttributionCode?: string;
  attachedBracket?: AttachedBracket & {
    userSignature: Hex;
    salt: string | null;
    deadline: string;
    signedMaxFromAmount: string;
    evmPermitTypedData?: string;
    evmPermitSignature?: Hex;
  };
}

export interface OrderResponse {
  orderId: string;
  attachedBracket?: { status: string };
}

export type OrderStatus =
  | 'ORDER_STATUS_UNSPECIFIED'
  | 'ORDER_STATUS_PENDING'
  | 'ORDER_STATUS_ACCEPTED'
  | 'ORDER_STATUS_PARTIALLY_FILLED'
  | 'ORDER_STATUS_FILLED'
  | 'ORDER_STATUS_CANCELLED'
  | 'ORDER_STATUS_REJECTED'
  | 'ORDER_STATUS_TERMINATED';

export const TERMINAL: ReadonlySet<OrderStatus> = new Set([
  'ORDER_STATUS_FILLED',
  'ORDER_STATUS_CANCELLED',
  'ORDER_STATUS_REJECTED',
  'ORDER_STATUS_TERMINATED',
]);

export interface AssetRef {
  id: string;
  name: string;
  address: string;
  ticker: string;
  chain: { id: string; name: string; namespace: string };
}

export interface FlashOrder {
  orderId: string;
  orderType: OrderType;
  side: Side;
  status: OrderStatus;
  closeReason: string | null;
  funderAddress: string;
  targetAsset: AssetRef;
  contraAsset: AssetRef;
  qty: string;
  filled: {
    targetAmount: string | null;
    contraAmount: string | null;
    averagePrice: string | null;
    averageNotionalPrice: string | null;
  } | null;
  limitNotionalPrice: string | null;
  trigger: PriceTrigger | null;
  brackets: PriceTrigger[] | null;
  attachedBracket?: { status: string; bracketOrderId?: string | null };
  sourceEntryOrderId?: string;
  placedAt: string;
  closedAt: string | null;
}

export interface FlashFill {
  status: string; // CHAIN_STATUS_PROCESSED | FINALIZED | REORGED
  notional: string;
  venues: string[];
  filledAt: string;
  orderId: string;
  rootOrderId: string;
  transactionId: string; // the settlement tx hash on EVM
  fillPrice: string;
  feeAmount: string;
  feeTicker: string;
  feeNotional: string;
  contraAmount: string;
  targetAmount: string;
}

export interface GetOrderResponse {
  order: FlashOrder;
  fills: FlashFill[];
}

export interface FlashOptions {
  apiKey?: string;
  dryRun?: boolean;
  baseUrl?: string;
  log?: (line: string) => void;
}

export class FlashApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'FlashApiError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FlashClient {
  readonly dryRun: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly log: (line: string) => void;
  private fakeSeq = 0;

  constructor(opts: FlashOptions = {}) {
    this.dryRun = opts.dryRun ?? false;
    this.apiKey = opts.apiKey ?? process.env.DEFINITIVE_API_KEY ?? '';
    this.baseUrl = opts.baseUrl ?? FLASH_BASE_URL;
    this.log = opts.log ?? ((l) => console.log(l));
    if (!this.dryRun && !this.apiKey) throw new Error('DEFINITIVE_API_KEY is not set.');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, fake?: () => T): Promise<T> {
    if (this.dryRun) {
      // Key is redacted: dry-run output goes to screens and recordings.
      this.log(`  [dry-run] ${method} ${this.baseUrl}${path}`);
      this.log(`  [dry-run]   x-definitive-api-key: ${this.apiKey ? 'dpka_***' : '(unset)'}`);
      if (body !== undefined) {
        for (const line of JSON.stringify(body, null, 2).split('\n')) this.log(`  [dry-run]   ${line}`);
      }
      if (!fake) throw new Error(`no dry-run stub for ${path}`);
      return fake();
    }
    // 5 req/s per endpoint per key; one retry on 429 is enough for a single agent.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-definitive-api-key': this.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 2) {
        await sleep(500);
        continue;
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        const err = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new FlashApiError(res.status, err?.code, err?.message ?? `${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      }
      return parsed as T;
    }
  }

  /** GET /search: symbol or address to asset info, including a USD price. */
  async price(asset: Address, chain: FlashChain = 'base'): Promise<number> {
    const qs = new URLSearchParams({ query: asset, chain, limit: '1' });
    const r = await this.request<{ assets: { address: string; price: string }[] }>(
      'GET',
      `/search?${qs}`,
      undefined,
      () => ({ assets: [{ address: asset, price: process.env.DRY_RUN_PRICE ?? '3000' }] }),
    );
    const hit = r.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase()) ?? r.assets[0];
    if (!hit) throw new Error(`Flash search found no asset ${asset}`);
    return Number(hit.price);
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request('POST', '/quote', req, () => fakeQuote(req, ++this.fakeSeq));
  }

  submit(req: OrderRequest): Promise<OrderResponse> {
    return this.request('POST', '/order', req, () => ({
      orderId: `dryrun-${Date.now().toString(36)}`,
      ...(req.attachedBracket ? { attachedBracket: { status: 'pending_activation' } } : {}),
    }));
  }

  getOrder(orderId: string, funder: Address): Promise<GetOrderResponse> {
    const qs = new URLSearchParams({ funderAddress: funder });
    return this.request('GET', `/orders/${encodeURIComponent(orderId)}?${qs}`, undefined, () => fakeFilled(orderId, funder));
  }

  async listOrders(funder: Address, statuses?: OrderStatus[], pageSize = 50): Promise<FlashOrder[]> {
    const qs = new URLSearchParams({ funderAddress: funder, pageSize: String(pageSize) });
    if (statuses?.length) qs.set('statuses', statuses.join(','));
    const r = await this.request<{ orders: FlashOrder[]; nextPageToken: string | null }>(
      'GET',
      `/orders?${qs}`,
      undefined,
      () => ({ orders: [fakeFilled('dryrun-listed', funder).order], nextPageToken: null }),
    );
    return r.orders;
  }

  /** POST /orders/{id}/cancel, signed with a plain personal_sign message (as flash-mcp does). */
  async cancel(orderId: string, account: LocalAccount): Promise<void> {
    const cancelMessage = `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;
    const userSignature = await account.signMessage({ message: cancelMessage });
    await this.request('POST', `/orders/${encodeURIComponent(orderId)}/cancel`, { cancelMessage, userSignature }, () => ({}));
  }
}

// ---------------------------------------------------------------------------
// Full place flow: quote -> approve(s) -> sign -> submit.
// ---------------------------------------------------------------------------

export interface PlaceDeps {
  flash: FlashClient;
  account: LocalAccount;
  /** Sends approveTx from the funder. Omitted in dry-run. */
  sendTx?: (tx: { to: Address; data: Hex }, label: string) => Promise<Hex>;
  log?: (line: string) => void;
}

export interface Placed {
  orderId: string;
  quote: QuoteResponse;
  bracketStatus?: string;
}

const signTyped = (account: LocalAccount, json: string): Promise<Hex> => {
  const { domain, types, primaryType, message } = JSON.parse(json);
  // EIP712Domain must not be passed in types to viem.
  const { EIP712Domain: _drop, ...rest } = types ?? {};
  return account.signTypedData({ domain, types: rest, primaryType, message });
};

export async function placeOrder(deps: PlaceDeps, req: QuoteRequest): Promise<Placed> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const { flash, account } = deps;
  const quote = await flash.quote(req);
  log(`  quote ${quote.quoteId}: spend ${quote.from.amount} -> receive ~${quote.to.amount}, fee ~$${quote.fees.estimatedFeeNotional}`);

  const evm = quote.evm;
  if (!evm?.orderTypedData) throw new Error('Quote has no evm.orderTypedData (is funderAddress set?).');

  const approve = async (tx: { to: Address; data: Hex } | null, label: string) => {
    if (!tx) return;
    if (!deps.sendTx) {
      log(`  [dry-run] would send ${label} approve to ${tx.to}`);
      return;
    }
    const hash = await deps.sendTx(tx, label);
    log(`  ${label} approve landed: ${hash}`);
  };
  await approve(evm.approveTx, 'spent-asset');

  const permit = evm.permitTypedData
    ? { evmPermitTypedData: evm.permitTypedData, evmPermitSignature: await signTyped(account, evm.permitTypedData) }
    : {};
  const userSignature = await signTyped(account, evm.orderTypedData);
  log(`  signed order typed data as ${account.address}`);

  let attached: OrderRequest['attachedBracket'];
  if (req.attachedBracket) {
    const ab = quote.attachedBracket;
    if (!ab?.evm) throw new Error('Quote did not return an attachedBracket signing payload.');
    // The pair later sells what the entry receives, so that token needs its own allowance.
    await approve(ab.evm.approveTx, 'received-asset');
    const abPermit = ab.evm.permitTypedData
      ? { evmPermitTypedData: ab.evm.permitTypedData, evmPermitSignature: await signTyped(account, ab.evm.permitTypedData) }
      : {};
    attached = {
      ...req.attachedBracket,
      userSignature: await signTyped(account, ab.evm.orderTypedData),
      salt: ab.salt,
      deadline: ab.deadline,
      signedMaxFromAmount: ab.signedMaxFromAmount,
      ...abPermit,
    };
    log(`  signed attached bracket (max ${ab.signedMaxFromAmount} of the received asset)`);
  }

  // durationSeconds is quote-only; everything else is echoed.
  const { durationSeconds: _d, attachedBracket: _a, ...echo } = req;
  const res = await flash.submit({
    ...echo,
    quoteId: quote.quoteId,
    userSignature,
    evmOrderTypedData: evm.orderTypedData,
    ...permit,
    ...(attached ? { attachedBracket: attached } : {}),
    ...(process.env.BASE_BUILDER_CODE ? { erc8021AttributionCode: process.env.BASE_BUILDER_CODE } : {}),
  });
  return { orderId: res.orderId, quote, bracketStatus: res.attachedBracket?.status };
}

/** Polls GET /orders/{id} until terminal, a fill with a tx appears, or timeout. */
export async function waitForFill(
  flash: FlashClient,
  orderId: string,
  funder: Address,
  opts: { timeoutMs?: number; intervalMs?: number; log?: (l: string) => void } = {},
): Promise<GetOrderResponse> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let last: GetOrderResponse | undefined;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      last = await flash.getOrder(orderId, funder);
      if (last.order.status !== lastStatus) {
        lastStatus = last.order.status;
        log(`  order ${orderId}: ${lastStatus}`);
      }
      if (TERMINAL.has(last.order.status) || last.fills.some((f) => f.transactionId)) return last;
    } catch (e) {
      // Reads can lag a placement by a second or two (docs: brackets).
      if (!(e instanceof FlashApiError && e.status === 404)) throw e;
    }
    await sleep(opts.intervalMs ?? 3000);
  }
  if (!last) throw new Error(`order ${orderId} not visible after timeout`);
  return last;
}

// ---------------------------------------------------------------------------
// Receipts: filled Flash orders as CAPLINE_SPEC Receipt rows.
// ---------------------------------------------------------------------------

const DECIMALS: Record<string, number> = {
  [BASE_USDC.toLowerCase()]: 6,
  [BASE_WETH.toLowerCase()]: 18,
};

/** The two reads receipts need; structural so a chain-typed viem client fits. */
export interface ReceiptReader {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ blockNumber: bigint }>;
  readContract(args: { address: Address; abi: typeof erc20Abi; functionName: 'decimals' }): Promise<number>;
}

export interface ReceiptOptions {
  flash?: FlashClient;
  /** Used for blockNumber and decimals of unknown tokens. Without it blockNumber is 0. */
  publicClient?: ReceiptReader;
  /** Preflight scorer for the counterparty. Without it rows are 'unknown'. */
  score?: (address: Address) => Promise<{ verdict: Verdict; reasons: string[] }>;
}

const isTxHash = (s: string): s is Hex => /^0x[0-9a-fA-F]{64}$/.test(s);

async function decimalsOf(token: string, pc?: ReceiptReader): Promise<number> {
  const known = DECIMALS[token.toLowerCase()];
  if (known !== undefined) return known;
  if (!pc) return 18;
  const d = await pc.readContract({
    address: token as Address,
    abi: erc20Abi,
    functionName: 'decimals',
  });
  DECIMALS[token.toLowerCase()] = Number(d);
  return Number(d);
}

/**
 * One Receipt per onchain fill since `sinceUnix`. token/amount are what left the
 * agent (USDC on a buy, the target on a sell), so spent sums match the vault's
 * view. `to` is the Flash settlement contract: it is the approved spender that
 * pulls the funds, and the only stable onchain counterparty (the actual pools
 * or makers vary per route and are not in the API).
 */
export async function fetchFlashReceipts(agent: Address, sinceUnix: number, opts: ReceiptOptions = {}): Promise<Receipt[]> {
  const flash = opts.flash ?? new FlashClient();
  const orders = await flash.listOrders(agent, ['ORDER_STATUS_FILLED', 'ORDER_STATUS_PARTIALLY_FILLED'], 100);
  const score = opts.score ? await opts.score(FLASH_SETTLEMENT) : { verdict: 'unknown' as Verdict, reasons: ['not scored'] };
  const out: Receipt[] = [];

  for (const o of orders) {
    if (o.closedAt && Date.parse(o.closedAt) / 1000 < sinceUnix && Date.parse(o.placedAt) / 1000 < sinceUnix) continue;
    const { order, fills } = await flash.getOrder(o.orderId, agent);
    const spent = order.side === 'buy' ? order.contraAsset : order.targetAsset;
    const decimals = await decimalsOf(spent.address, opts.publicClient);
    for (const f of fills) {
      const ts = Math.floor(Date.parse(f.filledAt) / 1000);
      if (ts < sinceUnix || !isTxHash(f.transactionId) || f.status === 'CHAIN_STATUS_REORGED') continue;
      let blockNumber = 0;
      if (opts.publicClient) {
        const r = await opts.publicClient.getTransactionReceipt({ hash: f.transactionId });
        blockNumber = Number(r.blockNumber);
      }
      const human = order.side === 'buy' ? f.contraAmount : f.targetAmount;
      out.push({
        chain: 'base',
        kind: 'flash_order',
        txHash: f.transactionId,
        blockNumber,
        timestamp: ts,
        to: FLASH_SETTLEMENT,
        token: spent.address as Hex,
        amount: parseUnits(trimDecimals(human, decimals), decimals).toString(),
        verdict: score.verdict,
        reasons: score.reasons,
        link: txLink('base', f.transactionId),
        meta: {
          orderId: order.orderId,
          orderType: order.orderType,
          side: order.side,
          pair: `${order.targetAsset.ticker}/${order.contraAsset.ticker}`,
          fillPrice: f.fillPrice,
          received: order.side === 'buy' ? `${f.targetAmount} ${order.targetAsset.ticker}` : `${f.contraAmount} ${order.contraAsset.ticker}`,
          feeUsd: f.feeNotional,
          venues: f.venues.join(','),
          ...(order.sourceEntryOrderId ? { entryOrderId: order.sourceEntryOrderId } : {}),
        },
      });
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.timestamp - b.timestamp);
}

/** parseUnits throws on more decimals than the token has; API amounts may carry extra. */
function trimDecimals(s: string, decimals: number): string {
  const [i, f = ''] = s.split('.');
  return f ? `${i}.${f.slice(0, decimals)}` : (i ?? '0');
}

// ---------------------------------------------------------------------------
// Dry-run stubs. Shapes follow the OpenAPI spec so the rest of the flow runs.
// ---------------------------------------------------------------------------

function fakeTypedData(funder: Address, label: string, seq: number): string {
  return JSON.stringify({
    domain: { name: 'DryRunFlash', version: '1', chainId: 8453, verifyingContract: FLASH_SETTLEMENT },
    types: { DryRunOrder: [{ name: 'funder', type: 'address' }, { name: 'label', type: 'string' }, { name: 'seq', type: 'uint256' }] },
    primaryType: 'DryRunOrder',
    message: { funder, label, seq: String(seq) },
  });
}

function fakeQuote(req: QuoteRequest, seq: number): QuoteResponse {
  const price = Number(process.env.DRY_RUN_PRICE ?? '3000');
  const qty = Number(req.qty);
  const out = req.side === 'buy' ? (qty / price).toFixed(8) : (qty * price).toFixed(6);
  return {
    quoteId: `q_dryrun_${seq}`,
    orderType: req.orderType,
    side: req.side,
    targetAsset: req.targetAsset,
    contraAsset: req.contraAsset,
    from: { asset: req.side === 'buy' ? 'contra' : 'target', amount: req.qty, notional: req.side === 'buy' ? req.qty : String(qty * price) },
    to: { asset: req.side === 'buy' ? 'target' : 'contra', amount: out, notional: req.side === 'buy' ? req.qty : out },
    fees: { estimatedFeeNotional: (qty * 0.001).toFixed(4) },
    estimatedPriceImpact: '0.0005',
    recommendedSlippage: null,
    evm: {
      approveTx: { to: req.contraAsset, data: '0x095ea7b3' },
      permitTypedData: null,
      orderTypedData: fakeTypedData(req.funderAddress, 'entry', seq),
    },
    ...(req.attachedBracket
      ? {
          attachedBracket: {
            evm: { approveTx: { to: req.targetAsset, data: '0x095ea7b3' }, permitTypedData: null, orderTypedData: fakeTypedData(req.funderAddress, 'bracket', seq) },
            salt: '0x00',
            deadline: '281474976710655',
            signedMaxFromAmount: out,
          },
        }
      : {}),
  };
}

function fakeFilled(orderId: string, funder: Address): GetOrderResponse {
  const price = process.env.DRY_RUN_PRICE ?? '3000';
  const contra = process.env.TRANCHE_USDC ?? '10';
  const target = formatUnits(parseUnits(contra, 18) / BigInt(Math.round(Number(price))), 18);
  const asset = (address: Address, ticker: string): AssetRef => ({
    id: ticker,
    name: ticker,
    address,
    ticker,
    chain: { id: '8453', name: 'base', namespace: 'eip155' },
  });
  const now = new Date().toISOString();
  return {
    order: {
      orderId,
      orderType: 'limit',
      side: 'buy',
      status: 'ORDER_STATUS_FILLED',
      closeReason: null,
      funderAddress: funder,
      targetAsset: asset(BASE_WETH, 'WETH'),
      contraAsset: asset(BASE_USDC, 'USDC'),
      qty: contra,
      filled: { targetAmount: target, contraAmount: contra, averagePrice: price, averageNotionalPrice: price },
      limitNotionalPrice: price,
      trigger: null,
      brackets: null,
      attachedBracket: { status: 'active', bracketOrderId: `${orderId}-bracket` },
      placedAt: now,
      closedAt: now,
    },
    fills: [
      {
        status: 'CHAIN_STATUS_PROCESSED',
        notional: contra,
        venues: ['dry-run'],
        filledAt: now,
        orderId,
        rootOrderId: orderId,
        transactionId: `0x${'d'.repeat(64)}`,
        fillPrice: price,
        feeAmount: '0.01',
        feeTicker: 'USDC',
        feeNotional: '0.01',
        contraAmount: contra,
        targetAmount: target,
      },
    ],
  };
}
