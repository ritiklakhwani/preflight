import { useState } from 'react';
import { isAddress } from 'viem';
import { CHAIN_KEYS, CHAIN_META, addressLabel, type ChainKey } from '../config.js';
import { short } from '../format.js';
import { forgetAgent, getAgents, getPasskey } from '../storage.js';
import { Header, Icon, OfflineBanner, Section, go, useServer } from '../ui.js';

export function HomeScreen() {
  const passkey = getPasskey();
  const [agents, setAgents] = useState(getAgents);
  const [chain, setChain] = useState<ChainKey>('whitechain');
  const [addr, setAddr] = useState('');
  const { state } = useServer();

  return (
    <>
      <Header title="Pocket Approve" />
      <OfflineBanner />
      <main>
        <section className="intro">
          <h2 className="title">Your agent spends small amounts. You approve the next one.</h2>
          <p className="muted">
            When the budget runs out, the request lands here with every payment since the last refill. Face ID releases
            more; nothing else can.
          </p>
        </section>

        <Section label="Passkey">
          <a className="card row-card" href="#/setup">
            <span className="stack">
              <span className="strong">{passkey ? 'Passkey ready' : 'No passkey yet'}</span>
              <span className="muted small">
                {passkey ? (
                  <>
                    qx <span className="addr-mono">{short(passkey.qx, 6)}</span>
                  </>
                ) : (
                  'Create one to approve refills with Face ID.'
                )}
              </span>
            </span>
            <span className={passkey ? 'faint' : 'cta'}>
              {passkey ? <Icon name="chevron" /> : 'Create'}
            </span>
          </a>
        </Section>

        <Section label="Agents">
          <div className="card list">
            {agents.length === 0 ? <p className="empty">None yet. Add one below or open a request.</p> : null}
            {agents.map((a) => {
              const label = addressLabel(a.chain, a.agent);
              return (
                <div key={a.chain + a.agent} className="row-link">
                  <a href={`#/a/${a.chain}/${a.agent}`} className="grow stack">
                    {label ? <span className="addr-label">{label}</span> : null}
                    <span className="addr-mono">{short(a.agent, 6)}</span>
                    <span className="faint small">{CHAIN_META[a.chain].name}</span>
                  </a>
                  <button
                    className="link"
                    onClick={() => {
                      forgetAgent(a);
                      setAgents(getAgents());
                    }}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        </Section>

        <Section label="Open an agent">
          <div className="card form">
            <div className="seg">
              {CHAIN_KEYS.map((c) => (
                <button key={c} className={c === chain ? 'on' : ''} onClick={() => setChain(c)}>
                  {CHAIN_META[c].name}
                </button>
              ))}
            </div>
            <input
              className="input mono"
              placeholder="Agent address 0x..."
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={addr}
              onChange={(e) => setAddr(e.target.value.trim())}
            />
            <button className="btn secondary" disabled={!isAddress(addr)} onClick={() => go(`/a/${chain}/${addr}`)}>
              Open agent
            </button>
          </div>
        </Section>

        <p className="footnote">
          Server {state === 'checking' ? 'checking' : state}. No analytics, no third-party scripts. The vault trusts only
          your passkey.
        </p>
      </main>
    </>
  );
}
