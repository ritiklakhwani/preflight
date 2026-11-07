// Trader agent on Base: Preflight risk check -> Capline tranche -> Flash advanced order -> Receipts.
//
// Scripted, not free-roaming, so the demo is repeatable. Two MCP servers take part:
// Preflight (risk + Capline tools) always, and Definitive's own flash-mcp when
// FLASH_VIA_MCP=1. Otherwise the order goes through the REST client in flash.ts.
//
//   DRY_RUN=1          print every Flash HTTP request instead of sending it; simulate missing pieces
//   TRADER_AGENT_PRIVATE_KEY, DEFINITIVE_API_KEY, BASE_RPC_URL   required live
//   TARGET_TOKEN       default WETH on Base
//   TRANCHE_USDC       default 10
//   ORDER_MODE         bracket (default: marketable limit buy + attached TP/SL) | limit (resting limit buy)
//   FLASH_VIA_MCP=1    place the order through @definitive-fi/flash-mcp instead of flash.ts
//   SKIP_CAPLINE=1     trade from the current wallet balance without asking the vault
//   PREFLIGHT_ALLOW_UNKNOWN=1   continue live when Preflight cannot reach a verdict

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, createWalletClient, formatEther, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  BASE_USDC,
  BASE_WETH,
  FLASH_SETTLEMENT,
  FlashClient,
  fetchFlashReceipts,
  placeOrder,
  waitForFill,
  type QuoteRequest,
} from './flash.js';

const env = process.env;
const DRY = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TARGET = (env.TARGET_TOKEN ?? BASE_WETH) as Address;
const TRANCHE = env.TRANCHE_USDC ?? '10';
const MODE = (env.ORDER_MODE ?? 'bracket') as 'bracket' | 'limit';
const VIA_MCP = env.FLASH_VIA_MCP === '1';
const VERBOSE = env.VERBOSE === '1';
const BASESCAN = 'https://basescan.org';

