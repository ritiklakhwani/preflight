import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { readAgent, requireVault, type Receipt, type Verdict } from '@preflight/capline';
import { api, ApiError, type ServerRequest } from '../api.js';
import { txUrl, addressLabel, CHAIN_META } from '../config.js';
import { ago, countdown, money, short } from '../format.js';
import { passkeyError, recoverPasskey, signDigest } from '../passkey.js';
import { getAgents, getPasskey, rememberAgent } from '../storage.js';
import { Addr, Header, Icon, OfflineBanner, Section, StatusPill, VerdictBadge, isWallet, useNow, useServer } from '../ui.js';
import { checkRequest, type ChainView } from '../verify.js';

/** Re-derives what the passkey will sign, so the phone never trusts the server's digest. */
function verify(r: ServerRequest, chain: ChainView | undefined, now: number) {
  try {
    return checkRequest(r, { vault: requireVault(r.chain), now, chain });
  } catch (err) {
    return { ok: false, receiptsOk: false, nonceOnChain: false, problems: [(err as Error).message], warnings: [] } as ReturnType<
      typeof checkRequest
    >;
  }
}

export function RequestScreen({ id }: { id: string }) {
  const [req, setReq] = useState<ServerRequest>();
  const [loadErr, setLoadErr] = useState<ApiError>();
  const [busy, setBusy] = useState<'approve' | 'decline' | 'recover'>();
  const [actionErr, setActionErr] = useState<string>();
  // Read straight from the chain, not the server: the nonce goes into the digest.
  const [chainView, setChainView] = useState<ChainView>();
  // The owner key the vault holds for this agent, to catch a wrong passkey before Face ID.
  const [ownerKey, setOwnerKey] = useState<{ qx: string; qy: string }>();
  const now = useNow();
  const { state: server } = useServer();
  const [passkey, setPasskeyState] = useState(getPasskey);

  const load = () =>
    api.getRequest(id).then(
      (r) => {
        setReq(r);
        setLoadErr(undefined);
        rememberAgent({ chain: r.chain, agent: r.agent });
        if (r.status === 'pending') {
          readAgent(r.chain, r.agent).then(
            (s) => {
              setChainView({ nonce: s.nonce, dropped: s.dropped, balance: s.balance, lastReleaseBlock: s.lastReleaseBlock });
              setOwnerKey({ qx: s.qx, qy: s.qy });
            },
            () => {}, // keep the last good read; with none, the screen says the nonce is unconfirmed
          );
        }
      },
      (e: ApiError) => setLoadErr(e),
    );

  useEffect(() => {
    void load();
    // Status can change elsewhere (expiry, a second device), so poll lightly.
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [id]);

  // Expiry is checked against the clock, so re-check as time passes.
  const check = useMemo(() => (req ? verify(req, chainView, now) : undefined), [req, chainView, now]);

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
                  <div className="list">
                    {getAgents().map((a) => (
                      <a key={a.chain + a.agent} className="row-link" href={`#/a/${a.chain}/${a.agent}`}>
                        <span className="addr-mono">{short(a.agent, 6)}</span>
                        <span className="muted small">{CHAIN_META[a.chain].name}</span>
                      </a>
                    ))}
                  </div>
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
  const wrongKey =
    !!passkey &&
    !!ownerKey &&
    (ownerKey.qx.toLowerCase() !== passkey.qx.toLowerCase() || ownerKey.qy.toLowerCase() !== passkey.qy.toLowerCase());
  const canApprove = live && !!passkey && !wrongKey && !!check?.ok && !!check.digest && !busy;

  const approve = async () => {
    if (!passkey || !check?.ok || !check.digest) return;
    const digest = check.digest;
    setActionErr(undefined);
    setBusy('approve');
    try {
      // signDigest is the first await: Safari needs Face ID to start from the tap.
      const auth = await signDigest(digest, passkey);
      const { txHash } = await api.approve(req.id, auth);
      setReq({ ...req, status: 'released', txHash });
    } catch (err) {
      setActionErr(err instanceof ApiError ? err.message : passkeyError(err));
      void load();
    } finally {
      setBusy(undefined);
    }
  };

  const recover = async () => {
    if (!ownerKey) return;
    setActionErr(undefined);
    setBusy('recover');
    try {
      // recoverPasskey is the first await: Safari needs Face ID to start from the tap.
      setPasskeyState(await recoverPasskey({ qx: ownerKey.qx as `0x${string}`, qy: ownerKey.qy as `0x${string}` }));
    } catch (err) {
      setActionErr(passkeyError(err));
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
  const cp = req.counterparty;
  const cpWallet = !!cp && cp.verdict === 'unknown' && isWallet(cp.reasons);
  const groups = groupByCounterparty(rc.receipts);
  const count = rc.receipts.length;
  return (
    <>
      <Header title="Refill request" back="#/" />
      <OfflineBanner />
      <main className={live ? 'with-actions' : ''}>
        <section className="card hero">
          <div className="hero-top">
            <span className="eyebrow">Agent asks for</span>
            {req.status === 'pending' ? (
              <span className={`pill countdown ${left > 0 && left < 120 ? 'urgent' : ''}`}>
                {left > 0 ? `Expires in ${countdown(left)}` : 'Expired'}
              </span>
            ) : (
              <StatusPill status={req.status} />
            )}
          </div>
          <div className="amount">
            {money(req.amount, req.chain, false)} <span className="amount-unit">{CHAIN_META[req.chain].symbol}</span>
          </div>
          <div className="hero-foot">
            <span className="pill">{CHAIN_META[req.chain].name}</span>
            <a className="agent-link" href={`#/a/${req.chain}/${req.agent}`}>
              <span className="muted">Agent</span> <span className="addr-mono">{short(req.agent, 6)}</span>
              <Icon name="chevron" size={14} />
            </a>
          </div>
        </section>

        {req.status === 'released' && req.txHash ? (
          <section className="card outcome done">
            <div className="outcome-title">
              <span className="tick">
                <Icon name="check" size={14} />
              </span>
              Released onchain
            </div>
            <a className="tx-link" href={txUrl(req.chain, req.txHash)} target="_blank" rel="noreferrer">
              View transaction <Icon name="external" size={14} />
            </a>
          </section>
        ) : null}
        {req.status === 'declined' ? (
          <section className="card outcome">
            <div className="outcome-title">Declined</div>
            <p className="muted small">Nothing was released.</p>
          </section>
        ) : null}
        {req.status === 'expired' ? (
          <section className="card outcome">
            <div className="outcome-title">Expired</div>
            <p className="muted small">Nothing was released. {req.error ?? ''}</p>
          </section>
        ) : null}

        {cp ? (
          <Section label="Next payment">
            <div className={`card cp cp-${cpWallet ? 'wallet' : cp.verdict}`}>
              {cp.verdict === 'high' ? (
                <div className="risk-note risk-high">
                  <Icon name="alert" size={16} />
                  Preflight flags this contract as high risk.
                </div>
              ) : cp.verdict === 'medium' ? (
                <div className="risk-note risk-medium">
                  <Icon name="alert" size={16} />
                  Preflight found some risk. Read the reasons below.
                </div>
              ) : null}
              <div className="cp-body">
                <div className="row-between">
                  <div className="stack">
                    <span className="muted small">Wants to pay</span>
                    <Addr chain={req.chain} address={cp.address} n={6} link />
                    {!addressLabel(req.chain, cp.address) ? (
                      <span className="faint small">{cpWallet ? 'Plain wallet' : 'Not a known address'}</span>
                    ) : null}
                  </div>
                  <VerdictBadge verdict={cp.verdict} reasons={cp.reasons} />
                </div>
                {cpWallet ? (
                  <p className="muted small">Plain wallet, no contract to score.</p>
                ) : cp.reasons.length > 0 ? (
                  <ul className="reasons">
                    {cp.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </Section>
        ) : null}

        <Section label="Agent's reason">
          <div className="card note">
            <div className="note-tag">Unverified, written by the agent</div>
            <p className="reason-text">{req.reason}</p>
            {req.reasonFlags && req.reasonFlags.length > 0 ? (
              <p className="flag">
                <Icon name="alert" size={14} />
                <span>
                  This text looks like an instruction aimed at software ({req.reasonFlags.join(', ')}). Read with care.
                </span>
              </p>
            ) : null}
          </div>
        </Section>

        <Section label="Onchain history since last refill">
          <div className="card flush">
            <div className="summary">
              <span className="summary-amt">{money(check?.spent ?? rc.spent, req.chain)}</span>
              <span className="muted small">
                spent in {count} {count === 1 ? 'payment' : 'payments'}
                {groups.length > 0 ? ` to ${groups.length} ${groups.length === 1 ? 'recipient' : 'recipients'}` : ''}
              </span>
            </div>
            {groups.length === 0 ? (
              <p className="empty">No outgoing payments since the last refill.</p>
            ) : (
              <ul className="groups">
                {groups.map((g) => (
                  <li key={g.to.toLowerCase()}>
                    <details className="group">
                      <summary className="group-row">
                        <span className="group-main">
                          <Addr chain={req.chain} address={g.to} />
                          <span className="faint small">
                            {g.receipts.length} {g.receipts.length === 1 ? 'payment' : 'payments'}
                          </span>
                        </span>
                        <span className="group-side">
                          <span className="amt">{money(g.total, req.chain)}</span>
                          <VerdictBadge verdict={g.verdict} reasons={g.reasons} />
                        </span>
                        <span className="chev">
                          <Icon name="chevron" size={14} />
                        </span>
                      </summary>
                      <ul className="payments">
                        {g.receipts.map((x) => (
                          <li key={`${x.txHash}-${x.to}-${x.amount}`} className="payment">
                            <div className="payment-row">
                              <span className="amt">{money(x.amount, req.chain)}</span>
                              <span className="faint small">{x.timestamp ? ago(x.timestamp) : `Block ${x.blockNumber}`}</span>
                              {x.kind === 'flash_order' ? <span className="pill">Flash order</span> : null}
                              <a
                                href={txUrl(req.chain, encodeURIComponent(x.txHash))}
                                target="_blank"
                                rel="noreferrer"
                                className="tx-link push"
                              >
                                View tx <Icon name="external" size={13} />
                              </a>
                            </div>
                            {x.meta ? (
                              <div className="faint small wrap-any">
                                {Object.entries(x.meta)
                                  .map(([k, v]) => `${k}: ${v}`)
                                  .join(' / ')}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            <details className="source">
              <summary>Source</summary>
              <p>
                Blocks {rc.fromBlock} to {rc.toBlock}, read from the chain. Receipts hash{' '}
                <span className="addr-mono">{short(rc.receiptsHash, 6)}</span>.
              </p>
            </details>
          </div>
        </Section>

        <Section label="Preflight checks">
          <div className="card list">
            {groups.length === 0 ? <p className="empty">Nothing to check yet.</p> : null}
            {groups.map((g) => {
              const wallet = g.verdict === 'unknown' && isWallet(g.reasons);
              return (
                <div key={g.to.toLowerCase()} className="list-row">
                  <div className="row-between">
                    <Addr chain={req.chain} address={g.to} />
                    <VerdictBadge verdict={g.verdict} reasons={g.reasons} />
                  </div>
                  <p className="muted small wrap-any">
                    {wallet ? 'Plain wallet, no contract to score' : g.reasons.length > 0 ? g.reasons.join(' / ') : 'No details given'}
                  </p>
                </div>
              );
            })}
          </div>
        </Section>

        <Section label="Verified on this phone">
          <div className="card list checks">
            <CheckLine state={check?.ok ? 'ok' : 'bad'}>
              {check?.ok
                ? 'Face ID signs exactly this amount, agent and history.'
                : `Signature target does not match this request. Approve is blocked. ${check?.problems.join(' ') ?? ''}`}
            </CheckLine>
            <CheckLine state={check?.receiptsOk ? 'ok' : 'warn'}>
              {check?.receiptsOk ? 'Receipts hash matches the history above.' : 'Receipts hash does not match the history above.'}
            </CheckLine>
            {check?.nonceOnChain ? <CheckLine state="ok">Nonce {req.nonce} matches the vault onchain.</CheckLine> : null}
            {check?.warnings.map((w) => (
              <CheckLine key={w} state="warn">
                {w}
              </CheckLine>
            ))}
          </div>
        </Section>

        {req.error && req.status === 'pending' && !actionErr ? <div className="error">{req.error}</div> : null}
        {actionErr ? <div className="error">{actionErr}</div> : null}
        {wrongKey && live ? (
          <div className="error">
            The passkey on this phone (qx {short(passkey!.qx, 6)}) is not the one this agent was registered with (qx{' '}
            {short(ownerKey!.qx, 6)}). Approving would fail onchain.
            <button className="btn secondary" disabled={!!busy} onClick={recover} style={{ marginTop: 12 }}>
              {busy === 'recover' ? 'Waiting for Face ID...' : 'Use my other passkey'}
            </button>
          </div>
        ) : null}
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
          <div className="actions-inner">
            <button className="btn primary" disabled={!canApprove} onClick={approve}>
              {busy === 'approve' ? 'Releasing...' : 'Approve with Face ID'}
            </button>
            <button className="btn secondary" disabled={!!busy} onClick={decline}>
              {busy === 'decline' ? 'Declining...' : 'Decline'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CheckLine({ state, children }: { state: 'ok' | 'bad' | 'warn'; children: ReactNode }) {
  return (
    <div className={`check-line c-${state}`}>
      <span className="check-icon">
        <Icon name={state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'alert'} size={12} />
      </span>
      <span>{children}</span>
    </div>
  );
}

interface Group {
  to: string;
  receipts: Receipt[];
  total: bigint;
  verdict: Verdict;
  reasons: string[];
}

const RANK: Record<Verdict, number> = { high: 4, medium: 3, unknown: 2, low: 1, clean: 0 };
const risk = (v: Verdict, reasons: string[]) => (v === 'unknown' && isWallet(reasons) ? 0.5 : RANK[v] ?? 2);

/** Display grouping only: one row per counterparty, riskiest first. The receipts list itself is untouched. */
function groupByCounterparty(rs: Receipt[]): Group[] {
  const m = new Map<string, Group>();
  for (const r of rs) {
    const k = r.to.toLowerCase();
    let g = m.get(k);
    if (!g) {
      g = { to: r.to, receipts: [], total: 0n, verdict: r.verdict, reasons: r.reasons };
      m.set(k, g);
    }
    g.receipts.push(r);
    try {
      g.total += BigInt(r.amount);
    } catch {
      // Malformed amount: the phone-side check already flags the list.
    }
    if (risk(r.verdict, r.reasons) > risk(g.verdict, g.reasons)) {
      g.verdict = r.verdict;
      g.reasons = r.reasons;
    }
  }
  return [...m.values()].sort(
    (a, b) => risk(b.verdict, b.reasons) - risk(a.verdict, a.reasons) || (b.total > a.total ? 1 : b.total < a.total ? -1 : 0),
  );
}
