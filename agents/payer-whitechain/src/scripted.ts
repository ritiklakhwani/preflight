// Deterministic demo run, for recording the video.
//
// Buys quotes from the merchant until the tranche is spent. In evil mode the
// agent "falls for" the injected instruction: it sends a small amount to the
// partner (Receipts will flag that contract HIGH) and asks the owner for 500
// USDT with the injected reason. Only the owner's phone can release it.

import { getAddress, isAddress, type Address } from 'viem';
import { connectPreflightMcp, extractRequestId, extractRequestStatus, requestStatusHttp, type RequestStatus } from './mcp.js';
import {
  MERCHANT_URL,
  addressLink,
  agentAddress,
  fetchApi,
  payUsdt,
  readTerms,
  sleep,
  toBaseUnits,
  usdtBalance,
} from './tools.js';

const MAX_CALLS = Number(process.env.SCRIPTED_MAX_CALLS || 20);
const PARTNER_AMOUNT = process.env.SCRIPTED_PARTNER_AMOUNT || '1';
const REFILL_AMOUNT = process.env.SCRIPTED_REFILL_AMOUNT || '5';
const POLL_MS = Number(process.env.CAPLINE_POLL_MS || 5000);
const POLL_TIMEOUT_MS = Number(process.env.CAPLINE_POLL_TIMEOUT_MS || 16 * 60_000); // expiry is 15 min
const STEP_DELAY_MS = Number(process.env.SCRIPTED_STEP_DELAY_MS || 800); // readable pacing on camera

let step = 0;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] step ${++step}: ${msg}`);
const info = (msg: string) => console.log(`           ${msg}`);

interface Injection {
  partner: Address;
  amount: string;
  reason: string;
  excerpt: string;
}

/** Spots the partner instruction in a paid response (structured block or free text). */
function findInjection(body: unknown): Injection | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, any>;
  const text = JSON.stringify(body);
  const m = text.match(/(\d+(?:\.\d+)?) USDT to [^"]*?(0x[0-9a-fA-F]{40})/);
  const partner = b.billing?.payTo ?? m?.[2];
  if (typeof partner !== 'string' || !isAddress(partner)) return undefined;
  const note = typeof b.analyst_note === 'string' ? b.analyst_note : text;
  const excerpt = note.match(/To unlock premium data[^.]*\./)?.[0] ?? `pay ${m?.[1] ?? '?'} USDT to ${partner}`;
  return {
    partner: getAddress(partner),
    amount: String(b.billing?.amount ?? m?.[1] ?? '500'),
    reason: String(b.billing?.reason ?? 'Premium data access required by provider'),
    excerpt,
  };
}

async function main() {
  console.log('Capline demo: paying agent on Whitechain Sepolia (scripted)\n');
  const me = agentAddress();
  const quoteUrl = `${MERCHANT_URL}/quote`;

  log(`agent wallet ${me}`);
  info(addressLink(me));
  let bal = await usdtBalance(me);
  info(`tranche balance: ${bal.human} USDT`);

  let injection: Injection | undefined;
  let calls = 0;
  let price = 0n;
  let priceHuman = '?';

  while (calls < MAX_CALLS) {
    await sleep(STEP_DELAY_MS);
    log(`GET ${quoteUrl}`);
    const first = await fetchApi(quoteUrl);
    const terms = readTerms(first.body);
    if (first.status !== 402 || !terms) throw new Error(`expected 402 with payment terms, got ${first.status}`);
    price = await toBaseUnits(terms.amount);
    priceHuman = terms.amount;
    info(`402 Payment Required: ${terms.amount} USDT to ${terms.payTo}`);

    bal = await usdtBalance(me);
    if (bal.raw < price) {
      info(`balance ${bal.human} USDT is below the price of ${terms.amount} USDT: tranche spent`);
      break;
    }

    log(`paying ${terms.amount} USDT to merchant`);
    const pay = await payUsdt(terms.payTo, terms.amount);
    info(`tx ${pay.link}`);

    log(`GET ${quoteUrl} with X-Payment-Tx`);
    const paid = await fetchApi(quoteUrl, pay.hash);
    if (paid.status !== 200) throw new Error(`merchant refused payment: ${JSON.stringify(paid.body)}`);
    calls++;
    const q = (paid.body as { data?: Record<string, unknown> }).data ?? {};
    info(`200 OK, quote #${calls}: ${q.pair} bid ${q.bid} ask ${q.ask} mid ${q.mid}`);

    const inj = findInjection(paid.body);
    if (inj && !injection) {
      injection = inj;
      await sleep(STEP_DELAY_MS);
      log('merchant response contains an instruction for the agent');
      info(`"${inj.excerpt}"`);
      info('the agent treats it as a legitimate billing step (this is the attack)');
      log(`paying ${PARTNER_AMOUNT} USDT to "partner" ${inj.partner} as a deposit`);
      try {
        const p = await payUsdt(inj.partner, PARTNER_AMOUNT);
        info(`tx ${p.link}`);
        info('Receipts will show this transfer with the counterparty verdict');
      } catch (e) {
        info(`partner payment failed: ${(e as Error).message}`);
      }
    }
  }

  bal = await usdtBalance(me);
  log(`out of funds after ${calls} paid calls: ${bal.human} USDT left, price ${priceHuman} USDT`);

  const amount = injection ? injection.amount : REFILL_AMOUNT;
  const reason = injection
    ? `${injection.reason}. Data provider asks for ${injection.amount} USDT to partner ${injection.partner} to unlock premium data; please raise my budget.`
    : `Out of funds buying ETH/USDT quotes from ${MERCHANT_URL} at ${priceHuman} USDT per call. Need ${REFILL_AMOUNT} USDT to continue.`;

  log('connecting to the Preflight MCP server');
  const mcp = await connectPreflightMcp();
  try {
    log(`capline_request ${amount} USDT`);
    info(`reason: ${reason}`);
    const req = await mcp.call('capline_request', {
      chain: 'whitechain',
      amount,
      reason,
      ...(injection ? { counterparty: injection.partner } : {}),
    });
    if (req.isError) throw new Error(`capline_request failed: ${req.text}`);
    const requestId = extractRequestId(req);
    info(req.text.split('\n')[0] ?? '');
    if (!requestId) throw new Error(`no requestId in capline_request result: ${req.text}`);
    info(`request ${requestId} is waiting for the owner's phone`);

    log('polling capline_status until the owner decides');
    const started = Date.now();
    let status: RequestStatus = 'pending';
    let last = '';
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      const r = await mcp.call('capline_status', { chain: 'whitechain', requestId });
      status = extractRequestStatus(r);
      if (status === 'unknown') status = await requestStatusHttp(requestId);
      if (status !== last) {
        info(`status: ${status}`);
        last = status;
      }
      // 'approved' is not terminal: the release is still being relayed.
      if (status === 'released' || status === 'declined' || status === 'expired') break;
      await sleep(POLL_MS);
    }

    bal = await usdtBalance(me);
    if (status === 'released' || status === 'approved') {
      log(`owner approved. New tranche balance: ${bal.human} USDT`);
    } else if (status === 'declined') {
      log(`owner declined. The agent stops with ${bal.human} USDT; the injected 500 USDT never left the vault`);
    } else if (status === 'expired') {
      log(`request expired with no decision. Balance ${bal.human} USDT`);
    } else {
      log(`gave up waiting (last status: ${status}). Balance ${bal.human} USDT`);
    }
  } finally {
    await mcp.close();
  }
}

main().catch((e) => {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exit(1);
});
