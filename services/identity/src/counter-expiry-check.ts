// Test for the counter-session timeout (make e2e runs it): a counter session the employee forgot to end
// must close by itself and be logged as "session.expired". Waiting 20 real minutes is not practical, so this
// opens a session for the automated-test account (TEST-0001, never a real employee) that is already past its
// end, then runs the same expiry code the identity service runs every minute.
//   node services/identity/src/counter-expiry-check.ts
import { createDb } from '#shared/db.ts';
import { randomId } from '#shared/crypto.ts';
import { expireCounterSessions } from './counter.ts';

const SALEH = '1100000015';
const db = createDb();
let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
};
try {
  console.log('Counter sessions expire by themselves');
  const id = `CS-${randomId(6)}`;
  await db.query(
    `INSERT INTO assisted_sessions (id, employee, employee_id, citizen, status, code_hash, confirmed_at, expires_at)
     VALUES ($1, 'staff:test', 'TEST-0001', $2, 'active', 'x', now() - interval '25 minutes', now() - interval '5 minutes')`, [id, SALEH]);
  const outbox = async () => (await db.query("SELECT count(*)::int AS n FROM event_outbox WHERE subject LIKE '%assisted%'")).rows[0].n as number;
  const before = await outbox();
  const n = await expireCounterSessions(db, id);
  const s = (await db.query('SELECT status, ended_at, expires_at FROM assisted_sessions WHERE id = $1', [id])).rows[0];
  const a = (await db.query("SELECT action, detail, at FROM assisted_actions WHERE assisted_session_id = $1", [id])).rows;
  check('a forgotten counter session is closed once its 20 minutes are over', n === 1 && s?.status === 'ended', { n, s });
  check('it ends at the moment it expired', s && new Date(s.ended_at).getTime() === new Date(s.expires_at).getTime());
  check('it is logged as "session.expired" (shown as "Session expired"), with the reason', a.length === 1 && a[0].action === 'session.expired' && a[0].detail?.reason === 'timeout', a);
  check('the citizen is told (one signed event queued for their inbox)', (await outbox()) === before + 1);
  check('running it again changes nothing', (await expireCounterSessions(db, id)) === 0);
  const open = (await db.query("SELECT count(*)::int AS n FROM assisted_sessions WHERE status = 'active' AND expires_at < now() - interval '2 minutes'")).rows[0].n;
  check('no counter session anywhere stays open past its end', open === 0, { open });
} catch (e) {
  failed++;
  console.log(`  ✗ counter expiry check crashed — ${(e as Error).message}`);
} finally {
  await db.end();
}
console.log(failed ? `counter expiry: ${failed} FAILED` : 'counter expiry: all passed');
process.exit(failed ? 1 : 0);
