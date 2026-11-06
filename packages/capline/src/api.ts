import type { Address, Hex } from 'viem';
import type { ChainKey } from './chains.js';
import { authToJson, type WebAuthnAuth } from './vault.js';
import type { AgentStateJson, CreateRequestInput, Request, RequestStatus } from './types.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fetch client for the approval server (apps/approve/server). */
export function createApiClient(baseUrl: string, opts: { timeoutMs?: number } = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg =
        data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : text;
      throw new ApiError(`${method} ${path} -> ${res.status}: ${msg || res.statusText}`, res.status);
    }
    return data as T;
  }

  const enc = encodeURIComponent;
  return {
    baseUrl: root,
    createRequest: (input: CreateRequestInput) =>
      call<{ id: string; status: 'pending' }>('POST', '/api/requests', input),
    getRequest: (id: string) => call<Request>('GET', `/api/requests/${enc(id)}`),
    listRequests: (agent?: Address) =>
      call<Request[]>('GET', `/api/requests${agent ? `?agent=${enc(agent)}` : ''}`),
    approve: (id: string, auth: WebAuthnAuth) =>
      call<{ txHash: Hex }>('POST', `/api/requests/${enc(id)}/approve`, { auth: authToJson(auth) }),
    decline: (id: string) => call<{ status: RequestStatus }>('POST', `/api/requests/${enc(id)}/decline`, {}),
    drop: (agent: Address, p: { chain: ChainKey; expiry: bigint | number; auth: WebAuthnAuth }) =>
      call<{ txHash: Hex }>('POST', `/api/agents/${enc(agent)}/drop`, {
        chain: p.chain,
        expiry: Number(p.expiry),
        auth: authToJson(p.auth),
      }),
    getAgentState: (agent: Address, chain: ChainKey) =>
      call<AgentStateJson>('GET', `/api/agents/${enc(agent)}?chain=${enc(chain)}`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