const log = (s = '') => console.log(s);
const step = (n: number, title: string) => log(`\n[${n}/5] ${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ToolResult = { text: string; isError: boolean; structured?: unknown };

/** Spawns an MCP server over stdio. Its stderr is buffered so it does not drown the demo log. */
async function connectMcp(name: string, command: string, args: string[], childEnv: Record<string, string>) {
  const transport = new StdioClientTransport({ command, args, cwd: ROOT, env: childEnv, stderr: 'pipe' });
  const tail: string[] = [];
  transport.stderr?.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n').filter(Boolean)) {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      if (VERBOSE) log(`    | ${name}: ${line}`);
    }
  });
  const client = new Client({ name: 'trader-base', version: '0.1.0' });
  await client.connect(transport);
  const tools = new Set((await client.listTools()).tools.map((t) => t.name));
  const call = async (tool: string, a: Record<string, unknown>, timeoutMs = 60_000): Promise<ToolResult> => {
    const r = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: timeoutMs });
    const content = (r.content ?? []) as { type: string; text?: string }[];
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'),
      isError: r.isError === true,
      structured: r.structuredContent,
    };
  };
  return { client, tools, call, tail, close: () => client.close() };
}

type Mcp = Awaited<ReturnType<typeof connectMcp>>;

function stringEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...env, ...extra })) if (v !== undefined) out[k] = v;
  return out;
}

function indent(text: string, max = 12): string {
  // flash-mcp decorates its output with emoji; the demo log stays plain text.
  const lines = text.replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '').split('\n');
  const shown = lines.slice(0, max).map((l) => `    ${l}`);
  if (lines.length > max) shown.push(`    ... (${lines.length - max} more lines)`);
  return shown.join('\n');
}

/** Risk policy: the riskier the token, the tighter the protective bracket. High never trades. */
function bracketFor(severity: string): { tp: number; sl: number } | null {
  switch (severity) {
    case 'clean':
      return { tp: 0.03, sl: 0.02 };
    case 'low':
      return { tp: 0.025, sl: 0.015 };
    case 'medium':
    case 'unknown':
      return { tp: 0.02, sl: 0.01 };
    default:
      return null;
  }
}

async function main() {
  log(`Trader agent on Base${DRY ? ' (DRY RUN: no Flash request is sent, no funds move)' : ''}`);

  // Wallet. In dry-run without a key, an ephemeral one keeps the signing path real.
  let pk = env.TRADER_AGENT_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    if (!DRY) throw new Error('TRADER_AGENT_PRIVATE_KEY is not set.');
    pk = generatePrivateKey();
    log('  no TRADER_AGENT_PRIVATE_KEY: using an ephemeral dry-run wallet');
  }
  const account = privateKeyToAccount(pk);
  const agent = account.address;
  const transport = http(env.BASE_RPC_URL);
  const publicClient = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account, chain: base, transport });
  log(`  agent wallet (Flash funder): ${agent}`);
  log(`  target ${TARGET}, tranche ${TRANCHE} USDC, mode ${MODE}${VIA_MCP ? ', order via Definitive flash-mcp' : ''}`);
  const startedAt = Math.floor(Date.now() / 1000);

  // ---------------------------------------------------------------- 1. Preflight
  step(1, `Preflight risk check on ${TARGET} (MCP: preflight_check)`);
  let severity = 'unknown';
  let preflight: Mcp | undefined;
  try {
    // capline tools take the agent from CAPLINE_AGENT_ADDRESS (spec), so pin it to this wallet.
    preflight = await connectMcp('preflight', process.execPath, ['--import', 'tsx', 'packages/mcp/src/index.ts'], stringEnv({ CAPLINE_AGENT_ADDRESS: agent }));
    log(`  connected to Preflight MCP, tools: ${[...preflight.tools].join(', ')}`);
    const r = await preflight.call('preflight_check', { address: TARGET, chainId: 8453 }, 120_000);
    const m = /PREFLIGHT\s+(CLEAN|LOW|MEDIUM|HIGH|INCONCLUSIVE)/.exec(r.text);
    severity = m?.[1] && m[1] !== 'INCONCLUSIVE' ? m[1].toLowerCase() : 'unknown';
    log(indent(r.text, VERBOSE ? 80 : 6));
    if (r.isError) log('  preflight returned an error: treating the token as unknown risk');
  } catch (e) {
    log(`  Preflight MCP unavailable: ${errMsg(e)}`);
    if (preflight?.tail.length) log(indent(preflight.tail.slice(-4).join('\n')));
  }
  log(`  verdict: ${severity.toUpperCase()}`);
  if (severity === 'high') {
    if (!DRY) throw new Error('Preflight says HIGH. The agent does not trade this token.');
    // Dry-run only: show the rest of the flow. Live, this is a hard stop.
    log('  dry run: a live run stops here. Continuing to show the remaining steps.');
  }
  if (severity === 'unknown' && !DRY && env.PREFLIGHT_ALLOW_UNKNOWN !== '1') {
    throw new Error('No Preflight verdict. Set PREFLIGHT_ALLOW_UNKNOWN=1 to trade anyway.');
  }
  const widths = bracketFor(severity) ?? { tp: 0.02, sl: 0.01 };

  // ---------------------------------------------------------------- 2. Capline
  step(2, `Capline tranche of ${TRANCHE} USDC (MCP: capline_status / capline_request)`);
  await ensureTranche(preflight, agent);

  // ---------------------------------------------------------------- 3. Flash order
  step(3, `Definitive Flash ${MODE === 'bracket' ? 'limit buy + attached take-profit/stop-loss' : 'resting limit buy'}`);
  const flash = new FlashClient({ dryRun: DRY });
  const px = await flash.price(TARGET);
  log(`  reference price: $${px.toFixed(2)}`);
  const usd = (x: number) => x.toFixed(2);
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const req: QuoteRequest = {
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: TARGET,
    contraAsset: BASE_USDC,
    side: 'buy',
    qty: TRANCHE,
    orderType: 'limit',
    funderAddress: agent,
    ...(MODE === 'bracket'
      ? {
          // A buy limit fills at or below its price, so 0.3% above market fills now:
          // a real onchain fill for the demo, still with a hard price cap.
          // Flash v1 takes an attached-bracket entry only as a pair rate (target
          // per contra). The contra is USDC, so the rate equals the USD price.
          limitCrossPrice: usd(px * 1.003),
          expireTime: inMinutes(15),
          attachedBracket: {
            takeProfit: { notionalPrice: usd(px * (1 + widths.tp)) },
            stopLoss: { notionalPrice: usd(px * (1 - widths.sl)) },
            expireTime: inMinutes(24 * 60),
          },
        }
      : { limitNotionalPrice: usd(px * (1 - Number(env.LIMIT_DISCOUNT ?? '0.005'))), expireTime: inMinutes(60) }),
  };
  log(`  limit $${req.limitNotionalPrice ?? req.limitCrossPrice}` + (req.attachedBracket
    ? `, TP $${req.attachedBracket.takeProfit.notionalPrice} (+${widths.tp * 100}%), SL $${req.attachedBracket.stopLoss.notionalPrice} (-${widths.sl * 100}%) from verdict ${severity.toUpperCase()}`
    : ''));

  if (!DRY) {
    const eth = await publicClient.getBalance({ address: agent });
    log(`  gas balance: ${formatEther(eth)} ETH (needed only for one-time approvals)`);
  }
  const sendTx = async (tx: { to: Address; data: Hex }, label: string) => {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
    log(`  sent ${label} approve ${BASESCAN}/tx/${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };

  let orderId: string;
  if (VIA_MCP) {
    orderId = await placeViaFlashMcp(req, pk);
  } else {
    const placed = await placeOrder({ flash, account, sendTx: DRY ? undefined : sendTx, log }, req);
    orderId = placed.orderId;
    log(`  order accepted: ${orderId}${placed.bracketStatus ? `, bracket ${placed.bracketStatus}` : ''}`);
  }

  // ---------------------------------------------------------------- 4. Fill
  step(4, 'Waiting for the onchain fill');
  const final = await waitForFill(flash, orderId, agent, {
    timeoutMs: MODE === 'bracket' ? 180_000 : 30_000,
    intervalMs: DRY ? 10 : 3000,
    log,
  });
  for (const f of final.fills) {
    log(`  fill: ${f.contraAmount} USDC -> ${f.targetAmount} ${final.order.targetAsset.ticker} @ $${f.fillPrice} via ${f.venues.join(', ')}`);
    log(`  tx: ${BASESCAN}/tx/${f.transactionId}${DRY ? '  (fake hash, dry run)' : ''}`);
  }
  if (!final.fills.length) log(`  no fill yet (status ${final.order.status}); it stays live until ${MODE === 'limit' ? 'price reaches the limit' : 'expiry'}`);
  if (final.order.attachedBracket) {
    log(`  protective bracket: ${final.order.attachedBracket.status}${final.order.attachedBracket.bracketOrderId ? ` (order ${final.order.attachedBracket.bracketOrderId})` : ''}`);
  }

  // ---------------------------------------------------------------- 5. Receipts
  step(5, 'What the owner will see in Receipts');
  const receipts = await fetchFlashReceipts(agent, startedAt - 60, { flash, publicClient: DRY ? undefined : publicClient });
  for (const r of receipts) {
    log(`  ${r.kind} ${r.meta?.orderType} ${r.meta?.pair} @ ${r.meta?.fillPrice}: ${r.amount} base units of ${r.token} to ${r.to} [${r.verdict}]`);
    log(`    ${r.link}`);
  }
  if (!receipts.length) log('  no filled Flash orders since the tranche yet');

  await preflight?.close().catch(() => {});
  log('\nDone.');
}

