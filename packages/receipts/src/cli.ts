// Usage: node [--env-file=.env] --import tsx packages/receipts/src/cli.ts <whitechain|base> <agent> [fromBlock] [toBlock]
import { buildReceipts } from './build.js';
import { isChainKey } from './chains.js';

const [chain, agent, from, to] = process.argv.slice(2);
if (!chain || !isChainKey(chain) || !agent) {
  process.stderr.write('usage: cli.ts <whitechain|base> <agent> [fromBlock] [toBlock]\n');
  process.exit(2);
}

try {
  const report = await buildReceipts({
    chain,
    agent,
    ...(from ? { fromBlock: Number(from) } : {}),
    ...(to ? { toBlock: Number(to) } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // Abandoned engine calls (timed out) can hold sockets open; do not wait on them.
  process.exit(0);
} catch (err) {
  process.stderr.write(`receipts: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
