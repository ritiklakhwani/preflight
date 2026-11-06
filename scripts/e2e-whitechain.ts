/**
 * Capline end to end on Whitechain Sepolia (1874), against the live vault.
 *
 * The owner's phone passkey is replaced by a software P-256 key that produces
 * WebAuthn assertions byte for byte like a browser does: the same
 * clientDataJSON shape, authenticatorData = sha256(rpId) || flags || counter,
 * a DER signature over sha256(authenticatorData || sha256(clientDataJSON)),
 * then the phone's own buildAuth (DER parsing, low-s, challenge/type indexes).
 *
 *   1. fresh throwaway agent EOA + software passkey, agent funded with gas
 *   2. deployer registers the agent with 6 USDT in the vault
 *   3. approval server builds a 2 USDT request; its digest is recomputed here
 *   4. software passkey approves, the server relays release(), funds arrive
 *   5. negative checks: replay, agent self-release, drop -> IsDropped, undrop
 *   6. cleanup: owner-signed withdraw of the remainder, agent returns its USDT
 *
 *   node --env-file=.env --import tsx scripts/e2e-whitechain.ts
 *
 * Uses the approval server on APPROVE_PORT (default 8787) if one is running,
 * otherwise starts it with push notifications off and a throwaway data file.
 * Never registers the real payer agent; that slot is kept for the phone.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiError,
  createApiClient,
  dropDigest,
  erc20Abi,
  formatAmount,
  getChain,
  isRegistered,
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
  type WebAuthnAuth,
} from '../packages/capline/src/index.js';
import { buildReceipts } from '../packages/receipts/src/index.js';
import { P256_HALF_N } from '../apps/approve/web/src/webauthn.js';
import { revertName } from '../apps/approve/server/src/errors.js';
import { ORIGIN, RP_ID, SoftwarePasskey } from './lib/soft-passkey.js';

type Hex = `0x${string}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN = 'whitechain' as const;
const PARTNER_SINK: Hex = '0x4FECAE863ef2A0c64e211336C2bFCc822165c98a';
const REAL_PAYER_AGENT = '0xd541a082dfb023f7cad286458977a7f9b4a1778d';

const AGENT_GAS = 50_000_000_000_000_000n; // 0.05 WBT
const TRANCHE = 6_000_000n; // 6 USDT in the vault
const REFILL = 2_000_000n; // 2 USDT requested
const REVERT_GAS = 2_000_000n; // fixed gas so a known-bad call still lands as a reverted tx

// ------------------------------------------------------------------ output

const txs: { label: string; hash: Hex; status: string }[] = [];
const steps: { name: string; ok: boolean }[] = [];

function record(label: string, hash: Hex, status: string): void {
  txs.push({ label, hash, status });
  console.log(`    tx  ${label} [${status}]  ${txLink(CHAIN, hash)}`);
}

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
  console.log(`    ok  ${what}`);
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n== ${name}`);
  try {
    await body();
    steps.push({ name, ok: true });
  } catch (err) {
    steps.push({ name, ok: false });
    throw err;
  }
}

const usdt = (units: bigint) => `${formatAmount(CHAIN, units)} USDT`;
const nowSec = () => Math.floor(Date.now() / 1000);

function envKey(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex;
}

// ------------------------------------------------------------------ approval server

async function healthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reuses a running server, or starts one. Returns a stop function. */
async function ensureServer(base: string): Promise<{ stop: () => void; log: string[] }> {
  const log: string[] = [];
  if (await healthy(base)) {
    console.log(`    using the approval server already running at ${base} (it may push to ntfy)`);
    return { stop: () => {}, log };
  }
  const dataFile = join(tmpdir(), `capline-e2e-${Date.now()}.json`);
  const child = spawn('pnpm', ['--filter', '@preflight/approve', 'start'], {
    cwd: ROOT,
    detached: true, // own process group, so pnpm, node and tsx all stop together
    stdio: ['ignore', 'pipe', 'pipe'],
    // No push to the owner's phone, and keep test requests out of the real store.
    env: { ...process.env, NTFY_TOPIC: '', APPROVE_DATA_FILE: dataFile },
  });
  for (const s of [child.stdout, child.stderr]) s.on('data', (b: Buffer) => log.push(...b.toString().trim().split('\n')));
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };
  process.once('exit', stop);
  for (let i = 0; i < 60; i++) {
    if (await healthy(base)) {
      console.log(`    started the approval server at ${base} (push off, data in ${dataFile})`);
      return { stop, log };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`approval server did not come up:\n${log.join('\n')}`);
}