// Capline: read the tranche, ask the owner if it is short, wait for the passkey approval.
async function ensureTranche(preflight: Mcp | undefined, agent: Address): Promise<void> {
  if (env.SKIP_CAPLINE === '1') {
    log('  SKIP_CAPLINE=1: trading from the current wallet balance');
    return;
  }
  const has = (t: string) => preflight?.tools.has(t) ?? false;
  if (!has('capline_status') || !has('capline_request')) {
    if (!DRY) throw new Error('Preflight MCP has no capline tools. Set SKIP_CAPLINE=1 to trade from the wallet balance.');
    log('  capline tools not available in this MCP build: simulating a released tranche');
    return;
  }
  const balanceOf = (text: string) => Number(/tranche left to spend\):\s*([\d.]+)/.exec(text)?.[1] ?? 'NaN');

  const status = await preflight!.call('capline_status', { chain: 'base', agent });
  log(indent(status.text, 7));
  const bal = balanceOf(status.text);
  if (bal >= Number(TRANCHE)) {
    log(`  wallet already holds ${bal} USDC: no refill needed`);
    return;
  }

  const reason = `Flash ${MODE} order: buy ${TARGET === BASE_WETH ? 'WETH' : TARGET} with ${TRANCHE} USDC on Base`;
  const req = await preflight!.call('capline_request', { chain: 'base', amount: TRANCHE, reason, counterparty: FLASH_SETTLEMENT, agent });
  log(indent(req.text, 5));
  const id = /requestId:\s*(\S+)/.exec(req.text)?.[1];
  if (req.isError || !id) {
    if (DRY) return log('  request failed (approval server down?): continuing the dry run');
    throw new Error('Capline request failed.');
  }

  log('  waiting for the owner to approve with their passkey...');
  const deadline = Date.now() + Number(env.CAPLINE_WAIT_SEC ?? (DRY ? '15' : '300')) * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(5000);
    const s = await preflight!.call('capline_status', { chain: 'base', agent, requestId: id });
    const st = /REQUEST \S+: (\w+)/.exec(s.text)?.[1] ?? 'UNKNOWN';
    if (st !== last) log(`  request ${id}: ${(last = st)}`);
    if (st === 'RELEASED') {
      log(`  tranche released: wallet now ${balanceOf(s.text)} USDC`);
      const tx = /tx: (\S+)/.exec(s.text)?.[1];
      if (tx) log(`  release tx: ${tx}`);
      return;
    }
    if (st === 'DECLINED' || st === 'EXPIRED') throw new Error(`Owner ${st.toLowerCase()} the tranche. Not trading.`);
  }
  if (DRY) return log('  no approval within the dry-run wait: continuing');
  throw new Error('Timed out waiting for the owner.');
}

