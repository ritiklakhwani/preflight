// Thin client for the approval server. Errors carry only the server's own
// one-line message, so the phone can show it as is. status 0 = unreachable.
import { authToJson, type AgentStateJson, type Request, type WebAuthnAuth } from '@preflight/capline';
import { API_URL, type ChainKey } from './config.js';

export type ServerRequest = Request & { reasonFlags?: string[]; error?: string };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError('Server unreachable', 0);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
    throw new ApiError(msg || `Server error ${res.status}`, res.status);
  }
  // A static host answering index.html for /api means there is no server.
  if (data === undefined) throw new ApiError('Server unreachable', 0);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  health: () => call<{ ok: boolean }>('GET', '/api/health', undefined, 4_000),
  getRequest: (id: string) => call<ServerRequest>('GET', `/api/requests/${enc(id)}`, undefined, 10_000),
  listRequests: (agent: string) => call<ServerRequest[]>('GET', `/api/requests?agent=${enc(agent)}`, undefined, 10_000),
  approve: (id: string, auth: WebAuthnAuth) =>
    call<{ txHash: `0x${string}` }>('POST', `/api/requests/${enc(id)}/approve`, { auth: authToJson(auth) }),
  decline: (id: string) => call<{ status: string }>('POST', `/api/requests/${enc(id)}/decline`, {}),
  agentState: (chain: ChainKey, agent: string) =>
    call<AgentStateJson>('GET', `/api/agents/${enc(agent)}?chain=${enc(chain)}`, undefined, 15_000),
  setDropped: (kind: 'drop' | 'undrop', chain: ChainKey, agent: string, expiry: number, auth: WebAuthnAuth) =>
    call<{ txHash: `0x${string}` }>('POST', `/api/agents/${enc(agent)}/${kind}`, { chain, expiry, auth: authToJson(auth) }),
};