// ------------------------------------------------------------------ chain helpers

const cfg = getChain(CHAIN);
const vault = requireVault(CHAIN);
const pub = publicClient(CHAIN);
type Wallet = ReturnType<typeof walletClient>;

async function mined(label: string, hash: Hex): Promise<void> {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  record(label, hash, receipt.status);
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
}

type ReleaseArgs = readonly [Hex, bigint, bigint, Hex, WebAuthnAuth];

/**
 * Proves a release call is rejected, twice over: eth_call must revert with the
 * expected custom error, and the same call sent for real must land reverted.
 */
async function expectReleaseRevert(label: string, from: Wallet, args: ReleaseArgs, expected: string): Promise<void> {
  const call = { address: vault, abi: vaultAbi, functionName: 'release', args } as const;
  let reason: string | undefined;
  try {
    await pub.simulateContract({ ...call, account: from.account });
  } catch (err) {
    reason = revertName(err);
  }
  check(reason === expected, `${label}: eth_call reverts ${expected} (got ${reason ?? 'no revert'})`);
  const hash = await from.writeContract({ ...call, gas: REVERT_GAS });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  record(label, hash, receipt.status);
  check(receipt.status === 'reverted', `${label}: on-chain tx reverted`);
}

// ------------------------------------------------------------------ the run

