import { useEffect, useMemo, useState } from 'react';
import { releaseDigest, requireVault } from '@preflight/capline';
import { api, ApiError, type ServerRequest } from '../api.js';
import { txUrl, addressUrl, CHAIN_META } from '../config.js';
import { countdown, money, short } from '../format.js';
import { passkeyError, signDigest } from '../passkey.js';
import { hashReceipts } from '../receipts.js';
import { getAgents, getPasskey, rememberAgent } from '../storage.js';
import { Header, OfflineBanner, StatusPill, VerdictBadge, useNow, useServer } from '../ui.js';

/** Re-derives what the passkey will sign, so the phone never trusts the server's digest. */
function verify(r: ServerRequest): { digestOk: boolean; receiptsOk: boolean; error?: string } {
  try {
    const digest = releaseDigest({
      chain: r.chain,
      vault: requireVault(r.chain),
      agent: r.agent,
      amount: BigInt(r.amount),
      nonce: r.nonce,
      expiry: r.expiry,
      receiptsHash: r.receipts.receiptsHash,
    });
    let receiptsOk = false;
    try {
      receiptsOk = hashReceipts(r.receipts.receipts) === r.receipts.receiptsHash;
    } catch {
      receiptsOk = false;
    }
    return { digestOk: digest === r.digest, receiptsOk };
  } catch (err) {
    return { digestOk: false, receiptsOk: false, error: (err as Error).message };
  }
}

