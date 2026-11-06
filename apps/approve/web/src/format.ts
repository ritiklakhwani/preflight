import { formatUnits } from 'viem';
import { CHAIN_META, type ChainKey } from './config.js';

export function short(addr: string | undefined, n = 4): string {
  if (!addr) return '';
  return addr.length <= 2 + n * 2 + 1 ? addr : `${addr.slice(0, 2 + n)}...${addr.slice(-n)}`;
}

/** Base units to "12.5 USDT", trimming zeros but keeping at least two decimals. */
export function money(amount: string | bigint | number | undefined, chain: ChainKey, withSymbol = true): string {
  if (amount === undefined || amount === '') return '-';
  const meta = CHAIN_META[chain];
  let s: string;
  try {
    s = formatUnits(BigInt(amount), meta.decimals);
  } catch {
    return String(amount);
  }
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  const n = `${Number(whole).toLocaleString('en-US')}.${trimmed}`;
  return withSymbol ? `${n} ${meta.symbol}` : n;
}

export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'expired';
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ago(unix: number): string {
  const d = Math.floor(Date.now() / 1000) - unix;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleDateString();
}
