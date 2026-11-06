import { useState } from 'react';
import { isAddress } from 'viem';
import { CHAIN_META, CHAIN_KEYS, type ChainKey } from '../config.js';
import { createPasskey, passkeyError, passkeySupported } from '../passkey.js';
import { getPasskey, rememberAgent, setPasskey, type StoredPasskey } from '../storage.js';
import { Copy, Header, OfflineBanner, Section, go } from '../ui.js';

export function SetupScreen() {
  const [pk, setPk] = useState<StoredPasskey | undefined>(getPasskey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [chain, setChain] = useState<ChainKey>('whitechain');
  const [agent, setAgent] = useState('');
  const [amount, setAmount] = useState('10');

  const create = async () => {
    if (pk && !confirm('Replace the passkey on this phone? Agents registered with the old one stay tied to it.')) return;
    setErr(undefined);
    setBusy(true);
    try {
      setPk(await createPasskey());
    } catch (e) {
      setErr(passkeyError(e));
    } finally {
      setBusy(false);
    }
  };

  const agentOk = isAddress(agent);
  const cmd = pk
    ? `pnpm --filter @preflight/approve register ${chain} ${agentOk ? agent : '<agent>'} ${pk.qx} ${pk.qy} ${amount || '<amount>'}`
    : '';

  return (
    <>
      <Header title="Passkey" back="#/" />
      <OfflineBanner />
      <main>
        {!passkeySupported() ? <div className="error">This browser has no passkey support.</div> : null}
        {!pk ? (
          <>
            <section className="intro">
              <h2 className="title">Your passkey is your key.</h2>
              <p className="muted">You own the vault. This phone holds the only key that can release more money to your agent.</p>
            </section>
            <section className="card list">
              <div className="list-row">
                <span className="strong">Made on this phone</span>
                <span className="muted small">Created in the secure chip and unlocked with Face ID.</span>
              </div>
              <div className="list-row">
                <span className="strong">Checked onchain</span>
                <span className="muted small">The vault verifies the passkey signature itself.</span>
              </div>
              <div className="list-row">
                <span className="strong">Nothing to write down</span>
                <span className="muted small">No seed phrase, no owner wallet.</span>
              </div>
            </section>
            <button className="btn primary" disabled={busy} onClick={create}>
              {busy ? 'Waiting for Face ID...' : 'Create passkey'}
            </button>
          </>
        ) : (
          <>
            <Section label="Your public key">
              <div className="card list">
                <div className="list-row">
                  <div className="row-between">
                    <span className="field-label">qx</span>
                    <Copy text={pk.qx} />
                  </div>
                  <span className="mono wrap">{pk.qx}</span>
                </div>
                <div className="list-row">
                  <div className="row-between">
                    <span className="field-label">qy</span>
                    <Copy text={pk.qy} />
                  </div>
                  <span className="mono wrap">{pk.qy}</span>
                </div>
                <p className="muted small">
                  Made for {pk.rpId}. Public data only; the private key never leaves the secure chip.
                </p>
              </div>
            </Section>

            <Section label="Register an agent">
              <div className="card form">
                <label className="input-label">Chain</label>
                <div className="seg">
                  {CHAIN_KEYS.map((c) => (
                    <button key={c} className={c === chain ? 'on' : ''} onClick={() => setChain(c)}>
                      {CHAIN_META[c].name}
                    </button>
                  ))}
                </div>
                <label className="input-label" htmlFor="agent">
                  Agent wallet address
                </label>
                <input
                  id="agent"
                  className="input mono"
                  placeholder="0x..."
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={agent}
                  onChange={(e) => setAgent(e.target.value.trim())}
                />
                <label className="input-label" htmlFor="fund">
                  Fund the vault with ({CHAIN_META[chain].symbol})
                </label>
                <input
                  id="fund"
                  className="input"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.trim())}
                />
                <div className="row-between">
                  <span className="input-label">Run on the deployer machine</span>
                  <Copy text={cmd} label="Copy command" />
                </div>
                <pre className="payload">{cmd}</pre>
                <button
                  className="btn secondary"
                  disabled={!agentOk}
                  onClick={() => {
                    rememberAgent({ chain, agent: agent as `0x${string}` });
                    go(`/a/${chain}/${agent}`);
                  }}
                >
                  Open agent
                </button>
              </div>
            </Section>

            <div className="quiet-actions">
              <button className="btn ghost" disabled={busy} onClick={create}>
                Create a new passkey
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  if (confirm('Forget this passkey on this phone? The passkey itself stays in your keychain.')) {
                    setPasskey(undefined);
                    setPk(undefined);
                  }
                }}
              >
                Forget passkey on this phone
              </button>
            </div>
          </>
        )}
        {err ? <div className="error">{err}</div> : null}
      </main>
    </>
  );
}