// Same order through Definitive's official MCP server (two MCP servers in one workflow).
// flash-mcp has no attachedBracket, so this path places the limit entry only.
async function placeViaFlashMcp(req: QuoteRequest, pk: Hex): Promise<string> {
  const childEnv = stringEnv({
    DEFINITIVE_API_KEY: env.DEFINITIVE_API_KEY,
    // flash-mcp signs with this key; env takes precedence over its keychain store.
    DEFINITIVE_PRIVATE_KEY: DRY ? undefined : pk,
    DEFINITIVE_RPC_BASE: env.BASE_RPC_URL,
  });
  const flashMcp = await connectMcp('flash-mcp', 'npx', ['-y', '@definitive-fi/flash-mcp'], childEnv);
  log(`  connected to Definitive flash-mcp, tools: ${[...flashMcp.tools].join(', ')}`);
  const args = {
    targetChain: req.targetChain,
    contraChain: req.contraChain,
    targetAsset: req.targetAsset,
    contraAsset: req.contraAsset,
    side: req.side,
    qty: req.qty,
    orderType: req.orderType,
    limitNotionalPrice: req.limitNotionalPrice,
    expireTime: req.expireTime,
    waitForFill: false,
  };
  if (DRY) {
    log(`  [dry-run] would call flash_submit_order ${JSON.stringify(args)}`);
    await flashMcp.close();
    return `dryrun-mcp-${Date.now().toString(36)}`;
  }
  const r = await flashMcp.call('flash_submit_order', args, 180_000);
  log(indent(r.text, 10));
  await flashMcp.close();
  const id = (r.structured as { orderId?: string } | undefined)?.orderId ?? /Order submitted: `([^`]+)`/.exec(r.text)?.[1];
  if (r.isError || !id) throw new Error('flash_submit_order failed.');
  return id;
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\nStopped: ${errMsg(e)}`);
    process.exit(1);
  },
);