async function main(): Promise<void> {
  const deployer = walletClient(CHAIN, envKey('DEPLOYER_PRIVATE_KEY'));
  const relayerKey = envKey(process.env.RELAYER_PRIVATE_KEY ? 'RELAYER_PRIVATE_KEY' : 'DEPLOYER_PRIVATE_KEY');
  const relayer = walletClient(CHAIN, relayerKey);
  const apiBase = `http://localhost:${process.env.APPROVE_PORT ?? 8787}`;
  const api = createApiClient(apiBase, { timeoutMs: 120_000 });

  // Lives only in memory for this run, never printed.
  const agentWallet = walletClient(CHAIN, `0x${randomBytes(32).toString('hex')}`);
  const agent = agentWallet.account.address;
  const passkey = new SoftwarePasskey(RP_ID, ORIGIN);

  console.log(`Capline e2e on ${cfg.name} (${cfg.id})`);
  console.log(`  vault    ${vault}`);
  console.log(`  token    ${cfg.token}`);
  console.log(`  deployer ${deployer.account.address}`);
  console.log(`  relayer  ${relayer.account.address}`);

  let server: { stop: () => void; log: string[] } | undefined;
  try {
    await step('1. Throwaway agent and software passkey', async () => {
      console.log(`    agent ${agent}`);
      console.log(`    passkey qx ${passkey.qx}`);
      console.log(`    passkey qy ${passkey.qy}`);
      check(agent.toLowerCase() !== REAL_PAYER_AGENT, 'agent is not the real payer agent');
      check(!isRegistered(await readAgent(CHAIN, agent)), 'agent is not registered yet');
      await mined('fund agent 0.05 WBT', await deployer.sendTransaction({ to: agent, value: AGENT_GAS }));
      check((await pub.getBalance({ address: agent })) === AGENT_GAS, 'agent holds 0.05 WBT for gas');
    });

    await step('2. Register the agent with 6 USDT', async () => {
      const approve = await deployer.writeContract({
        address: cfg.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vault, TRANCHE],
      });
      await mined('approve USDT', approve);
      const register = await deployer.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'register',
        args: [agent, passkey.qx, passkey.qy, cfg.token, TRANCHE],
      });
      await mined('register agent', register);
      const s = await readAgent(CHAIN, agent);
      check(s.qx === passkey.qx && s.qy === passkey.qy, 'vault stores the passkey public key');
      check(s.token.toLowerCase() === cfg.token.toLowerCase(), 'vault token is USDT');
      check(s.balance === TRANCHE && s.nonce === 0n && !s.dropped, `vault holds ${usdt(s.balance)}, nonce 0, not dropped`);
    });

    let requestId = '';
    let request: Awaited<ReturnType<typeof api.getRequest>> | undefined;
    await step('3. Refill request through the approval server', async () => {
      server = await ensureServer(apiBase);
      const created = await api.createRequest({
        chain: CHAIN,
        agent,
        amount: REFILL.toString(),
        reason: 'e2e: pay the partner sink for a data feed',
        counterparty: PARTNER_SINK,
      });
      requestId = created.id;
      check(created.status === 'pending', `request ${requestId} is pending`);
      request = await api.getRequest(requestId);
      const r = request;
      console.log(`    counterparty verdict ${r.counterparty?.verdict}: ${r.counterparty?.reasons.join('; ')}`);
      console.log(`    receipts blocks ${r.receipts.fromBlock}..${r.receipts.toBlock}, ${r.receipts.receipts.length} receipts`);

      // Nothing the server says is trusted: rebuild the digest from chain state.
      const s = await readAgent(CHAIN, agent);
      const rebuilt = await buildReceipts({ chain: CHAIN, agent, fromBlock: r.receipts.fromBlock, toBlock: r.receipts.toBlock });
      check(rebuilt.receiptsHash === r.receipts.receiptsHash, 'receiptsHash rebuilt from chain logs matches the server');
      check(BigInt(r.nonce) === s.nonce, `request nonce ${r.nonce} is the vault nonce`);
      check(r.amount === REFILL.toString(), 'request amount is 2 USDT');
      const local = releaseDigest({
        chain: CHAIN,
        vault,
        agent,
        amount: REFILL,
        nonce: s.nonce,
        expiry: r.expiry,
        receiptsHash: rebuilt.receiptsHash,
      });
      const onchain = await pub.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'releaseDigest',
        args: [agent, REFILL, s.nonce, BigInt(r.expiry), rebuilt.receiptsHash],
      });
      console.log(`    digest ${r.digest}`);
      check(local === r.digest, 'server digest equals capline releaseDigest computed locally');
      check(onchain === r.digest, 'server digest equals the vault releaseDigest view');
      if (server.log.length) check(server.log.some((l) => l.includes('NTFY_TOPIC unset')), 'no push sent to the phone');
    });

    let approvedAuth: WebAuthnAuth | undefined;
    await step('4. Software passkey approves, server relays release()', async () => {
      const r = request!;
      const auth = passkey.sign(r.digest);
      approvedAuth = auth;
      const cd = JSON.parse(auth.clientDataJSON) as { challenge: string; origin: string };
      check(cd.origin === ORIGIN, `clientDataJSON origin ${cd.origin}`);
      check(auth.authenticatorData.slice(66, 68) === '05', 'authenticatorData flags 0x05 (UP | UV)');
      check(BigInt(auth.s) <= P256_HALF_N, 's is low (s <= n/2)');

      const before = await readAgent(CHAIN, agent);
      const walletBefore = await walletBalance(CHAIN, agent);
      const { txHash } = await api.approve(requestId, auth);
      await mined('release 2 USDT (relayed by server)', txHash);
      const after = await readAgent(CHAIN, agent);
      const walletAfter = await walletBalance(CHAIN, agent);
      check(walletAfter - walletBefore === REFILL, `agent wallet USDT +${usdt(walletAfter - walletBefore)}`);
      check(after.nonce === before.nonce + 1n, `vault nonce ${before.nonce} -> ${after.nonce}`);
      check(after.balance === before.balance - REFILL, `vault side now ${usdt(after.balance)}`);
      const done = await api.getRequest(requestId);
      check(done.status === 'released' && done.txHash === txHash, 'server marks the request released');
    });

    await step('5. Negative checks on chain', async () => {
      const r = request!;
      await expectReleaseRevert(
        'replay the approved auth',
        relayer,
        [agent, REFILL, BigInt(r.expiry), r.receipts.receiptsHash, approvedAuth!],
        'BadSignature',
      );

      const garbage: WebAuthnAuth = {
        r: `0x${'00'.repeat(31)}01`,
        s: `0x${'00'.repeat(31)}01`,
        challengeIndex: 0n,
        typeIndex: 0n,
        authenticatorData: '0x00',
        clientDataJSON: 'garbage',
      };
      await expectReleaseRevert(
        'agent self-release with garbage auth',
        agentWallet,
        [agent, REFILL, BigInt(nowSec() + 900), r.receipts.receiptsHash, garbage],
        'BadSignature',
      );

      // Kill switch: owner-signed drop, relayed by the server.
      let s = await readAgent(CHAIN, agent);
      const dropExpiry = nowSec() + 900;
      const dropAuth = passkey.sign(dropDigest({ chain: CHAIN, vault, agent, nonce: s.nonce, expiry: dropExpiry }));
      const { txHash: dropTx } = await api.drop(agent, { chain: CHAIN, expiry: dropExpiry, auth: dropAuth });
      await mined('drop (relayed by server)', dropTx);
      s = await readAgent(CHAIN, agent);
      check(s.dropped, 'agent is dropped');

      try {
        await api.createRequest({ chain: CHAIN, agent, amount: REFILL.toString(), reason: 'e2e: while dropped' });
        check(false, 'server refuses a request while dropped');
      } catch (err) {
        check(err instanceof ApiError && err.status === 409, 'server refuses a new request while dropped (409)');
      }

      // A perfectly valid owner signature still cannot release while dropped.
      const expiry = BigInt(nowSec() + 900);
      const zero: Hex = `0x${'00'.repeat(32)}`;
      const validAuth = passkey.sign(
        releaseDigest({ chain: CHAIN, vault, agent, amount: REFILL, nonce: s.nonce, expiry, receiptsHash: zero }),
      );
      await expectReleaseRevert('release while dropped (valid signature)', relayer, [agent, REFILL, expiry, zero, validAuth], 'IsDropped');

      const undropExpiry = nowSec() + 900;
      const undropAuth = passkey.sign(undropDigest({ chain: CHAIN, vault, agent, nonce: s.nonce, expiry: undropExpiry }));
      await mined('undrop', await submitUndrop(CHAIN, relayerKey, { agent, expiry: undropExpiry, auth: undropAuth }));
      s = await readAgent(CHAIN, agent);
      check(!s.dropped, `agent is live again, nonce ${s.nonce}`);
    });

    await step('6. Cleanup: return test USDT to the deployer', async () => {
      const s = await readAgent(CHAIN, agent);
      const expiry = BigInt(nowSec() + 900);
      const to = deployer.account.address;
      const auth = passkey.sign(withdrawDigest({ chain: CHAIN, vault, agent, to, amount: s.balance, nonce: s.nonce, expiry }));
      const { request: withdraw } = await pub.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'withdraw',
        args: [agent, to, s.balance, expiry, auth],
        account: relayer.account,
      });
      await mined(`owner-signed withdraw ${usdt(s.balance)}`, await relayer.writeContract(withdraw));
      const held = await walletBalance(CHAIN, agent);
      const back = await agentWallet.writeContract({ address: cfg.token, abi: erc20Abi, functionName: 'transfer', args: [to, held] });
      await mined(`agent returns ${usdt(held)}`, back);
      check((await readAgent(CHAIN, agent)).balance === 0n, 'vault side is empty');
    });
  } catch (err) {
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (server?.log.length) console.error(`\nserver log:\n${server.log.slice(-30).join('\n')}`);
    process.exitCode = 1;
  } finally {
    server?.stop();
  }

  console.log('\n== Summary');
  for (const s of steps) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name}`);
  console.log('\n== Transactions');
  for (const t of txs) console.log(`  [${t.status}] ${t.label}\n    ${txLink(CHAIN, t.hash)}`);
  console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E PASSED');
}

await main();
