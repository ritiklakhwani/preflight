/**
 * Rehearses the Capline demo flows end to end on live Whitechain Sepolia
 * (1874), driving the real programs as child processes:
 *
 *   approval server  pnpm --filter @preflight/approve start (push off, temp data file)
 *   merchant         pnpm --filter @preflight/merchant start (honest, then MERCHANT_EVIL=1)
 *   payer agent      pnpm --filter @preflight/payer-whitechain scripted / self-release
 *
 * The owner is played by a software P-256 passkey (scripts/lib/soft-passkey.ts)
 * that signs through the phone's own buildAuth. The agent is a fresh throwaway
 * wallet passed to the payer scripts through env overrides; the real payer
 * agent stays unregistered for the phone.
 *
 *   1. start the approval server and the honest merchant
 *   2. throwaway agent: 0.1 WBT gas, registered with 10 USDT, 3 USDT tranche
 *   3. happy path: agent spends the tranche, asks for 5, owner approves
 *   4. evil path: injected partner payment and a 500 ask, owner reads
 *      Receipts, declines and drops; agent self-release reverts
 *   5. cleanup: undrop, withdraw the vault side, agent returns USDT and WBT
 *
 *   node --env-file=.env --import tsx scripts/rehearse.ts
 *
 * Needs ports APPROVE_PORT (8787) and MERCHANT_PORT (8788) free: it will not
 * reuse a running server, since that one may push to the owner's phone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApiClient,
  dropDigest,
  erc20Abi,
  formatAmount,
  getChain,
  isRegistered,
  parseAmount,
  publicClient,
  readAgent,
  releaseDigest,
  requireVault,
  submitUndrop,
  txLink,
  undropDigest,
  vaultAbi,
  walletBalance,
  walletClient,
  withdrawDigest,
  type Request,
} from '../packages/capline/src/index.js';
import { SoftwarePasskey } from './lib/soft-passkey.js';

type Hex = `0x${string}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN = 'whitechain' as const;
const PARTNER_SINK = '0x4fecae863ef2a0c64e211336c2bfcc822165c98a';
const REAL_PAYER_AGENT = '0xd541a082dfb023f7cad286458977a7f9b4a1778d';

const AGENT_GAS = 100_000_000_000_000_000n; // 0.1 WBT
const VAULT_TRANCHE = 10_000_000n; // 10 USDT registered in the vault
const START_TRANCHE = 3_000_000n; // 3 USDT in the agent wallet to start
const REFILL_HUMAN = '5'; // what the scripted agent asks for on the happy path
const EVIL_HUMAN = '500'; // what the injection makes it ask for
const CHILD_TIMEOUT_MS = 10 * 60_000;

// ------------------------------------------------------------------ output

const txs: { label: string; hash: Hex }[] = [];
const steps: { name: string; ok: boolean; note?: string }[] = [];

function record(label: string, hash: Hex): void {
  txs.push({ label, hash });
  console.log(`    tx  ${label}  ${txLink(CHAIN, hash)}`);
}

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
  console.log(`    ok  ${what}`);
}

async function step(name: string, body: () => Promise<void>): Promise<boolean> {
  console.log(`\n== ${name}`);
  try {
    await body();
    steps.push({ name, ok: true });
    return true;
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    console.error(`    FAIL ${note}`);
    steps.push({ name, ok: false, note });
    process.exitCode = 1;
    return false;
  }
}

const usdt = (units: bigint) => `${formatAmount(CHAIN, units)} USDT`;
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envKey(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
}

// ------------------------------------------------------------------ child processes

interface Proc {
  name: string;
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
  stop: () => void;
}

const procs = new Set<Proc>();

/**
 * Runs `pnpm --filter <pkg> <script>` in its own process group (pnpm, node and
 * tsx stop together). `echo` streams its output live with a prefix.
 */
