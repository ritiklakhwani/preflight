/**
 * Verdict persistence.
 *
 * Postgres when DATABASE_URL points at a reachable server, otherwise an
 * in-process map. The fallback is not a convenience: the MCP server has to
 * answer an agent that is waiting to sign, and a database that is down is a
 * worse reason to fail than any risk we might have found.
 *
 * Everything here logs to stderr. The MCP server speaks JSON-RPC over stdout,
 * so a stray console.log corrupts the protocol stream.
 */
import type { Verdict } from '@preflight/core';
import pg from 'pg';

export interface VerdictStore {
  kind: 'postgres' | 'memory';
  save(v: Verdict): Promise<void>;
  get(id: string): Promise<Verdict | null>;
  recent(limit: number): Promise<Verdict[]>;
  close(): Promise<void>;
}

function memoryStore(): VerdictStore {
  const rows = new Map<string, Verdict>();
  return {
    kind: 'memory',
    async save(v) {
      rows.set(v.id, v);
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async recent(limit) {
      return [...rows.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
    async close() {
      rows.clear();
    },
  };
}

function postgresStore(pool: pg.Pool): VerdictStore {
  return {
    kind: 'postgres',
    async save(v) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into verdicts
             (id, address, chain_id, severity, score, summary, analysis,
              gate_required, gate_approved, gate_method,
              hcs_topic_id, hcs_sequence, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (id) do nothing`,
          [
            v.id, v.address, v.chainId, v.severity, v.score, v.summary,
            JSON.stringify(v.analysis),
            v.gate?.required ?? false, v.gate?.approved ?? null, v.gate?.method ?? null,
            v.hcs?.topicId ?? null, v.hcs?.sequenceNumber ?? null, v.createdAt,
          ],
        );
        for (const s of v.signals) {
          await client.query(
            `insert into signal_results (verdict_id, name, fired, weight, evidence, error)
             values ($1,$2,$3,$4,$5,$6)`,
            [v.id, s.name, s.fired, s.weight, JSON.stringify(s.evidence), s.error ?? null],
          );
        }
        for (const t of v.taint) {
          await client.query(
            `insert into taint_events (verdict_id, field_path, source, raw, action, matched_rules)
             values ($1,$2,$3,$4,$5,$6)`,
            [v.id, t.fieldPath, t.source, t.raw, t.action, JSON.stringify(t.matchedRules)],
          );
        }
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async get(id) {
      const { rows } = await pool.query('select * from verdicts where id = $1', [id]);
      const row = rows[0];
      if (!row) return null;
      return hydrate(pool, row);
    },

    async recent(limit) {
      const { rows } = await pool.query(
        'select * from verdicts order by created_at desc limit $1',
        [limit],
      );
      return Promise.all(rows.map((r) => hydrate(pool, r)));
    },

    async close() {
      await pool.end();
    },
  };
}

async function hydrate(pool: pg.Pool, row: Record<string, unknown>): Promise<Verdict> {
  const id = String(row['id']);
  const [signals, taint] = await Promise.all([
    pool.query('select name, fired, weight, evidence, error from signal_results where verdict_id = $1', [id]),
    pool.query('select field_path, source, raw, action, matched_rules from taint_events where verdict_id = $1', [id]),
  ]);

  return {
    id,
    address: String(row['address']),
    chainId: Number(row['chain_id']),
    severity: row['severity'] as Verdict['severity'],
    score: Number(row['score']),
    summary: String(row['summary']),
    analysis: row['analysis'] as Verdict['analysis'],
    coverage: {
      ran: signals.rows.filter((s) => !s.error).length,
      total: signals.rows.length,
    },
    signals: signals.rows.map((s) => ({
      name: s.name,
      fired: s.fired,
      weight: s.weight,
      evidence: s.evidence,
      ...(s.error ? { error: s.error } : {}),
    })),
    taint: taint.rows.map((t) => ({
      fieldPath: t.field_path,
      source: t.source,
      raw: t.raw,
      action: t.action,
      matchedRules: t.matched_rules,
    })),
    ...(row['gate_required']
      ? {
          gate: {
            required: Boolean(row['gate_required']),
            approved: Boolean(row['gate_approved']),
            method: row['gate_method'] as 'auto' | 'device',
          },
        }
      : {}),
    ...(row['hcs_topic_id']
      ? {
          hcs: {
            topicId: String(row['hcs_topic_id']),
            sequenceNumber: Number(row['hcs_sequence']),
            hashscanUrl: `https://hashscan.io/testnet/topic/${row['hcs_topic_id']}`,
          },
        }
      : {}),
    createdAt: new Date(row['created_at'] as string).toISOString(),
  };
}

/** Tries Postgres, falls back to memory, and says which one it got. */
export async function createStore(): Promise<VerdictStore> {
  const url = process.env['DATABASE_URL']?.trim();
  if (!url) {
    process.stderr.write('[store] DATABASE_URL unset, using in-memory store\n');
    return memoryStore();
  }

  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await pool.query('select 1 from verdicts limit 1');
    process.stderr.write('[store] postgres connected\n');
    return postgresStore(pool);
  } catch (err) {
    await pool.end().catch(() => {});
    // pg surfaces a refused connection as an Error with an empty message and a
    // code, so message alone leaves you staring at empty parentheses.
    const e = err as { message?: string; code?: string };
    const msg = e.message || e.code || 'connection refused';
    process.stderr.write(
      `[store] postgres unavailable (${msg}), using in-memory store. Run 'pnpm db:up && pnpm db:init' to persist.\n`,
    );
    return memoryStore();
  }
}
