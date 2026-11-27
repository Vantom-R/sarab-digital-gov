// Password sign-in: slow down, never lock (red-team item D, 27 Nov 2026).
//
// Per-address limits already exist (10 attempts a minute). From the internet an attacker would need many
// machines to get around them, so each ACCOUNT also has a brake that does not depend on the address:
//   * after 5 wrong passwords in a row (within 15 minutes), every further attempt for that account is
//     answered only after a wait: 1 s, then 2, 3, 4, and at most 5 s per attempt;
//   * attempts for the same account queue one behind the other, so sending them in parallel or from
//     many addresses does not help: at most one guess per 5 seconds per account (about 700 a day,
//     against a 6-digit Telegram code that is still needed after the password);
//   * if the queue for an account is already longer than 30 seconds, the attempt is answered at once
//     with 429 "try again in N seconds" — without checking the password;
//   * the wait applies before ANY answer, right or wrong (otherwise the answer time would give it away);
//   * nothing is ever locked: the brake ends by itself 15 minutes after the last wrong password, and the
//     right password clears it at once. A known username ("admin") can therefore be slowed down, but its
//     owner always gets in once the attack pauses.
// The same applies to national IDs that have no account, so the brake does not reveal who exists.
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';

export const FREE_FAILURES = 5;
export const MAX_DELAY_S = 5;
export const MAX_QUEUE_S = 30;
const RESET_MINUTES = 15;

/** Reserves this attempt's turn for `subject` and returns how long to wait (ms) before answering. */
export async function throttleTurn(db: Db, subject: string): Promise<number> {
  return tx(db, async (c) => {
    const row = (await c.query(
      `SELECT failures, last_failure < now() - make_interval(mins => $2) AS stale, greatest(next_slot, now()) AS slot,
              extract(epoch FROM greatest(next_slot, now()) - now()) AS queued
       FROM password_throttle WHERE subject = $1 FOR UPDATE`, [subject, RESET_MINUTES])).rows[0];
    if (!row || row.stale) return 0;
    if (row.failures < FREE_FAILURES) return 0;
    const delay = Math.min(MAX_DELAY_S, row.failures - FREE_FAILURES + 1);
    const wait = Number(row.queued) + delay;
    if (wait > MAX_QUEUE_S) {
      const retry = Math.ceil(Number(row.queued));
      throw httpError(429, 'too_many_attempts', `Too many sign-in attempts for this account. Try again in ${retry} seconds.`, { retry_after: retry });
    }
    await c.query('UPDATE password_throttle SET next_slot = $2::timestamptz + make_interval(secs => $3) WHERE subject = $1', [subject, row.slot, delay]);
    return Math.round(wait * 1000);
  });
}

export async function recordFailure(db: Db, subject: string): Promise<void> {
  await db.query(
    `INSERT INTO password_throttle (subject, failures, last_failure, next_slot) VALUES ($1, 1, now(), now())
     ON CONFLICT (subject) DO UPDATE SET
       failures = CASE WHEN password_throttle.last_failure < now() - make_interval(mins => $2) THEN 1 ELSE password_throttle.failures + 1 END,
       last_failure = now()`, [subject, RESET_MINUTES]);
}

export async function clearFailures(db: Db, subject: string): Promise<void> {
  await db.query('DELETE FROM password_throttle WHERE subject = $1', [subject]);
}

/** Housekeeping: forget brakes that ended long ago (also keeps made-up usernames from piling up). */
export function startThrottleCleanup(db: Db): void {
  setInterval(() => { db.query("DELETE FROM password_throttle WHERE last_failure < now() - interval '1 day'").catch(() => {}); }, 3_600_000).unref();
}
