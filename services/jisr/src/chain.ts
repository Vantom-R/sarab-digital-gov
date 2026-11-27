// The audit log's hash chain: each entry's hash covers the previous hash and the entry's canonical form.
// Used by Jisr itself and by the backup restore test (services/ops), which re-verifies a restored copy.
import { sha256hex } from '#shared/crypto.ts';

export const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  request_id: string; ts: string; client: string; target: string | null; method: string | null; path: string | null;
  purpose: string | null; subject: string | null; consent_id: string | null; on_behalf_of: string | null;
  decision: 'allow' | 'deny'; reason: string | null; status: number | null;
  /** Phase 6: sha256 of the target's (signed) response body */
  response_sha256?: string | null;
}

// Entries written before Phase 6 have no response hash and keep their original canonical form.
const canonical = (e: AuditEntry) =>
  JSON.stringify([e.request_id, e.ts, e.client, e.target, e.method, e.path, e.purpose, e.subject, e.consent_id, e.on_behalf_of, e.decision, e.reason, e.status,
    ...(e.response_sha256 ? [e.response_sha256] : [])]);

export const entryHash = (prev: string, e: AuditEntry) => sha256hex(`${prev}|${canonical(e)}`);

export interface ChainCheck { ok: boolean; entries: number; head: string; head_seq: number; broken_at?: number; problem?: string }

/** Recomputes the whole chain and reports the first broken link. */
export async function verifyChain(q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): Promise<ChainCheck> {
  let prev = GENESIS;
  let count = 0;
  let lastSeq = 0;
  for (;;) {
    const { rows } = await q.query('SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT 1000', [lastSeq]);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prev_hash !== prev) return { ok: false, entries: count, head: prev, head_seq: lastSeq, broken_at: Number(r.seq), problem: 'prev_hash does not link to the previous entry (entry removed or reordered)' };
      if (entryHash(prev, r) !== r.hash) return { ok: false, entries: count, head: prev, head_seq: lastSeq, broken_at: Number(r.seq), problem: 'entry content does not match its hash (entry modified)' };
      prev = r.hash;
      count++;
      lastSeq = Number(r.seq);
    }
  }
  return { ok: true, entries: count, head: prev, head_seq: lastSeq };
}
