/**
 * The Preflight MCP server.
 *
 * This is the product surface. An agent with signing capability calls
 * preflight_check before it acts, and gets back a severity it did not choose,
 * evidence it can quote, and a policy line it is expected to obey.
 *
 * Protocol note: MCP speaks JSON-RPC over stdout. Nothing in this process may
 * write to stdout except the transport. All diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MIN_COVERAGE, createStore, runPreflight, type VerdictStore } from '@preflight/engine';
import { z } from 'zod';
import { renderList, renderVerdict } from './render.js';

const log = (msg: string) => process.stderr.write(`[mcp] ${msg}\n`);

const server = new McpServer({ name: 'preflight', version: '0.1.0' });

// One store for the life of the process, so preflight_explain can find what
// preflight_check wrote even when Postgres is down and we are in memory.
let store: VerdictStore;

server.registerTool(
  'preflight_check',
  {
    title: 'Preflight check',
    description:
      'Check a contract address for behavioural risk before signing anything against it. ' +
      'Returns a severity (clean, low, medium, high) computed from weighted on-chain signals, ' +
      'with the evidence behind each one. A HIGH verdict means the caller must obtain human ' +
      'confirmation on a hardware device before proceeding. Call this before any approval, ' +
      'transfer or swap involving an address the user has not already vetted.',
    inputSchema: {
      address: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address')
        .describe('The contract address to check.'),
      chainId: z
        .number()
        .int()
        .default(1)
        .describe('EVM chain id. 1 Ethereum, 8453 Base, 42161 Arbitrum, 10 Optimism, 137 Polygon.'),
    },
  },
  async ({ address, chainId }) => {
    try {
      const verdict = await runPreflight(address, chainId, { store });
      const { ran, total } = verdict.coverage;
      log(
        `${verdict.address} chain ${verdict.chainId} -> ${verdict.severity} ${verdict.score} ` +
          `(${verdict.id}, coverage ${ran}/${total})`,
      );

      // An outage must not be answerable as a clean bill of health. When most
      // of the checks did not complete, the honest response is that we do not
      // know, returned as an error so a caller cannot mistake it for a pass.
      if (ran / total < MIN_COVERAGE) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `Preflight could not complete enough checks to judge this address. ` +
                `Only ${ran} of ${total} ran.\n\n` +
                renderVerdict(verdict, { full: true }) +
                `\n\nTreat this as unknown risk, not absence of risk. Do not sign on the ` +
                `assumption that the address is safe.`,
            },
          ],
        };
      }

      return { content: [{ type: 'text', text: renderVerdict(verdict) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`check failed: ${msg}`);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `Preflight could not produce a verdict: ${msg}\n\n` +
              'Treat this as unknown risk, not as absence of risk. Do not sign on the ' +
              'assumption that the address is safe.',
          },
        ],
      };
    }
  },
);

server.registerTool(
  'preflight_explain',
  {
    title: 'Explain a verdict',
    description:
      'Retrieve the full evidence behind a verdict that preflight_check already produced, ' +
      'including explorer links and the per-signal reasoning. Use this when the user asks why ' +
      'an address was flagged.',
    inputSchema: {
      verdictId: z.string().describe('The id printed by preflight_check.'),
    },
  },
  async ({ verdictId }) => {
    const verdict = await store.get(verdictId);
    if (!verdict) {
      return {
        isError: true,
        content: [{ type: 'text', text: `No verdict with id ${verdictId}.` }],
      };
    }
    return { content: [{ type: 'text', text: renderVerdict(verdict, { full: true }) }] };
  },
);

server.registerTool(
  'preflight_recent',
  {
    title: 'Recent verdicts',
    description: 'List the most recent Preflight verdicts, newest first.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(10).describe('How many to return.'),
    },
  },
  async ({ limit }) => {
    const verdicts = await store.recent(limit);
    return { content: [{ type: 'text', text: renderList(verdicts) }] };
  },
);

store = await createStore();
log(`storage: ${store.kind}`);
await server.connect(new StdioServerTransport());
log('ready on stdio');
