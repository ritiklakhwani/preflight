/**
 * Credential bootstrap for every entry point that is not the MCP server.
 *
 * Importing this module decrypts the Key Ring credentials into the environment
 * before anything reads them. It exists because moving the API keys onto the
 * Ledger Key Ring made `packages/mcp/src/index.ts` the only thing that loaded
 * them, and every dev tool silently lost its keys: the benchmark scored all
 * twenty addresses clean with eight signals unable to run, and reported no
 * false positives, because nothing had run at all.
 *
 * Import it first. ES modules evaluate imports before the importing module's
 * body, so a script reading process.env at its top level still sees the
 * decrypted value.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRingSecrets } from '../packages/gate/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ring = await loadRingSecrets(root);

if (ring.loaded.length) {
  process.stderr.write(`[boot] key ring: decrypted ${ring.loaded.join(', ')}\n`);
}
for (const e of ring.errors) process.stderr.write(`[boot] key ring: ${e}\n`);