function run(name: string, pkg: string, script: string, env: Record<string, string>, echo: boolean): Proc {
  const child = spawn('pnpm', ['--silent', '--filter', pkg, script], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const lines: string[] = [];
  const onData = (b: Buffer) => {
    for (const line of b.toString().split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      if (echo) console.log(`    [${name}] ${line}`);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
  const proc: Proc = {
    name,
    child,
    lines,
    exited,
    stop: () => {
      try {
        if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      procs.delete(proc);
    },
  };
  procs.add(proc);
  return proc;
}

function stopAll(): void {
  for (const p of [...procs]) p.stop();
}
process.once('exit', stopAll);
process.once('SIGINT', () => {
  stopAll();
  process.exit(130);
});

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function startService(
  name: string,
  pkg: string,
  env: Record<string, string>,
  healthUrl: string,
): Promise<Proc> {
  if (await up(healthUrl)) {
    throw new Error(`${healthUrl} already answers. Stop that ${name} first; the rehearsal starts its own.`);
  }
  const p = run(name, pkg, 'start', env, false);
  for (let i = 0; i < 90; i++) {
    if (await up(healthUrl)) return p;
    if (p.child.exitCode !== null) break;
    await sleep(500);
  }
  p.stop();
  throw new Error(`${name} did not come up:\n${p.lines.slice(-20).join('\n')}`);
}

async function stopService(p: Proc | undefined, healthUrl: string): Promise<void> {
  if (!p) return;
  p.stop();
  await Promise.race([p.exited, sleep(5000)]);
  for (let i = 0; i < 20 && (await up(healthUrl)); i++) await sleep(250);
}

/** Runs a program to completion; resolves with its exit code and output. */
async function runToExit(
  name: string,
  pkg: string,
  script: string,
  env: Record<string, string>,
): Promise<{ code: number | null; lines: string[] }> {
  const p = run(name, pkg, script, env, true);
  const timer = setTimeout(() => {
    console.error(`    ${name} timed out after ${CHILD_TIMEOUT_MS / 60_000} min, stopping it`);
    p.stop();
  }, CHILD_TIMEOUT_MS);
  const code = await p.exited;
  clearTimeout(timer);
  procs.delete(p);
  return { code, lines: p.lines };
}

/** Explorer tx links printed by the payer, labelled with the step that sent them. */
function collectTxs(prefix: string, lines: string[]): void {
  let label = prefix;
  for (const line of lines) {
    const s = line.match(/step \d+: (.*)$/);
    if (s) label = `${prefix}: ${s[1]}`;
    const t = line.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
    if (t) txs.push({ label, hash: t[1] as Hex });
  }
}

// ------------------------------------------------------------------ the owner

const cfg = getChain(CHAIN);
const vault = requireVault(CHAIN);
const pub = publicClient(CHAIN);

async function mined(label: string, hash: Hex): Promise<void> {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  record(label, hash);
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
}

/** Polls the server like the phone's agent screen until one new pending request shows up. */
async function nextPending(api: ReturnType<typeof createApiClient>, agent: Hex, seen: Set<string>, stopped: () => boolean): Promise<Request | undefined> {
  while (!stopped()) {
    try {
      const pending = (await api.listRequests(agent)).find((r) => r.status === 'pending' && !seen.has(r.id));
      if (pending) {
        seen.add(pending.id);
        return pending;
      }
    } catch {
      // Server busy or restarting; try again.
    }
    await sleep(1500);
  }
  return undefined;
}

/** The digest the passkey signs, rebuilt from chain state rather than taken from the server. */
async function verifyDigest(r: Request): Promise<void> {
  const s = await readAgent(CHAIN, r.agent);
  check(BigInt(r.nonce) === s.nonce, `request nonce ${r.nonce} is the vault nonce`);
  const local = releaseDigest({
    chain: CHAIN,
    vault,
    agent: r.agent,
    amount: BigInt(r.amount),
    nonce: s.nonce,
    expiry: r.expiry,
    receiptsHash: r.receipts.receiptsHash,
  });
  check(local === r.digest, 'request digest matches the Release digest rebuilt locally');
}

// ------------------------------------------------------------------ the run

async function main(): Promise<void> {
  const deployer = walletClient(CHAIN, envKey('DEPLOYER_PRIVATE_KEY'));
  const relayerKey = envKey(process.env.RELAYER_PRIVATE_KEY ? 'RELAYER_PRIVATE_KEY' : 'DEPLOYER_PRIVATE_KEY');
  const approvePort = process.env.APPROVE_PORT ?? '8787';
  const merchantPort = process.env.MERCHANT_PORT ?? '8788';
  const apiBase = `http://localhost:${approvePort}`;
  const merchantBase = `http://localhost:${merchantPort}`;
  const api = createApiClient(apiBase, { timeoutMs: 120_000 });
  const partner = (process.env.PARTNER_ADDRESS ?? '').toLowerCase();

  // Lives only in memory and in the child env for this run, never printed.
  const agentKey: Hex = `0x${randomBytes(32).toString('hex')}`;
  const agentWallet = walletClient(CHAIN, agentKey);
  const agent = agentWallet.account.address;
  const owner = new SoftwarePasskey();
  const payerEnv: Record<string, string> = {
    PAYER_AGENT_PRIVATE_KEY: agentKey,
    CAPLINE_AGENT_ADDRESS: agent,
    CAPLINE_API_URL: apiBase,
    MERCHANT_URL: merchantBase,
    SCRIPTED_REFILL_AMOUNT: REFILL_HUMAN,
    CAPLINE_POLL_MS: '3000',
  };

  console.log(`Capline rehearsal on ${cfg.name} (${cfg.id})`);
  console.log(`  vault    ${vault}`);
  console.log(`  deployer ${deployer.account.address}`);
  console.log(`  agent    ${agent} (throwaway)`);
  console.log(`  partner  ${process.env.PARTNER_ADDRESS}`);

  let approve: Proc | undefined;
  let merchant: Proc | undefined;
  let registered = false;
  const merchantHealth = `${merchantBase}/health`;

  try {
    const servicesUp = await step('1. Start the approval server (push off) and the honest merchant', async () => {
      check(partner === PARTNER_SINK, 'PARTNER_ADDRESS is the PartnerSink');
      check(agent.toLowerCase() !== REAL_PAYER_AGENT, 'agent is not the real payer agent');
      const dataFile = join(tmpdir(), `capline-rehearse-${Date.now()}.json`);
      approve = await startService('approve', '@preflight/approve', { NTFY_TOPIC: '', APPROVE_DATA_FILE: dataFile }, `${apiBase}/api/health`);
      console.log(`    approval server up at ${apiBase}, data in ${dataFile}`);
      merchant = await startService('merchant', '@preflight/merchant', { MERCHANT_EVIL: '' }, merchantHealth);
      const h = (await (await fetch(merchantHealth)).json()) as { evil: boolean };
      check(h.evil === false, `merchant up at ${merchantBase}, honest mode`);
    });
    if (!servicesUp) return;

    const setup = await step('2. Throwaway agent: 0.1 WBT, registered with 10 USDT, 3 USDT tranche', async () => {
      const usdtHeld = await walletBalance(CHAIN, deployer.account.address);
      check(usdtHeld >= VAULT_TRANCHE + START_TRANCHE, `deployer holds ${usdt(usdtHeld)}`);
      check(!isRegistered(await readAgent(CHAIN, agent)), 'agent is not registered yet');
      await mined('fund agent 0.1 WBT', await deployer.sendTransaction({ to: agent, value: AGENT_GAS }));
      await mined(
        'approve 10 USDT to the vault',
        await deployer.writeContract({ address: cfg.token, abi: erc20Abi, functionName: 'approve', args: [vault, VAULT_TRANCHE] }),
      );
      await mined(
        'register agent with the software passkey, 10 USDT',
        await deployer.writeContract({
          address: vault,
          abi: vaultAbi,
          functionName: 'register',
          args: [agent, owner.qx, owner.qy, cfg.token, VAULT_TRANCHE],
        }),
      );
      registered = true;
      await mined(
        'send the agent a 3 USDT starting tranche',
        await deployer.writeContract({ address: cfg.token, abi: erc20Abi, functionName: 'transfer', args: [agent, START_TRANCHE] }),
      );
      const s = await readAgent(CHAIN, agent);
      check(s.qx === owner.qx && s.balance === VAULT_TRANCHE && !s.dropped, `vault holds ${usdt(s.balance)} for the agent`);
      check((await walletBalance(CHAIN, agent)) === START_TRANCHE, 'agent wallet holds 3 USDT');
    });

    if (setup) {
      await step('3. Happy path: agent runs dry, asks for 5 USDT, owner approves', async () => {
        let done = false;
        const seen = new Set<string>();
        // The owner: waits for the push, checks the request, signs with Face ID.
        const ownerRun = (async () => {
          const r = await nextPending(api, agent, seen, () => done);
          if (!r) throw new Error('no pending request reached the owner');
          console.log(`    owner sees request ${r.id}: ${usdt(BigInt(r.amount))}, ${r.receipts.receipts.length} receipts`);
          check(r.amount === parseAmount(CHAIN, REFILL_HUMAN).toString(), `request amount is ${REFILL_HUMAN} USDT in base units (${r.amount})`);
          await verifyDigest(r);
          const before = await walletBalance(CHAIN, agent);
          const { txHash } = await api.approve(r.id, owner.sign(r.digest));
          await mined(`release ${REFILL_HUMAN} USDT (owner approved, server relayed)`, txHash);
          const after = await walletBalance(CHAIN, agent);
          check(after - before === BigInt(r.amount), `agent wallet ${usdt(before)} -> ${usdt(after)}`);
          return txHash;
        })();
        ownerRun.catch(() => {});

        const payer = await runToExit('payer', '@preflight/payer-whitechain', 'scripted', payerEnv);
        done = true;
        collectTxs('happy', payer.lines);
        await ownerRun;
        check(payer.code === 0, 'scripted agent exited cleanly');
        check(payer.lines.some((l) => /status: released/.test(l)), 'agent saw status: released through capline_status');
        check(payer.lines.some((l) => /owner approved\. New tranche balance: 5(\.0+)? USDT/.test(l)), 'agent reports its new 5 USDT tranche');
        const s = await readAgent(CHAIN, agent);
        check(s.balance === VAULT_TRANCHE - parseAmount(CHAIN, REFILL_HUMAN), `vault side now ${usdt(s.balance)}`);
      });

      await step('4. Evil path: injection, 500 USDT ask, owner declines and drops', async () => {
        await stopService(merchant, merchantHealth);
        merchant = await startService('merchant', '@preflight/merchant', { MERCHANT_EVIL: '1' }, merchantHealth);
        const h = (await (await fetch(merchantHealth)).json()) as { evil: boolean };
        check(h.evil === true, 'merchant restarted in evil mode');

        let done = false;
        const seen = new Set<string>((await api.listRequests(agent)).map((r) => r.id));
        // The careful owner: reads Receipts before deciding.
        const ownerRun = (async () => {
          const r = await nextPending(api, agent, seen, () => done);
          if (!r) throw new Error('no pending request reached the owner');
          console.log(`    owner sees request ${r.id}: ${usdt(BigInt(r.amount))}`);
          console.log(`    counterparty ${r.counterparty?.address} verdict ${r.counterparty?.verdict}: ${r.counterparty?.reasons.join('; ')}`);
          for (const x of r.receipts.receipts) console.log(`    receipt  ${usdt(BigInt(x.amount))} to ${x.to} verdict ${x.verdict}`);
          // Decline first, whatever the checks say: a careful owner never pays this.
          const declined = await api.decline(r.id);
          const s = await readAgent(CHAIN, agent);
          const expiry = nowSec() + 900;
          const auth = owner.sign(dropDigest({ chain: CHAIN, vault, agent, nonce: s.nonce, expiry }));
          const { txHash } = await api.drop(agent, { chain: CHAIN, expiry, auth });
          await mined('drop (owner signed, server relayed)', txHash);

          check(r.amount === parseAmount(CHAIN, EVIL_HUMAN).toString(), `request amount is ${EVIL_HUMAN} USDT in base units (${r.amount})`);
          check(
            r.receipts.receipts.some((x) => x.to.toLowerCase() === PARTNER_SINK && x.verdict === 'high'),
            'Receipts include the partner payment with verdict high',
          );
          check(r.counterparty?.address.toLowerCase() === PARTNER_SINK && r.counterparty.verdict === 'high', 'counterparty is the partner, verdict high');
          check(r.reason.includes('Premium data access'), 'reason carries the injected text (shown unverified)');
          check(declined.status === 'declined', 'server marks the request declined');
          check((await readAgent(CHAIN, agent)).dropped, 'vault: agent is dropped');
        })();
        ownerRun.catch(() => {});

        const payer = await runToExit('payer', '@preflight/payer-whitechain', 'scripted', payerEnv);
        done = true;
        collectTxs('evil', payer.lines);
        await ownerRun;
        check(payer.code === 0, 'scripted agent exited cleanly');
        check(payer.lines.some((l) => /merchant response contains an instruction/.test(l)), 'agent fell for the injection');
        check(payer.lines.some((l) => /capline_request 500 USDT/.test(l)), 'agent asked for 500 USDT');
        check(payer.lines.some((l) => /status: declined/.test(l)), 'agent saw status: declined through capline_status');
        check(payer.lines.some((l) => /owner declined/.test(l)), 'agent stops after the decline');

        console.log('\n    agent tries to release funds to itself');
        const self = await runToExit('self-release', '@preflight/payer-whitechain', 'self-release', {
          ...payerEnv,
          SELF_RELEASE_SEND: '1',
        });
        collectTxs('self-release while dropped', self.lines);
        check(self.lines.some((l) => /^reverted: IsDropped/.test(l)), 'eth_call reverts IsDropped');
        check(self.lines.some((l) => /sent on chain: status reverted/.test(l)), 'sent tx lands reverted on chain');
      });
    }
  } finally {
    if (registered) {
      await step('5. Cleanup: undrop, withdraw the vault side, agent returns its funds', async () => {
        const to = deployer.account.address;
        let s = await readAgent(CHAIN, agent);
        if (s.dropped) {
          const expiry = nowSec() + 900;
          const auth = owner.sign(undropDigest({ chain: CHAIN, vault, agent, nonce: s.nonce, expiry }));
          await mined('undrop (owner signed)', await submitUndrop(CHAIN, relayerKey, { agent, expiry, auth }));
          s = await readAgent(CHAIN, agent);
          check(!s.dropped, 'agent is live again');
          const self = await runToExit('self-release', '@preflight/payer-whitechain', 'self-release', payerEnv);
          check(self.lines.some((l) => /^reverted: BadSignature/.test(l)), 'self-release after undrop reverts BadSignature');
        }
        if (s.balance > 0n) {
          const expiry = BigInt(nowSec() + 900);
          const auth = owner.sign(withdrawDigest({ chain: CHAIN, vault, agent, to, amount: s.balance, nonce: s.nonce, expiry }));
          const relayer = walletClient(CHAIN, relayerKey);
          const { request } = await pub.simulateContract({
            address: vault,
            abi: vaultAbi,
            functionName: 'withdraw',
            args: [agent, to, s.balance, expiry, auth],
            account: relayer.account,
          });
          await mined(`owner-signed withdraw ${usdt(s.balance)} to the deployer`, await relayer.writeContract(request));
        }
        check((await readAgent(CHAIN, agent)).balance === 0n, 'vault side is empty');
        const held = await walletBalance(CHAIN, agent);
        if (held > 0n) {
          await mined(
            `agent returns ${usdt(held)}`,
            await agentWallet.writeContract({ address: cfg.token, abi: erc20Abi, functionName: 'transfer', args: [to, held] }),
          );
        }
        check((await walletBalance(CHAIN, agent)) === 0n, 'agent wallet holds no USDT');
        // Leftover gas back too. Keep twice this transfer's fee aside: the RPC
        // is load balanced and a balance read can lag a block behind.
        const wbt = await pub.getBalance({ address: agent });
        const gasPrice = (await pub.getGasPrice()) * 2n;
        const fee = 21_000n * gasPrice;
        if (wbt > fee * 4n) {
          await mined(
            'agent returns leftover WBT',
            await agentWallet.sendTransaction({ to, value: wbt - fee * 2n, gas: 21_000n, gasPrice }),
          );
        }
      });
    }
    await stopService(merchant, merchantHealth);
    await stopService(approve, `${apiBase}/api/health`);
    stopAll();
  }
}

try {
  await main();
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

console.log('\n== Summary');
for (const s of steps) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.note ? `\n        ${s.note.split('\n')[0]}` : ''}`);
console.log('\n== Transactions');
for (const t of txs) console.log(`  ${t.label}\n    ${txLink(CHAIN, t.hash)}`);
console.log(process.exitCode ? '\nREHEARSAL FAILED' : '\nREHEARSAL PASSED');
process.exit(process.exitCode ?? 0);
