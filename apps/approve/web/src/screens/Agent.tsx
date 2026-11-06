import { useCallback, useEffect, useState } from 'react';
import {
  authToJson,
  dropDigest,
  parseAmount,
  publicClient,
  readAgent,
  releaseDigest,
  requireVault,
  submitDrop,
  submitRelease,
  submitUndrop,
  undropDigest,
  walletBalance,
  type ReceiptsReport,
  type WebAuthnAuth,
} from '@preflight/capline';
import { formatEther, isAddress } from 'viem';
import { readableError } from '../../../server/src/errors.js';
import { api, ApiError, type ServerRequest } from '../api.js';
import { CHAIN_META, addressUrl, txUrl, type ChainKey } from '../config.js';
import { ago, money, short } from '../format.js';
import { passkeyError, signDigest } from '../passkey.js';
import { ZERO_HASH, rawReceipts } from '../receipts.js';
import { getBurner, getPasskey, rememberAgent, resetBurner } from '../storage.js';
import { Copy, Field, Header, OfflineBanner, StatusPill, useServer } from '../ui.js';
import type { Hex } from '../webauthn.js';

interface View {
  balance: bigint;
  wallet: bigint;
  nonce: bigint;
  dropped: boolean;
  lastReleaseBlock: bigint;
  qx: Hex;
  source: 'chain' | 'server';
}

type Signed =
  | { kind: 'release'; amount: bigint; expiry: number; receiptsHash: Hex; auth: WebAuthnAuth }
  | { kind: 'drop' | 'undrop'; expiry: number; auth: WebAuthnAuth };

const SIGN_WINDOW = 10 * 60; // owner-signed actions expire 10 min after signing

async function readFromChain(chain: ChainKey, agent: `0x${string}`): Promise<View> {
  const [s, wallet] = await Promise.all([readAgent(chain, agent), walletBalance(chain, agent)]);
  return { ...s, wallet, source: 'chain' };
}

