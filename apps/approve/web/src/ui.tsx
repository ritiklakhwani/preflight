// Small shared pieces: routing, server status, badges, copy buttons.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Verdict } from '@preflight/capline';
import { api } from './api.js';
import { addressLabel, addressUrl, type ChainKey } from './config.js';
import { short } from './format.js';

export function useHashRoute(): string[] {
  const parse = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => {
      setParts(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export const go = (path: string) => {
  location.hash = path;
};

type ServerState = 'checking' | 'online' | 'offline';
const ServerCtx = createContext<{ state: ServerState; recheck: () => void }>({ state: 'checking', recheck: () => {} });

export function ServerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ServerState>('checking');
  const recheck = useCallback(() => {
    api.health().then(
      () => setState('online'),
      () => setState('offline'),
    );
  }, []);
  useEffect(() => {
    recheck();
    const t = setInterval(recheck, 15_000);
    const vis = () => document.visibilityState === 'visible' && recheck();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [recheck]);
  return <ServerCtx.Provider value={{ state, recheck }}>{children}</ServerCtx.Provider>;
}

export const useServer = () => useContext(ServerCtx);

export function OfflineBanner() {
  const { state, recheck } = useServer();
  if (state !== 'offline') return null;
  return (
    <div className="banner" role="status">
      <span>Server offline: talking to the chain directly</span>
      <button className="link" onClick={recheck}>
        Retry
      </button>
    </div>
  );
}

const VERDICT_LABEL: Record<Verdict, string> = {
  high: 'High risk',
  medium: 'Medium risk',
  low: 'Low risk',
  clean: 'Clean',
  unknown: 'Unscored',
};

/** Preflight says "wallet, not a contract" for plain accounts: nothing to score. */
export const isWallet = (reasons: readonly string[] | undefined): boolean =>
  !!reasons?.some((r) => /wallet, not a contract/i.test(r));

export function VerdictBadge({ verdict, reasons }: { verdict: Verdict; reasons?: readonly string[] }) {
  if (verdict === 'unknown' && isWallet(reasons)) return <span className="badge v-wallet">Wallet</span>;
  return <span className={`badge v-${verdict}`}>{VERDICT_LABEL[verdict] ?? verdict}</span>;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  released: 'Released',
  declined: 'Declined',
  expired: 'Expired',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill s-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Known name (display only) above a short mono address. */
export function Addr({
  chain,
  address,
  n = 4,
  link = false,
}: {
  chain: ChainKey;
  address: string;
  n?: number;
  link?: boolean;
}) {
  const label = addressLabel(chain, address);
  const mono = link ? (
    <a className="addr-mono" href={addressUrl(chain, address)} target="_blank" rel="noreferrer">
      {short(address, n)}
    </a>
  ) : (
    <span className="addr-mono">{short(address, n)}</span>
  );
  return (
    <span className="addr">
      {label ? <span className="addr-label">{label}</span> : null}
      {mono}
    </span>
  );
}

export function Section({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-label">{label}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Icon({ name, size = 16 }: { name: 'check' | 'alert' | 'x' | 'chevron' | 'external' | 'back'; size?: number }) {
  const paths: Record<string, ReactNode> = {
    check: <path d="M4 8.5l2.5 2.5L12 5.5" />,
    alert: (
      <>
        <path d="M8 5v3.5" />
        <path d="M8 11h.01" />
        <circle cx="8" cy="8" r="6.25" />
      </>
    ),
    x: <path d="M5 5l6 6M11 5l-6 6" />,
    chevron: <path d="M6 4l4 4-4 4" />,
    external: <path d="M6 4h6v6M12 4l-7 7" />,
    back: <path d="M10 3L5 8l5 5" />,
  };
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older iOS without clipboard permission: select-and-copy fallback.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button className="btn-small" onClick={copy}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{children}</div>
    </div>
  );
}

export function Header({ title, back }: { title: string; back?: string }) {
  const { state } = useServer();
  const statusText = state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Checking';
  return (
    <header className="top">
      <div className="top-inner">
        {back !== undefined ? (
          <a className="back" href={back} aria-label="Back">
            <Icon name="back" size={18} />
            <span>Back</span>
          </a>
        ) : (
          <span className="brand">Capline</span>
        )}
        <h1>{title}</h1>
        <span className={`server d-${state}`} title={`Server ${state}`} aria-label={`Server ${state}`}>
          <span className="dot" />
          <span className="server-text">{statusText}</span>
        </span>
      </div>
    </header>
  );
}
