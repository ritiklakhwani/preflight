import { useState } from 'react';
import { isAddress } from 'viem';
import { CHAIN_META, CHAIN_KEYS, type ChainKey } from '../config.js';
import { createPasskey, passkeyError, passkeySupported } from '../passkey.js';
import { getPasskey, rememberAgent, setPasskey, type StoredPasskey } from '../storage.js';
import { Copy, Field, Header, OfflineBanner, go } from '../ui.js';

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
          <section className="card">
            <p className="strong">You are the owner. Your passkey is your key.</p>
            <p className="muted">
              Created in this phone's secure chip and unlocked with Face ID. The vault checks its signature onchain. No seed
              phrase, no owner wallet.
            </p>
            <button className="btn primary" disabled={busy} onClick={create}>
              {busy ? 'Waiting for Face ID...' : 'Create passkey'}
            </button>
          </section>
        ) : (
          <>
            <section className="card">
              <div className="section-title">Your passkey public key</div>
              <Field label="qx">
                <span className="mono wrap">{pk.qx}</span> <Copy text={pk.qx} />
              </Field>
              <Field label="qy">
                <span className="mono wrap">{pk.qy}</span> <Copy text={pk.qy} />
              </Field>
              <div className="muted small">
                Made for {pk.rpId}. Public data only; the private key never leaves the secure chip.
              </div>
            </section>

            <section className="card">
              <div className="section-title">Register an agent</div>
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
              <div className="sub-title">Run on the deployer machine</div>
              <pre className="payload">{cmd}</pre>
              <Copy text={cmd} label="Copy command" />
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
            </section>

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
          </>
        )}
        {err ? <div className="error">{err}</div> : null}
      </main>
    </>
  );
}
