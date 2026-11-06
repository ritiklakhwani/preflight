// Pocket Approve server. A convenience for the phone: it builds Receipts,
// pushes a notification and relays owner-signed messages. The vault verifies
// every signature itself, so nothing here can move funds on its own.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { isAddress, getAddress, type Hex } from 'viem';
import {
  agentStateToJson,
  authFromJson,
  readAgent,
  requireVault,
  releaseDigest,
  submitDrop,
  submitRelease,
  submitUndrop,
  walletBalance,
  type Verdict,
  type WebAuthnAuth,
  type WebAuthnAuthJson,
} from '@preflight/capline';
import { buildReceipts, scoreCounterparty } from '@preflight/receipts';
import { challengeMatches } from '../../web/src/webauthn.js';
import { readableError } from './errors.js';
import { sanitiseReason } from './reason.js';
import * as store from './store.js';

type ChainKey = 'whitechain' | 'base';
const CHAINS: ChainKey[] = ['whitechain', 'base'];
const EXPIRY_SECONDS = 15 * 60;
const PORT = Number(process.env.APPROVE_PORT ?? 8787);

const now = () => Math.floor(Date.now() / 1000);
const isChain = (c: unknown): c is ChainKey => typeof c === 'string' && (CHAINS as string[]).includes(c);

class HttpError extends Error {
  constructor(public status: 400 | 404 | 409 | 502 | 503, message: string) {
    super(message);
  }
}

function relayerKey(): Hex {
  const key = process.env.RELAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new HttpError(503, 'No relayer key on the server. Use direct mode on the phone.');
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

/** JSON bodies cannot carry bigint, so the indices arrive as strings or numbers. */
function parseAuth(a: unknown): WebAuthnAuth {
  const x = a as Partial<WebAuthnAuthJson> | undefined;
  const hex = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);
  if (!x || !hex(x.r) || !hex(x.s) || !hex(x.authenticatorData) || typeof x.clientDataJSON !== 'string') {
    throw new HttpError(400, 'auth must be { r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON }');
  }
  if (!/^\d+$/.test(String(x.challengeIndex)) || !/^\d+$/.test(String(x.typeIndex))) {
    throw new HttpError(400, 'challengeIndex and typeIndex must be integers');
  }
  return authFromJson({ ...(x as WebAuthnAuthJson), challengeIndex: String(x.challengeIndex), typeIndex: String(x.typeIndex) });
}

function parseAgent(v: unknown): `0x${string}` {
  if (typeof v !== 'string' || !isAddress(v)) throw new HttpError(400, 'agent must be an address');
  return getAddress(v);
}

async function notify(id: string): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log(`[approve] NTFY_TOPIC unset, skipping push for ${id}`);
    return;
  }
  const base = (process.env.APPROVE_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
  try {
    // Only the id leaves the server: no amount, no address in the push.
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: 'Capline', Click: `${base}/#/r/${id}`, Tags: 'lock', Priority: 'high' },
      body: 'Agent requests a refill',
    });
    if (!res.ok) console.warn(`[approve] ntfy answered ${res.status}`);
  } catch (err) {
    console.warn('[approve] ntfy push failed:', readableError(err));
  }
}

const app = new Hono();

// The PWA may be hosted on its own domain (its rpId), so allow any origin.
// Safe: there are no cookies, and every write needs an owner signature.
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('[approve]', err);
  return c.json({ error: readableError(err) }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true, time: now() }));

app.post('/api/requests', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new HttpError(400, 'JSON body required');
  const { chain, amount } = body;
  if (!isChain(chain)) throw new HttpError(400, `chain must be one of ${CHAINS.join(', ')}`);
  const agent = parseAgent(body.agent);
  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) === 0n) {
    throw new HttpError(400, 'amount must be a positive integer string in base units');
  }
  const counterpartyAddr = body.counterparty === undefined || body.counterparty === null || body.counterparty === ''
    ? undefined
    : parseAgent(body.counterparty);

  const state = await readAgent(chain, agent).catch((err: unknown) => {
    throw new HttpError(502, `Could not read the agent from the vault: ${readableError(err)}`);
  });
  if (state.dropped) throw new HttpError(409, 'Agent is dropped. The owner must undrop it first.');
  if (state.balance < BigInt(amount)) throw new HttpError(409, 'The vault does not hold enough for this amount.');

  const [receipts, counterparty] = await Promise.all([
    buildReceipts({ chain, agent }).catch((err: unknown) => {
      throw new HttpError(502, `Could not build Receipts: ${readableError(err)}`);
    }),
    counterpartyAddr
      ? scoreCounterparty(chain, counterpartyAddr)
          .then((s) => ({ address: counterpartyAddr, verdict: s.verdict, reasons: s.reasons }))
          .catch((err: unknown) => ({
            address: counterpartyAddr,
            verdict: 'unknown' as Verdict,
            reasons: [`could not score: ${readableError(err)}`],
          }))
      : Promise.resolve(undefined),
  ]);

  const { reason, flags } = sanitiseReason(body.reason);
  const nonce = Number(state.nonce);
  const expiry = now() + EXPIRY_SECONDS;
  const digest = releaseDigest({
    chain,
    vault: requireVault(chain),
    agent,
    amount: BigInt(amount),
    nonce: BigInt(nonce),
    expiry: BigInt(expiry),
    receiptsHash: receipts.receiptsHash,
  });

  const id = randomBytes(6).toString('hex');
  const request: store.StoredRequest = {
    id,
    chain,
    agent,
    amount,
    reason,
    reasonFlags: flags,
    ...(counterparty ? { counterparty } : {}),
    receipts,
    nonce,
    expiry,
    digest,
    status: 'pending',
    createdAt: now(),
  };
  store.put(request);
  void notify(id);
  return c.json({ id, status: 'pending' as const });
});