export function RequestScreen({ id }: { id: string }) {
  const [req, setReq] = useState<ServerRequest>();
  const [loadErr, setLoadErr] = useState<ApiError>();
  const [busy, setBusy] = useState<'approve' | 'decline'>();
  const [actionErr, setActionErr] = useState<string>();
  const now = useNow();
  const { state: server } = useServer();
  const passkey = getPasskey();

  const load = () =>
    api.getRequest(id).then(
      (r) => {
        setReq(r);
        setLoadErr(undefined);
        rememberAgent({ chain: r.chain, agent: r.agent });
      },
      (e: ApiError) => setLoadErr(e),
    );

  useEffect(() => {
    void load();
    // Status can change elsewhere (expiry, a second device), so poll lightly.
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [id]);

  const check = useMemo(() => (req ? verify(req) : undefined), [req]);

  if (!req) {
    return (
      <>
        <Header title="Request" back="#/" />
        <OfflineBanner />
        <main>
          {loadErr ? (
            <div className="card">
              <p className="strong">{loadErr.status === 404 ? 'No such request.' : loadErr.message}</p>
              {loadErr.status === 0 || server === 'offline' ? (
                <>
                  <p className="muted">
                    This request lives on the server. You can still act on an agent straight from the chain.
                  </p>
                  {getAgents().map((a) => (
                    <a key={a.chain + a.agent} className="row-link" href={`#/a/${a.chain}/${a.agent}`}>
                      <span className="mono">{short(a.agent, 6)}</span>
                      <span className="muted">{CHAIN_META[a.chain].name}</span>
                    </a>
                  ))}
                </>
              ) : null}
            </div>
          ) : (
            <div className="card muted">Loading request...</div>
          )}
        </main>
      </>
    );
  }

  const left = req.expiry - now;
  const live = req.status === 'pending' && left > 0;
  const canApprove = live && !!passkey && !!check?.digestOk && !busy;

  const approve = async () => {
    if (!passkey) return;
    setActionErr(undefined);
    setBusy('approve');
    try {
      // signDigest is the first await: Safari needs Face ID to start from the tap.
      const auth = await signDigest(req.digest, passkey.credentialId);
      const { txHash } = await api.approve(req.id, auth);
      setReq({ ...req, status: 'released', txHash });
    } catch (err) {
      setActionErr(err instanceof ApiError ? err.message : passkeyError(err));
      void load();
    } finally {
      setBusy(undefined);
    }
  };

  const decline = async () => {
    setActionErr(undefined);
    setBusy('decline');
    try {
      await api.decline(req.id);
      setReq({ ...req, status: 'declined' });
    } catch (err) {
      setActionErr((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const rc = req.receipts;
  return (
    <>
      <Header title="Refill request" back="#/" />
      <OfflineBanner />
      <main className={live ? 'with-actions' : ''}>
        <section className="card hero">
          <div className="hero-label">Agent asks for</div>
          <div className="amount">{money(req.amount, req.chain)}</div>
          <div className="hero-meta">
            <span className="pill">{CHAIN_META[req.chain].name}</span>
            {req.status === 'pending' ? (
              <span className={`countdown ${left < 120 ? 'urgent' : ''}`}>
                {left > 0 ? `Expires in ${countdown(left)}` : 'Expired'}
              </span>
            ) : (
              <StatusPill status={req.status} />
            )}
          </div>
          <a className="agent-link" href={`#/a/${req.chain}/${req.agent}`}>
            Agent <span className="mono">{short(req.agent, 6)}</span>
          </a>
        </section>

        {req.counterparty ? (
          <section className="card">
            <div className="section-title">Wants to pay</div>
            <div className="cp-row">
              <a className="mono" href={addressUrl(req.chain, req.counterparty.address)} target="_blank" rel="noreferrer">
                {short(req.counterparty.address, 6)}
              </a>
              <VerdictBadge verdict={req.counterparty.verdict} />
            </div>
            {req.counterparty.reasons.length > 0 ? (
              <ul className="reasons">
                {req.counterparty.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <section className="card reason">
          <div className="section-title warn">Unverified: written by the agent</div>
          <p className="reason-text">{req.reason}</p>
          {req.reasonFlags && req.reasonFlags.length > 0 ? (
            <p className="flag">
              This text looks like an instruction aimed at software ({req.reasonFlags.join(', ')}). Read with care.
            </p>
          ) : null}
        </section>

        <section className="card">
          <div className="section-title">Receipts since last refill</div>
          <p className="summary">
            Spent <strong>{money(rc.spent, req.chain)}</strong> in {rc.receipts.length}{' '}
            {rc.receipts.length === 1 ? 'payment' : 'payments'}
            <span className="muted">
              {' '}
              (blocks {rc.fromBlock} to {rc.toBlock}, read from the chain)
            </span>
          </p>
          {rc.receipts.length === 0 ? <p className="muted">No outgoing payments since the last refill.</p> : null}
          <ul className="receipts">
            {rc.receipts.map((x) => (
              <li key={`${x.txHash}-${x.to}-${x.amount}`} className="receipt">
                <div className="receipt-top">
                  <span className="mono">{short(x.to, 4)}</span>
                  <span className="receipt-amt">{money(x.amount, req.chain)}</span>
                </div>
                <div className="receipt-mid">
                  <VerdictBadge verdict={x.verdict} />
                  {x.kind === 'flash_order' ? <span className="pill">Flash order</span> : null}
                  <a href={x.link} target="_blank" rel="noreferrer" className="tx">
                    View tx
                  </a>
                </div>
                {x.reasons.length > 0 ? <div className="receipt-reasons">{x.reasons.join(' / ')}</div> : null}
                {x.meta ? (
                  <div className="receipt-reasons">
                    {Object.entries(x.meta)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' / ')}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="card checks">
          <div className="section-title">Checked on this phone</div>
          <div className={check?.digestOk ? 'ok' : 'bad'}>
            {check?.digestOk
              ? 'Face ID signs exactly this amount, agent and Receipts list.'
              : `Signature target does not match this request. Approve is blocked.${check?.error ? ` ${check.error}` : ''}`}
          </div>
          <div className={check?.receiptsOk ? 'ok' : 'warnline'}>
            {check?.receiptsOk ? 'Receipts hash matches the list above.' : 'Receipts hash could not be re-derived here.'}
          </div>
        </section>

        {req.status === 'released' && req.txHash ? (
          <section className="card done">
            <p className="strong">Released onchain.</p>
            <a href={txUrl(req.chain, req.txHash)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </section>
        ) : null}
        {req.status === 'declined' ? <section className="card muted">Declined. Nothing was released.</section> : null}
        {req.status === 'expired' ? (
          <section className="card muted">Expired. Nothing was released. {req.error ?? ''}</section>
        ) : null}
        {req.error && req.status === 'pending' && !actionErr ? <div className="error">{req.error}</div> : null}
        {actionErr ? <div className="error">{actionErr}</div> : null}
        {!passkey && live ? (
          <div className="card">
            <p>No passkey on this phone yet.</p>
            <a className="btn secondary" href="#/setup">
              Set up passkey
            </a>
          </div>
        ) : null}
      </main>

      {live ? (
        <div className="actions">
          <button className="btn primary" disabled={!canApprove} onClick={approve}>
            {busy === 'approve' ? 'Releasing...' : 'Approve with Face ID'}
          </button>
          <button className="btn secondary" disabled={!!busy} onClick={decline}>
            {busy === 'decline' ? 'Declining...' : 'Decline'}
          </button>
        </div>
      ) : null}
    </>
  );
}
