import { useState } from 'react';
import { isAddress } from 'viem';
import { CHAIN_KEYS, CHAIN_META, type ChainKey } from '../config.js';
import { short } from '../format.js';
import { forgetAgent, getAgents, getPasskey } from '../storage.js';
import { Header, OfflineBanner, go, useServer } from '../ui.js';

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
        <section className="card intro">
          <p className="strong">Your agent spends from small tranches. When it wants more, you decide here.</p>
          <p className="muted small">
            Server {state === 'checking' ? 'checking' : state}. Requests arrive as a push notification.
          </p>
        </section>

        <a className={`btn ${passkey ? 'secondary' : 'primary'}`} href="#/setup">
          {passkey ? 'Passkey and registration' : 'Create passkey'}
        </a>

        <section className="card">
          <div className="section-title">Agents</div>
          {agents.length === 0 ? <p className="muted small">None yet. Open one below or from a request.</p> : null}
          {agents.map((a) => (
            <div key={a.chain + a.agent} className="row-link">
              <a href={`#/a/${a.chain}/${a.agent}`} className="grow">
                <span className="mono">{short(a.agent, 6)}</span>{' '}
                <span className="muted small">{CHAIN_META[a.chain].name}</span>
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
          ))}
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
        </section>
        <p className="muted small center">No analytics. No third-party scripts. The vault trusts only your passkey.</p>
      </main>
    </>
  );
}
