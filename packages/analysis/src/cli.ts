/** Day 1 gate: prove the ported analysis module produces a verdict. */
import { analyse } from './index.js';

const address = process.argv[2];
const chainId = Number(process.argv[3] ?? 1);

if (!address) {
  console.error('usage: pnpm analyse <address> [chainId]');
  process.exit(1);
}

const t0 = Date.now();
const result = await analyse(address, chainId);
console.log(JSON.stringify(result, null, 2));
console.error(`\n[${Date.now() - t0}ms]`);
