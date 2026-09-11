/**
 * Dev tool. Spawns the Preflight MCP server exactly the way Cursor or Claude
 * Desktop would, lists its tools, and calls them.
 *
 * This is the Day 2 gate in one command: if this prints a verdict, an agent
 * gets a verdict.
 *
 *   node --env-file=.env --import tsx scripts/mcp-smoke.ts [address] [chainId]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const address = process.argv[2] ?? '0x6b175474e89094c44da98b954eedeac495271d0f';
const chainId = Number(process.argv[3] ?? 1);

const transport = new StdioClientTransport({
  // Spawns through the same launcher an MCP client uses, so this exercises
  // the real entry point rather than a convenient shortcut around it.
  command: resolve(root, 'bin/preflight-mcp'),
  args: [],
  cwd: root,
  // StdioClientTransport passes a filtered environment by default, so
  // overrides like GATE_TIMEOUT_MS never reach the server without this.
  env: { ...process.env } as Record<string, string>,
  stderr: 'inherit',
});

const client = new Client({ name: 'preflight-smoke', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('TOOLS');
for (const t of tools) {
  console.log(`  ${t.name}  ${Object.keys(t.inputSchema.properties ?? {}).join(', ')}`);
}

function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

console.log('\n--- preflight_check ---');
const t0 = Date.now();
const check = await client.callTool({ name: 'preflight_check', arguments: { address, chainId } });
console.log(text(check));
console.log(`[${Date.now() - t0}ms]`);

// The full evidence view is the same verdict again, at length. Printing both
// back to back doubled the output of every run and pushed the answer off the
// top of the screen, so it is summarised here and shown only on request.
const id = text(check).match(/id ([0-9a-f]{8})/)?.[1];
if (id) {
  const full = text(await client.callTool({ name: 'preflight_explain', arguments: { verdictId: id } }));
  console.log('\n--- preflight_explain ---');
  if (process.argv.includes('--full')) {
    console.log(full);
  } else {
    const links = (full.match(/https:\/\//g) ?? []).length;
    const notes = full.includes('MODEL NOTES') ? full.split('MODEL NOTES')[1]!.split('\n\n')[0]!.trim().split('\n').length : 0;
    console.log(`resolved ${id}: full evidence, ${links} explorer links, ${notes} model notes.`);
    console.log('Pass --full to print it.');
  }
}

console.log('\n--- preflight_recent ---');
console.log(text(await client.callTool({ name: 'preflight_recent', arguments: { limit: 5 } })));

await client.close();