app.get('/api/requests', (c) => {
  const agent = c.req.query('agent');
  const chain = c.req.query('chain');
  return c.json(store.list({ ...(agent ? { agent } : {}), ...(chain ? { chain } : {}) }));
});

app.get('/api/requests/:id', (c) => {
  const r = store.get(c.req.param('id'));
  if (!r) throw new HttpError(404, 'No such request');
  return c.json(r);
});

app.post('/api/requests/:id/approve', async (c) => {
  const r = store.get(c.req.param('id'));
  if (!r) throw new HttpError(404, 'No such request');
  if (r.status === 'released') return c.json({ txHash: r.txHash });
  if (r.status !== 'pending') throw new HttpError(409, `Request is ${r.status}`);
  const body = (await c.req.json().catch(() => null)) as { auth?: unknown } | null;
  const auth = parseAuth(body?.auth);
  if (!challengeMatches(auth.clientDataJSON, r.digest)) {
    throw new HttpError(400, 'The passkey signed a different message than this request.');
  }
  const key = relayerKey();

  // Another signed action since creation means this digest can never verify.
  const state = await readAgent(r.chain, r.agent);
  if (Number(state.nonce) !== r.nonce) {
    r.status = 'expired';
    r.error = 'Superseded: the vault nonce moved since this request was made.';
    store.put(r);
    throw new HttpError(409, r.error);
  }

  r.status = 'approved';
  delete r.error;
  store.put(r);
  try {
    const txHash = await submitRelease(r.chain, key, {
      agent: r.agent,
      amount: BigInt(r.amount),
      expiry: BigInt(r.expiry),
      receiptsHash: r.receipts.receiptsHash,
      auth,
    });
    r.status = 'released';
    r.txHash = txHash;
    store.put(r);
    return c.json({ txHash });
  } catch (err) {
    // Back to pending so the owner can retry while the request is still live.
    r.status = now() > r.expiry ? 'expired' : 'pending';
    r.error = readableError(err);
    store.put(r);
    throw new HttpError(502, r.error);
  }
});

app.post('/api/requests/:id/decline', (c) => {
  const r = store.get(c.req.param('id'));
  if (!r) throw new HttpError(404, 'No such request');
  if (r.status !== 'pending') throw new HttpError(409, `Request is ${r.status}`);
  r.status = 'declined';
  store.put(r);
  return c.json({ status: 'declined' as const });
});

async function relayFlag(kind: 'drop' | 'undrop', agentParam: string, body: Record<string, unknown> | null) {
  const agent = parseAgent(agentParam);
  if (!isChain(body?.chain)) throw new HttpError(400, `chain must be one of ${CHAINS.join(', ')}`);
  const expiry = Number(body?.expiry);
  if (!Number.isInteger(expiry) || expiry <= now()) throw new HttpError(400, 'expiry must be a future unix time');
  const auth = parseAuth(body?.auth);
  const key = relayerKey();
  const submit = kind === 'drop' ? submitDrop : submitUndrop;
  try {
    return await submit(body.chain, key, { agent, expiry: BigInt(expiry), auth });
  } catch (err) {
    throw new HttpError(502, readableError(err));
  }
}

app.post('/api/agents/:agent/drop', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json({ txHash: await relayFlag('drop', c.req.param('agent'), body) });
});

app.post('/api/agents/:agent/undrop', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json({ txHash: await relayFlag('undrop', c.req.param('agent'), body) });
});

app.get('/api/agents/:agent', async (c) => {
  const agent = parseAgent(c.req.param('agent'));
  const chain = c.req.query('chain');
  if (!isChain(chain)) throw new HttpError(400, `chain must be one of ${CHAINS.join(', ')}`);
  try {
    const [state, wallet] = await Promise.all([readAgent(chain, agent), walletBalance(chain, agent)]);
    return c.json(agentStateToJson(chain, agent, state, wallet));
  } catch (err) {
    throw new HttpError(502, readableError(err));
  }
});

// Serve the built PWA when present, so one process can host both.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: relative(process.cwd(), webDist) }));
}

store.load();
setInterval(store.expireAll, 30_000).unref();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[approve] listening on http://localhost:${info.port}${existsSync(webDist) ? ' (serving PWA)' : ''}`);
});
