// Mints a short-lived ticket that lets automated tests (make e2e / make a11y) receive one-time codes in the
// API response (`test_code`) instead of a Telegram message. Needs shell access on the server (it is run
// inside the identity container); the ticket is printed once and only its hash is stored.
// Each code delivered this way uses up one use; the ticket expires after 30 minutes.
//   node services/identity/src/test-ticket.ts <uses 1-999>
import { randomBytes } from 'node:crypto';
import { createDb } from '#shared/db.ts';
import { sha256hex } from '#shared/crypto.ts';

const [uses = '50'] = process.argv.slice(2);
if (!/^\d{1,3}$/.test(uses) || Number(uses) < 1) { console.error('usage: test-ticket.ts <uses 1-999>'); process.exit(2); }
const db = createDb();
await db.query('DELETE FROM staff_test_tickets WHERE expires_at < now()');
const ticket = randomBytes(32).toString('base64url');
await db.query("INSERT INTO staff_test_tickets (ticket_hash, subject, uses_left, expires_at) VALUES ($1, '*', $2, now() + interval '30 minutes')",
  [sha256hex(ticket), Number(uses)]);
process.stdout.write(ticket + '\n');
await db.end();
