// Event bus client (NATS JetStream) with a transactional outbox and signed events.
//
//   emitEvent(tx, type, …)  — inside the SAME database transaction as the state change, writes a signed
//                             event to the service's own outbox table (so state + event commit together).
//   the outbox pump         — publishes outbox rows to JetStream (msgID = event id → de-duplicated).
//   onEvents(consumer, …)   — pulls from a durable consumer, verifies the publisher's signature, runs the
//                             handler, acks. Handlers must be idempotent (delivery is at-least-once).
import { connect, type NatsConnection, type JetStreamClient } from 'nats';
import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import type pg from 'pg';
import type { Db } from './db.ts';
import { loadOwnKey, memberPublicKey, randomId } from './crypto.ts';
import { EVENT_TYPES, STREAM, SUBSCRIPTIONS, subjectFor } from './event-policy.ts';

export interface SarabEvent<D = any> {
  id: string;
  type: string;
  publisher: string;
  /** national IDs of the people this event is about (drives the inbox and "who accessed my data") */
  subjects: string[];
  /** ties together all events of one life event (e.g. the birth-notification id) */
  correlation_id: string;
  data: D;
  at: string;
}

let ncPromise: Promise<NatsConnection> | null = null;

export function bus(): Promise<NatsConnection> {
  ncPromise ??= (async () => {
    const member = process.env.MEMBER_ID!;
    for (let attempt = 1; ; attempt++) {
      try {
        return await connect({
          servers: process.env.NATS_URL ?? 'nats://nats:4222',
          user: member,
          pass: process.env.NATS_PASSWORD,
          name: member,
          inboxPrefix: `_INBOX.${member}`, // the only inbox this member may subscribe to
          maxReconnectAttempts: -1,
          reconnectTimeWait: 1000,
        });
      } catch (e) {
        if (attempt % 10 === 1) console.warn(`[events] waiting for the bus: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();
  return ncPromise;
}

const OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS event_outbox (
  id            text PRIMARY KEY,
  subject       text NOT NULL,
  token         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX IF NOT EXISTS event_outbox_pending_idx ON event_outbox (created_at) WHERE published_at IS NULL;
-- Inbound de-duplication for at-least-once delivery.
CREATE TABLE IF NOT EXISTS event_inbox (
  consumer     text NOT NULL,
  event_id     text NOT NULL,
  handled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);`;

/** Call once at start-up in every service that publishes or consumes events. */
export async function initEvents(db: Db): Promise<void> {
  await db.query(OUTBOX_SQL);
}

/** Writes a signed event to the outbox. Pass the transaction client so it commits with the state change. */
export async function emitEvent(
  c: pg.PoolClient | Db,
  type: string,
  e: { subjects: string[]; correlationId: string; data: Record<string, unknown> },
): Promise<string> {
  const def = EVENT_TYPES[type];
  const own = await loadOwnKey();
  if (!def || def.publisher !== own.memberId) throw new Error(`${own.memberId} may not publish ${type}`);
  const id = randomId(12);
  const token = await new SignJWT({ type, subjects: e.subjects, correlation_id: e.correlationId, data: e.data })
    .setProtectedHeader({ alg: 'EdDSA', kid: own.kid, typ: 'sarab-event+jwt' })
    .setIssuer(own.memberId).setJti(id).setIssuedAt()
    .sign(own.key);
  await c.query('INSERT INTO event_outbox (id, subject, token) VALUES ($1, $2, $3)', [id, subjectFor(type), token]);
  kick?.();
  return id;
}

let kick: (() => void) | null = null;

/** Publishes pending outbox rows; runs forever in the background. */
export function startOutboxPump(db: Db): void {
  let running = false;
  let again = false;
  const pump = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      const js: JetStreamClient = (await bus()).jetstream();
      do {
        again = false;
        const { rows } = await db.query('SELECT id, subject, token FROM event_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50');
        for (const r of rows) {
          await js.publish(r.subject, new TextEncoder().encode(r.token), { msgID: r.id });
          await db.query('UPDATE event_outbox SET published_at = now() WHERE id = $1', [r.id]);
        }
        if (rows.length === 50) again = true;
      } while (again);
    } catch (e) {
      console.warn(`[events] outbox publish failed, will retry: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  kick = () => { setTimeout(pump, 20); };
  setInterval(pump, 3000).unref();
  pump();
}

/** Verifies an event token: signed by the member that is the declared (and only allowed) publisher. */
export async function verifyEvent(token: string): Promise<SarabEvent> {
  const iss = decodeJwt(token).iss ?? '';
  const { payload } = await jwtVerify(token, await memberPublicKey(iss), { typ: 'sarab-event+jwt' });
  const type = payload.type as string;
  if (EVENT_TYPES[type]?.publisher !== payload.iss) throw new Error(`${payload.iss} is not the publisher of ${type}`);
  return {
    id: payload.jti!, type, publisher: payload.iss!, subjects: (payload.subjects as string[]) ?? [],
    correlation_id: payload.correlation_id as string, data: payload.data, at: new Date((payload.iat ?? 0) * 1000).toISOString(),
  };
}

type Handler = (e: SarabEvent) => Promise<void>;

/**
 * Consumes a durable consumer declared in event-policy.ts. The handler map is keyed by event type;
 * '*' handles every type. With `db`, each event id is processed at most once per consumer.
 */
export function onEvents(consumer: string, handlers: Record<string, Handler>, db?: Db): void {
  const sub = SUBSCRIPTIONS.find((s) => s.consumer === consumer);
  if (!sub || sub.member !== process.env.MEMBER_ID) throw new Error(`consumer ${consumer} is not declared for ${process.env.MEMBER_ID}`);
  (async () => {
    for (;;) {
      try {
        const js = (await bus()).jetstream();
        const c = await js.consumers.get(STREAM, consumer);
        const messages = await c.consume({ max_messages: 20 });
        for await (const m of messages) {
          let evt: SarabEvent;
          try {
            evt = await verifyEvent(new TextDecoder().decode(m.data));
          } catch (e) {
            console.warn(`[events] ${consumer}: dropping unverifiable event: ${(e as Error).message}`);
            m.term();
            continue;
          }
          const handler = handlers[evt.type] ?? handlers['*'];
          try {
            if (handler) {
              if (db) {
                const seen = await db.query('SELECT 1 FROM event_inbox WHERE consumer = $1 AND event_id = $2', [consumer, evt.id]);
                if (!seen.rowCount) {
                  await handler(evt);
                  await db.query('INSERT INTO event_inbox (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [consumer, evt.id]);
                }
              } else {
                await handler(evt);
              }
            }
            m.ack();
          } catch (e) {
            console.warn(`[events] ${consumer}: ${evt.type} ${evt.id} failed (redelivery in 5 s): ${(e as Error).message}`);
            m.nak(5000);
          }
        }
      } catch (e) {
        console.warn(`[events] ${consumer}: consumer not ready (${(e as Error).message}); retrying`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
}
