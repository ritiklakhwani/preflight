// Small shared pieces: routing, server status, badges, copy buttons.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Verdict } from '@preflight/capline';
import { api } from './api.js';

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
  unknown: 'Not scored',
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={`badge v-${verdict}`}>{VERDICT_LABEL[verdict] ?? verdict}</span>;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill s-${status}`}>{status}</span>;
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
  return (
    <header className="top">
      {back !== undefined ? (
        <a className="back" href={back} aria-label="Back">
          Back
        </a>
      ) : (
        <span className="brand">Capline</span>
      )}
      <h1>{title}</h1>
      <span className={`dot d-${state}`} title={`Server ${state}`} aria-label={`Server ${state}`} />
    </header>
  );
}
