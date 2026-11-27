// Red team, part 3: the "perfect" audit-log rewrite — on a COPY restored from the newest backup, never live.
// An insider with full database rights edits one entry and recomputes every later hash, so the chain is
// internally valid again. Does anything still notice? Runs in a throwaway ops container with no network.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, chownSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import '#shared/db.ts';
import { entryHash, verifyChain } from '../services/jisr/src/chain.ts';

const PG = 70;
const sh = (cmd: string, args: string[], env: Record<string, string> = {}, uid?: number) => new Promise<void>((ok, bad) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], ...(uid ? { uid, gid: uid } : {}) });
  let e = ''; p.stderr.on('data', (c) => { e += c; });
  p.on('close', (c) => (c === 0 ? ok() : bad(new Error(`${cmd}: ${e.slice(0, 300)}`))));
});

const file = readdirSync('/backups').filter((f) => /^sarab-backup-.*\.tar\.gz\.age$/.test(f)).sort().at(-1)!;
const anchors = readFileSync('/backups/.anchors.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: number; hash: string; at: string });
const w = mkdtempSync('/tmp/tamper-'); chownSync(w, PG, PG);
const out: Record<string, unknown> = { backup: file };
try {
  mkdirSync(join(w, 'c'));
  await sh('sh', ['-c', 'age -d -i /key "/backups/$F" | tar -C "$C" -xzf - ./db/jisr.dump'], { F: file, C: join(w, 'c') });
  await sh('initdb', ['-D', join(w, 'pg'), '-U', 'postgres', '--auth=trust'], {}, PG);
  await sh('pg_ctl', ['-D', join(w, 'pg'), '-o', `-k ${w} -c listen_addresses=''`, '-w', '-l', join(w, 'log'), 'start'], {}, PG);
  await sh('createdb', ['-h', w, '-U', 'postgres', 'jisr'], {}, PG);
  await sh('pg_restore', ['-h', w, '-U', 'postgres', '-d', 'jisr', '--no-owner', '--no-acl', join(w, 'c', 'db', 'jisr.dump')], {}, PG);
  const db = new pg.Client({ host: w, user: 'postgres', database: 'jisr' });
  db.on('error', () => {});
  await db.connect();
  const head = Number((await db.query('SELECT max(seq) AS m FROM audit_log')).rows[0].m);
  const inRange = anchors.filter((a) => a.seq <= head);
  const lastAnchor = Math.max(...inRange.map((a) => a.seq));

  /** Edit one entry (hide who read what) and recompute every later hash: a perfect rewrite. */
  async function rewrite(seq: number) {
    await db.query('ALTER TABLE audit_log DISABLE TRIGGER ALL');
    await db.query("UPDATE audit_log SET purpose = 'citizen-self-service', on_behalf_of = 'self' WHERE seq = $1", [seq]);
    const rows = (await db.query('SELECT * FROM audit_log WHERE seq >= $1 ORDER BY seq', [seq])).rows;
    let prev = rows[0].prev_hash;
    for (const r of rows) {
      const h = entryHash(prev, r);
      await db.query('UPDATE audit_log SET prev_hash = $2, hash = $3 WHERE seq = $1', [r.seq, prev, h]);
      prev = h;
    }
  }
  const anchorCheck = async (set = inRange) => {
    const live = new Map((await db.query('SELECT seq, hash FROM audit_log WHERE seq = ANY($1::bigint[])', [set.map((a) => a.seq)])).rows.map((r) => [Number(r.seq), r.hash]));
    return set.filter((a) => live.get(a.seq) !== a.hash).length;
  };

  // The window: an edit made after the newest anchor (here: pretend only the first anchor exists yet).
  const known = [inRange[0]!];
  const after = Number((await db.query('SELECT min(seq) AS s FROM audit_log WHERE seq > $1', [known[0]!.seq + 50])).rows[0].s ?? 0);
  const before = Number((await db.query('SELECT max(seq) AS s FROM audit_log WHERE seq < $1', [inRange[0]!.seq])).rows[0].s ?? 0);
  await db.query('BEGIN');
  await rewrite(after);
  out.after_last_anchor = { edited_entry: after, chain_still_valid: (await verifyChain(db)).ok, anchors_mismatching: await anchorCheck(known), anchors_known: 1 };
  await db.query('ROLLBACK');
  await db.query('BEGIN');
  await rewrite(before);
  out.before_an_anchor = { edited_entry: before, chain_still_valid: (await verifyChain(db)).ok, anchors_mismatching: await anchorCheck(), anchors_checked: inRange.length };
  await db.query('ROLLBACK');
  out.copy_head = head; out.last_anchor_in_copy = lastAnchor;
  await db.end();
} catch (e) {
  out.error = (e as Error).message;
} finally {
  await sh('pg_ctl', ['-D', join(w, 'pg'), '-m', 'fast', 'stop'], {}, PG).catch(() => {});
  rmSync(w, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
