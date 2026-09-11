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
import { loadRingSecrets } from '@preflight/gate';
import { z } from 'zod';
import { renderList, renderVerdict } from './render.js';

const log = (msg: string) => {
  try {
    process.stderr.write(`[mcp] ${msg}\n`);
  } catch {
    // The client is gone. Losing a diagnostic is not worth a crash.
  }
};

/**
 * The client can vanish mid-response: its request timed out, or the editor was
 * closed. Writing to the closed pipe raises EPIPE, which Node treats as an
 * unhandled 'error' event on the stream and turns into a crash dump on the
 * user's terminal.
 *
 * That dump is worse than useless. It appears after the client has already
 * reported the real problem, it names an internal stream write rather than
 * anything actionable, and it reads like the server is broken when the server
 * is the one thing that still worked. There is nobody left to answer and
 * nothing to recover, so leave quietly.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    log(`stream error: ${err.message}`);
  });
}

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
        .describe(
          'EVM chain id. Fully supported: 1 Ethereum, 42161 Arbitrum, 8453 Base. ' +
            'Other chains return a partial verdict: contract analysis still runs, but ' +
            'no Uniswap V3 market data is indexed for them, so the liquidity and pool ' +
            'signals report that they could not run.',
        ),
    },
  },
  async ({ address, chainId }) => {
    try {
      // gate: true is what makes a high verdict stop rather than advise. It
      // blocks until someone presses a button on the device, or until it times
      // out, which is a refusal.
      const verdict = await runPreflight(address, chainId, { store, gate: true });
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
                renderVerdict(verdict) +
                `\n\nTreat this as unknown risk, not absence of risk. Do not sign on the ` +
                `assumption that the address is safe.`,
            },
          ],
        };
      }

      // A required confirmation that was not granted is a refusal, not a
      // verdict with a note attached. Returning it as an error means a caller
      // cannot read past it.
      if (verdict.gate?.required && !verdict.gate.approved) {
        log(`${verdict.id} REFUSED: ${verdict.gate.reason ?? 'not approved'}`);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `Refused. This address scored ${verdict.severity.toUpperCase()} and a human ` +
                `did not approve it on the hardware device.\n\n` +
                `Reason: ${verdict.gate.reason ?? 'not approved'}\n\n` +
                renderVerdict(verdict) +
                `\n\nDo not sign anything against this address. Ask the user to connect ` +
                `their Ledger and confirm on the device, then call preflight_check again.`,
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

// Credentials held as ciphertext are decrypted against the Ledger Key Ring
// before anything needs them. Absent files are not an error: the .env path
// still works and the log says which credentials came from where.
const ring = await loadRingSecrets(process.cwd());
if (ring.loaded.length) log(`key ring: decrypted ${ring.loaded.join(', ')}`);
for (const e of ring.errors) log(`key ring: ${e}`);

store = await createStore();
log(`storage: ${store.kind}`);
await server.connect(new StdioServerTransport());
log('ready on stdio');
