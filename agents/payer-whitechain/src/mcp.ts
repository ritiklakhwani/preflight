// Spawns the Preflight MCP server (packages/mcp) over stdio and wraps its tools.
// The agent reaches Capline only through these tools, like any MCP client would.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { agentAddress } from './tools.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const API_URL = process.env.CAPLINE_API_URL || 'http://localhost:8787';

export interface ToolResult {
  text: string;
  json?: unknown;
  isError: boolean;
}

export interface PreflightMcp {
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export async function connectPreflightMcp(): Promise<PreflightMcp> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  // The MCP tools default the agent from this; make sure it is this wallet.
  // The key wins over a stale CAPLINE_AGENT_ADDRESS in .env, or the agent
  // would ask for a refill of some other wallet.
  try {
    env.CAPLINE_AGENT_ADDRESS = agentAddress();
  } catch {
    // No key and no address: capline tools will need an explicit agent.
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'packages/mcp/src/index.ts'],
    cwd: REPO_ROOT,
    env,
    // Server diagnostics go to stderr; keep the demo transcript clean unless debugging.
    stderr: process.env.CAPLINE_DEBUG ? 'inherit' : 'ignore',
  });
  const client = new Client({ name: 'capline-payer-whitechain', version: '0.1.0' });
  await client.connect(transport);

  return {
    client,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
      let json: unknown = res.structuredContent;
      if (json === undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          // Rendered text, not JSON.
        }
      }
      return { text, json, isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

const TERMINAL = ['released', 'approved', 'declined', 'expired'] as const;
export type RequestStatus = 'pending' | (typeof TERMINAL)[number] | 'unknown';

function pickStatus(v: unknown): RequestStatus | undefined {
  return typeof v === 'string' && ['pending', ...TERMINAL].includes(v) ? (v as RequestStatus) : undefined;
}

/** Finds the request status in a capline_status result ("REQUEST <id>: PENDING", or JSON). */
export function extractRequestStatus(r: ToolResult): RequestStatus {
  if (r.json && typeof r.json === 'object') {
    const j = r.json as Record<string, any>;
    const s = pickStatus(j.request?.status) ?? pickStatus(j.requestStatus) ?? pickStatus(j.status);
    if (s) return s;
  }
  // Match only the header line: the reason and policy text can contain these words too.
  return pickStatus(r.text.match(/^REQUEST \S+: ([A-Z]+)\s*$/m)?.[1]?.toLowerCase()) ?? 'unknown';
}

export function extractRequestId(r: ToolResult): string | undefined {
  if (r.json && typeof r.json === 'object') {
    const j = r.json as Record<string, unknown>;
    if (typeof j.requestId === 'string') return j.requestId;
    if (typeof j.id === 'string') return j.id;
  }
  return r.text.match(/^requestId:\s*(\S+)/m)?.[1];
}

/** Fallback when the MCP result is unparseable: ask the approval server directly (spec API). */
export async function requestStatusHttp(id: string): Promise<RequestStatus> {
  try {
    const res = await fetch(`${API_URL}/api/requests/${encodeURIComponent(id)}`);
    if (!res.ok) return 'unknown';
    return pickStatus(((await res.json()) as { status?: unknown }).status) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