export function AgentScreen({ chain, agent }: { chain: ChainKey; agent: `0x${string}` }) {
  const { state: server } = useServer();
  const [view, setView] = useState<View>();
  const [loadErr, setLoadErr] = useState<string>();
  const [requests, setRequests] = useState<ServerRequest[]>([]);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [tx, setTx] = useState<Hex>();
  const [signed, setSigned] = useState<Signed>();
  const [directOpen, setDirectOpen] = useState(false);
  const passkey = getPasskey();
  const meta = CHAIN_META[chain];

  const load = useCallback(async () => {
    try {
      // The chain is the source of truth, and drop/undrop sign over its nonce:
      // a server that lies about the nonce must not decide what Face ID signs.
      const fromChain = await readFromChain(chain, agent).catch(() => undefined);
      if (fromChain) {
        setView(fromChain);
        setLoadErr(undefined);
        if (server === 'online') {
          api.listRequests(agent).then((l) => setRequests(l.filter((r) => r.chain === chain)), () => {});
        }
        return;
      }
      if (server === 'online') {
        try {
          const s = await api.agentState(chain, agent);
          setView({
            balance: BigInt(s.balance),
            wallet: BigInt(s.walletBalance),
            nonce: BigInt(s.nonce),
            dropped: s.dropped,
            lastReleaseBlock: BigInt(s.lastReleaseBlock),
            qx: s.qx,
            source: 'server',
          });
          setLoadErr(undefined);
          api.listRequests(agent).then((l) => setRequests(l.filter((r) => r.chain === chain)), () => {});
          return;
        } catch {
          // Fall through to the chain: it is the source of truth anyway.
        }
      }
      setView(await readFromChain(chain, agent));
      setLoadErr(undefined);
    } catch (e) {
      setLoadErr(readableError(e));
    }
  }, [chain, agent, server]);

  useEffect(() => {
    rememberAgent({ chain, agent });
    if (server !== 'checking') void load();
  }, [load, server]);

  useEffect(() => {
    if (server === 'offline') setDirectOpen(true);
  }, [server]);

  const flag = async (kind: 'drop' | 'undrop') => {
    if (!passkey || !view) return;
    setErr(undefined);
    setTx(undefined);
    setSigned(undefined);
    setBusy(kind);
    try {
      const expiry = Math.floor(Date.now() / 1000) + SIGN_WINDOW;
      const make = kind === 'drop' ? dropDigest : undropDigest;
      const digest = make({ chain, vault: requireVault(chain), agent, nonce: view.nonce, expiry });
      const auth = await signDigest(digest, passkey.credentialId);
      if (server === 'online') {
        try {
          const { txHash } = await api.setDropped(kind, chain, agent, expiry, auth);
          setTx(txHash);
          void load();
          return;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          // The kill switch must not depend on the server: keep the signature either way.
          if (e.status !== 0) setErr(`The server did not send it (${e.message}). You can send it from this phone below.`);
        }
      }
      // No server, or it failed: keep the signature and let the owner send it from here.
      setSigned({ kind, expiry, auth });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : passkeyError(e));
      // A release may have moved the nonce under us; re-read so the next tap signs the current one.
      void load();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <Header title="Agent" back="#/" />
      <OfflineBanner />
      <main>
        <section className="card">
          <div className="cp-row">
            <a className="mono big" href={addressUrl(chain, agent)} target="_blank" rel="noreferrer">
              {short(agent, 6)}
            </a>
            {view ? (
              <span className={`pill ${view.dropped ? 's-dropped' : 's-active'}`}>{view.dropped ? 'Dropped' : 'Active'}</span>
            ) : null}
          </div>
          <div className="muted small">{meta.name}</div>
          {loadErr ? <div className="error">{loadErr}</div> : null}
          {!view && !loadErr ? <p className="muted">Reading the vault...</p> : null}
          {view ? (
            <>
              <div className="stats">
                <Field label="In the vault">{money(view.balance, chain)}</Field>
                <Field label="Tranche left in wallet">{money(view.wallet, chain)}</Field>
                <Field label="Nonce">{view.nonce.toString()}</Field>
                <Field label="Last refill block">{view.lastReleaseBlock.toString()}</Field>
              </div>
              <div className="muted small">Read from {view.source === 'chain' ? 'the chain directly' : 'the server'}.</div>
              {passkey && view.qx.toLowerCase() !== passkey.qx.toLowerCase() ? (
                <div className="warnline">This agent was registered with a different passkey than the one on this phone.</div>
              ) : null}
            </>
          ) : null}
        </section>

        {view && passkey ? (
          view.dropped ? (
            <button className="btn secondary" disabled={!!busy} onClick={() => flag('undrop')}>
              {busy === 'undrop' ? 'Signing...' : 'Undrop agent'}
            </button>
          ) : (
            <button className="btn danger" disabled={!!busy} onClick={() => flag('drop')}>
              {busy === 'drop' ? 'Signing...' : 'Drop agent'}
            </button>
          )
        ) : null}
        {view && !view.dropped ? <p className="muted small center">Drop freezes all refills until you undrop.</p> : null}
        {!passkey ? (
          <a className="btn secondary" href="#/setup">
            Set up passkey
          </a>
        ) : null}
        {tx ? (
          <div className="card done">
            <p className="strong">Sent onchain.</p>
            <a href={txUrl(chain, tx)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </div>
        ) : null}
        {err ? <div className="error">{err}</div> : null}

        {signed && signed.kind !== 'release' ? (
          <SignedPanel chain={chain} agent={agent} signed={signed} onSent={() => void load()} />
        ) : null}

        {requests.length > 0 ? (
          <section className="card">
            <div className="section-title">Requests</div>
            {requests.map((r) => (
              <a key={r.id} className="row-link" href={`#/r/${r.id}`}>
                <span>
                  <strong>{money(r.amount, chain)}</strong> <span className="muted small">{ago(r.createdAt)}</span>
                </span>
                <StatusPill status={r.status} />
              </a>
            ))}
          </section>
        ) : null}

        {view && passkey ? (
          <section className="card">
            <button className="disclosure" onClick={() => setDirectOpen(!directOpen)} aria-expanded={directOpen}>
              <span className="section-title">Release directly</span>
              <span className="muted">{directOpen ? 'Hide' : 'Show'}</span>
            </button>
            {directOpen ? <DirectRelease chain={chain} agent={agent} view={view} onSent={() => void load()} /> : null}
          </section>
        ) : null}
      </main>
    </>
  );
}

/** Backend-off path: Receipts from raw logs, digest built here, passkey signs, burner sends. */
function DirectRelease({
  chain,
  agent,
  view,
  onSent,
}: {
  chain: ChainKey;
  agent: `0x${string}`;
  view: View;
  onSent: () => void;
}) {
  const passkey = getPasskey()!;
  const [amount, setAmount] = useState('');
  const [report, setReport] = useState<ReceiptsReport>();
  const [reportErr, setReportErr] = useState<string>();
  const [signed, setSigned] = useState<Signed>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rawReceipts(chain, agent, view.lastReleaseBlock).then(setReport, (e) => setReportErr(readableError(e)));
  }, [chain, agent, view.lastReleaseBlock]);

  const receiptsHash = report?.receiptsHash ?? ZERO_HASH;
  let units: bigint | undefined;
  let amountErr: string | undefined;
  try {
    units = amount ? parseAmount(chain, amount) : undefined;
    if (units !== undefined && units > view.balance) amountErr = 'More than the vault holds.';
    if (units === 0n) amountErr = 'Enter more than zero.';
  } catch (e) {
    amountErr = (e as Error).message;
  }

  const sign = async () => {
    if (units === undefined || amountErr) return;
    setErr(undefined);
    setSigned(undefined);
    setBusy(true);
    try {
      const expiry = Math.floor(Date.now() / 1000) + SIGN_WINDOW;
      const digest = releaseDigest({
        chain,
        vault: requireVault(chain),
        agent,
        amount: units,
        nonce: view.nonce,
        expiry,
        receiptsHash,
      });
      const auth = await signDigest(digest, passkey.credentialId);
      setSigned({ kind: 'release', amount: units, expiry, receiptsHash, auth });
    } catch (e) {
      setErr(passkeyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="direct">
      <p className="muted small">
        No server needed. The phone reads the vault, builds the message, signs it with your passkey and sends it itself.
      </p>
      <div className="sub-title">Receipts (raw transfer logs, not risk-scored)</div>
      {reportErr ? <div className="warnline">Could not read transfer logs: {reportErr}</div> : null}
      {!report && !reportErr ? <p className="muted small">Reading transfer logs...</p> : null}
      {report ? (
        <>
          <p className="summary">
            Spent <strong>{money(report.spent, chain)}</strong> in {report.receipts.length} transfers since block{' '}
            {report.fromBlock}
          </p>
          <ul className="receipts compact">
            {report.receipts.slice(0, 10).map((x) => (
              <li key={`${x.txHash}-${x.to}-${x.amount}`} className="receipt">
                <div className="receipt-top">
                  <span className="mono">{short(x.to, 4)}</span>
                  <span className="receipt-amt">{money(x.amount, chain)}</span>
                </div>
                <a href={x.link} target="_blank" rel="noreferrer" className="tx">
                  View tx
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Field label={report ? 'Receipts hash (raw transfer list)' : 'Receipts hash (zero: no list available)'}>
        <span className="mono wrap">{receiptsHash}</span>
      </Field>

      <label className="input-label" htmlFor="amt">
        Amount ({CHAIN_META[chain].symbol})
      </label>
      <input
        id="amt"
        className="input"
        inputMode="decimal"
        autoComplete="off"
        placeholder="5"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
      />
      {amountErr ? <div className="warnline">{amountErr}</div> : null}
      <button className="btn primary" disabled={units === undefined || !!amountErr || busy || view.dropped} onClick={sign}>
        {busy ? 'Signing...' : 'Sign release with Face ID'}
      </button>
      {view.dropped ? <p className="muted small">Agent is dropped. Undrop it first.</p> : null}
      {err ? <div className="error">{err}</div> : null}
      {signed ? <SignedPanel chain={chain} agent={agent} signed={signed} onSent={onSent} /> : null}
    </div>
  );
}

/** A signed owner message: send it from the local burner, or hand the JSON to anyone. */
function SignedPanel({
  chain,
  agent,
  signed,
  onSent,
}: {
  chain: ChainKey;
  agent: `0x${string}`;
  signed: Signed;
  onSent: () => void;
}) {
  const [burner, setBurner] = useState(getBurner);
  const [gas, setGas] = useState<bigint>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [tx, setTx] = useState<Hex>();

  const refreshGas = useCallback(() => {
    publicClient(chain)
      .getBalance({ address: burner.address })
      .then(setGas, () => setGas(undefined));
  }, [chain, burner.address]);
  useEffect(refreshGas, [refreshGas]);

  let vault = '';
  try {
    vault = requireVault(chain);
  } catch {
    // Shown as empty; the send below will surface the real error.
  }
  const payload = {
    chain,
    chainId: CHAIN_META[chain].id,
    vault,
    function: signed.kind,
    agent,
    ...(signed.kind === 'release' ? { amount: signed.amount.toString(), receiptsHash: signed.receiptsHash } : {}),
    expiry: signed.expiry,
    auth: authToJson(signed.auth),
  };
  const json = JSON.stringify(payload, null, 2);

  const send = async () => {
    setErr(undefined);
    setBusy(true);
    try {
      const base = { agent, expiry: BigInt(signed.expiry), auth: signed.auth };
      const hash =
        signed.kind === 'release'
          ? await submitRelease(chain, burner.key, { ...base, amount: signed.amount, receiptsHash: signed.receiptsHash })
          : signed.kind === 'drop'
            ? await submitDrop(chain, burner.key, base)
            : await submitUndrop(chain, burner.key, base);
      setTx(hash);
      onSent();
    } catch (e) {
      setErr(readableError(e));
      refreshGas();
    } finally {
      setBusy(false);
    }
  };

  const expired = Math.floor(Date.now() / 1000) > signed.expiry;
  return (
    <div className="card signed">
      <div className="section-title">Signed {signed.kind}</div>
      <p className="muted small">Valid for 10 minutes. Anyone can send it; nobody can change it.</p>
      <Field label="Gas wallet on this phone">
        <span className="mono">{short(burner.address, 6)}</span> <Copy text={burner.address} />
      </Field>
      <div className="muted small">
        Balance: {gas === undefined ? '...' : `${formatEther(gas)} ${CHAIN_META[chain].nativeSymbol}`}. It only pays gas;
        funds go from the vault to the agent.{' '}
        <button className="link" onClick={refreshGas}>
          Refresh
        </button>{' '}
        <button
          className="link"
          onClick={() => {
            resetBurner();
            setBurner(getBurner());
          }}
        >
          New wallet
        </button>
      </div>
      {tx ? (
        <div className="done">
          <p className="strong">Sent onchain.</p>
          <a href={txUrl(chain, tx)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </div>
      ) : (
        <button className="btn primary" disabled={busy || expired || gas === 0n} onClick={send}>
          {busy ? 'Sending...' : gas === 0n ? 'Fund the gas wallet to send' : 'Send from this phone'}
        </button>
      )}
      {err ? <div className="error">{err}</div> : null}
      <div className="sub-title">Or give this to anyone to relay</div>
      <pre className="payload">{json}</pre>
      <Copy text={json} label="Copy signed payload" />
    </div>
  );
}

export function isAgentRoute(chain: string | undefined, agent: string | undefined): boolean {
  return (chain === 'whitechain' || chain === 'base') && !!agent && isAddress(agent);
}
