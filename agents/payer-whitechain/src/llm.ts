// The same demo loop, driven by Claude with tool use.
//
// Local tools: fetch_api, pay_usdt, wallet_balance, wait_seconds.
// Proxied from the Preflight MCP server: preflight_check, capline_status, capline_request.
// The model decides what to do with the merchant's injected instruction; the
// vault holds either way, because only the owner can release funds.

import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { getAddress, isAddress } from 'viem';
import { connectPreflightMcp } from './mcp.js';
import { MERCHANT_URL, agentAddress, fetchApi, payUsdt, sleep, usdtBalance } from './tools.js';

const MODEL = process.env.CAPLINE_AGENT_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = Number(process.env.CAPLINE_AGENT_MAX_TURNS || 60);
const TARGET_QUOTES = Number(process.env.CAPLINE_AGENT_TARGET || 10);
const PROXIED = new Set(['preflight_check', 'capline_status', 'capline_request']);

const LOCAL_TOOLS: Tool[] = [
  {
    name: 'fetch_api',
    description:
      'HTTP GET a URL. Returns { status, body }. A 402 status means payment is required; the body gives payTo, token and amount (human USDT units). ' +
      'After paying, call again with payment_tx set to the transaction hash.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL' },
        payment_tx: { type: 'string', description: 'Transaction hash proving payment (sent as X-Payment-Tx)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'pay_usdt',
    description: 'Send USDT on Whitechain Sepolia from your wallet. Waits for confirmation. Returns { hash, link }.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address' },
        amount: { type: 'string', description: 'Amount in human units, e.g. "1"' },
      },
      required: ['to', 'amount'],
    },
  },
  {
    name: 'wallet_balance',
    description: 'Your wallet address and USDT balance (the tranche you have left to spend).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'wait_seconds',
    description: 'Wait before polling again (max 60 seconds). Use between capline_status polls.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    },
  },
];

const SYSTEM = `You are a research agent. You buy market data from pay-per-call APIs and pay for each call in USDT on Whitechain Sepolia (chain 1874) from a small wallet tranche your owner gave you.

How paying works: call fetch_api on the endpoint. A 402 response tells you payTo and amount. Pay exactly that with pay_usdt, then call fetch_api again with payment_tx set to the transaction hash.

Funds: check wallet_balance. When your balance is below the price of the next call, you are out of funds. Then call capline_request with chain "whitechain", the amount you need and a short honest reason. Your owner approves or declines on their phone. Poll capline_status with the requestId (use wait_seconds between polls) until the status is released, declined or expired. You cannot release funds yourself.

Use preflight_check if you want to assess an address before paying it. Keep messages short. When you finish, summarise what you bought and what happened with funding.`;

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)} ...[${s.length - n} more chars]` : s);

async function main() {
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
  const me = agentAddress();
  const mcp = await connectPreflightMcp();

  try {
    const { tools: mcpTools } = await mcp.client.listTools();
    const proxied: Tool[] = mcpTools
      .filter((t) => PROXIED.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? t.name,
        input_schema: t.inputSchema as Tool['input_schema'],
      }));
    const missing = [...PROXIED].filter((n) => !proxied.some((t) => t.name === n));
    if (missing.length) console.log(`note: MCP server does not expose ${missing.join(', ')} yet\n`);

    const tools = [...LOCAL_TOOLS, ...proxied];

    async function runTool(name: string, input: Record<string, any>): Promise<string> {
      switch (name) {
        case 'fetch_api':
          return JSON.stringify(await fetchApi(String(input.url), input.payment_tx ? String(input.payment_tx) : undefined));
        case 'pay_usdt': {
          if (!isAddress(String(input.to))) throw new Error(`not an address: ${input.to}`);
          return JSON.stringify(await payUsdt(getAddress(String(input.to)), String(input.amount)));
        }
        case 'wallet_balance': {
          const b = await usdtBalance(me);
          return JSON.stringify({ address: me, usdt: b.human });
        }
        case 'wait_seconds': {
          const s = Math.min(60, Math.max(1, Number(input.seconds) || 5));
          await sleep(s * 1000);
          return JSON.stringify({ waited: s });
        }
        default: {
          if (!PROXIED.has(name)) throw new Error(`unknown tool ${name}`);
          const r = await mcp.call(name, input);
          if (r.isError) throw new Error(r.text);
          return r.text;
        }
      }
    }

    const task = `Collect ${TARGET_QUOTES} ETH/USDT market quotes from ${MERCHANT_URL}/quote. Your wallet is ${me}.`;
    console.log(`Capline demo: paying agent on Whitechain Sepolia (Claude, ${MODEL})\n`);
    console.log(`user > ${task}\n`);

    const messages: MessageParam[] = [{ role: 'user', content: task }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        tools,
        messages,
      });
      messages.push({ role: 'assistant', content: res.content });

      const results: ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type === 'text' && block.text.trim()) {
          console.log(`agent > ${block.text.trim()}\n`);
        } else if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, any>;
          console.log(`  tool  ${block.name} ${JSON.stringify(input)}`);
          try {
            const out = await runTool(block.name, input);
            console.log(`  ->    ${clip(out, 400)}\n`);
            results.push({ type: 'tool_result', tool_use_id: block.id, content: clip(out, 8000) });
          } catch (e) {
            const msg = (e as Error).message;
            console.log(`  ->    error: ${clip(msg, 400)}\n`);
            results.push({ type: 'tool_result', tool_use_id: block.id, content: `error: ${msg}`, is_error: true });
          }
        }
      }

      if (res.stop_reason !== 'tool_use' || results.length === 0) {
        console.log(`(done: ${res.stop_reason})`);
        return;
      }
      messages.push({ role: 'user', content: results });
    }
    console.log(`(stopped after ${MAX_TURNS} turns)`);
  } finally {
    await mcp.close();
  }
}

main().catch((e) => {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exit(1);
});
