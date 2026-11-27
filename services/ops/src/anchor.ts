// Audit anchor: once an hour, Jisr's signed chain head is posted to the operator's Telegram chat — a copy
// outside this server that an insider with full database rights cannot rewrite — and the live chain is
// checked against every anchor taken so far.
//
// Each run:
//   1. asks Jisr for its signed checkpoint (GET /api/jisr/audit/head) and verifies the EdDSA signature with
//      Jisr's key from the trust list;
//   2. reads the audit log straight from Jisr's database (independently of Jisr's code) and recomputes the
//      whole hash chain;
//   3. checks that the chain still contains every earlier anchor (same hash at the same entry number) and
//      that the signed head is in it. Rewriting any entry — even recomputing every later hash — changes the
//      hash of every later anchor, so it cannot go unnoticed;
//   4. keeps the new anchor in ./backups/.anchors.jsonl and posts it to Telegram (heading "⚓"): silently
//      every hour, and once a day as a normal message with a plain summary.
// Any problem becomes an alert ("🚨"). `make audit-verify` runs the same checks on demand, and can check
// anchors pasted from Telegram (the independent copy).
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import pg from 'pg';
import { jwtVerify } from 'jose';
import '#shared/db.ts';
import { memberPublicKey } from '#shared/crypto.ts';
import { verifyChain } from '../../jisr/src/chain.ts';
import { riyadhAr } from '#shared/time.ts';

const JISR = process.env.JISR_URL ?? 'http://jisr:3000';
export const ANCHORS = process.env.ANCHOR_FILE ?? '/backups/.anchors.jsonl';

export interface Anchor { seq: number; hash: string; at: string; signed: string }
export interface AnchorCheck { ok: boolean; problems: string[]; head?: Anchor; entries?: number; checked: number }

export function loadAnchors(file = ANCHORS): Anchor[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Parses anchors pasted from Telegram messages (any number, any surrounding text). */
export function parseAnchorText(text: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of text.matchAll(/signed:\s*([\w-]+\.[\w-]+\.[\w-]+)/g)) {
    const payload = JSON.parse(Buffer.from(m[1]!.split('.')[1]!, 'base64url').toString());
    out.push({ seq: Number(payload.seq), hash: String(payload.hash), at: String(payload.at), signed: m[1]! });
  }
  return out;
}

async function verifySigned(signed: string): Promise<{ seq: number; hash: string; at: string }> {
  const { payload } = await jwtVerify(signed, await memberPublicKey('jisr'), { issuer: 'jisr', typ: 'jisr-checkpoint+jwt' });
  if (typeof payload.seq !== 'number' || typeof payload.hash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.hash)) throw new Error('malformed checkpoint');
  return { seq: payload.seq, hash: payload.hash, at: String(payload.at) };
}

/** Checks the live chain against the given anchors (and, if given, a fresh signed head). */
export async function checkChain(anchors: Anchor[], head?: Anchor): Promise<AnchorCheck> {
  const problems: string[] = [];
  for (const a of anchors) {
    try {
      const p = await verifySigned(a.signed);
      if (p.seq !== a.seq || p.hash !== a.hash) problems.push(`anchor #${a.seq}: its fields do not match its signature`);
    } catch (e) { problems.push(`anchor #${a.seq}: signature invalid (${(e as Error).message})`); }
  }
  const db = new pg.Client({ host: 'jisr-db', user: 'jisr', database: 'jisr', password: process.env.JISR_DB_PASSWORD });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const chain = await verifyChain(db);
    if (!chain.ok) problems.push(`audit chain broken at entry #${chain.broken_at}: ${chain.problem}`);
    const all = head ? [...anchors, head] : anchors;
    const seqs = [...new Set(all.map((a) => a.seq))];
    const { rows } = await db.query('SELECT seq, hash FROM audit_log WHERE seq = ANY($1::bigint[])', [seqs]);
    const live = new Map(rows.map((r) => [Number(r.seq), r.hash as string]));
    for (const a of all) {
      const h = live.get(a.seq);
      if (h === undefined) problems.push(`entry #${a.seq} (anchored ${a.at}) is missing from the audit log`);
      else if (h !== a.hash) problems.push(`entry #${a.seq} (anchored ${a.at}) has a different hash now: the log was rewritten at or before it`);
    }
    const last = anchors.at(-1);
    if (last && chain.head_seq < last.seq) problems.push(`the chain is shorter (#${chain.head_seq}) than the last anchor (#${last.seq})`);
    await db.query('COMMIT');
    return { ok: problems.length === 0, problems, head, entries: chain.entries, checked: all.length };
  } finally {
    await db.end().catch(() => {});
  }
}

/** Fetches and verifies Jisr's signed head. */
export async function fetchHead(): Promise<Anchor> {
  const r = await fetch(`${JISR}/api/jisr/audit/head`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Jisr answered HTTP ${r.status}`);
  const j = await r.json() as { signed: string };
  const p = await verifySigned(j.signed);
  return { ...p, signed: j.signed };
}

/** The daily anchor message: a plain one-line summary first, the technical proof at the end. */
export function anchorText(a: Anchor, check: AnchorCheck): string {
  return [
    `✅ سجل التدقيق سليم — ${a.seq} عملية`,
    `⚓ المرساة اليومية لسجل التدقيق | Daily audit anchor — ${riyadhAr(a.at)}`,
    `فُحصت السلسلة كاملة (${check.entries} سجل) وطابقت ${check.checked} مرساة محفوظة على الخادم`,
    `Chain recomputed (${check.entries} entries); ${check.checked} anchors kept on the server match.`,
    '',
    `#${a.seq}`,
    `hash: ${a.hash}`,
    `signed: ${a.signed}`,
  ].join('\n');
}

/** The hourly copy, sent without sound or notification: just the proof (make audit-verify TEXT=… reads it). */
export function silentAnchorText(a: Anchor): string {
  return [
    `⚓ مرساة الساعة (صامتة) | Hourly audit anchor (silent) — ${riyadhAr(a.at)}`,
    `#${a.seq}`,
    `hash: ${a.hash}`,
    `signed: ${a.signed}`,
  ].join('\n');
}

export function recordAnchor(a: Anchor): void {
  appendFileSync(ANCHORS, `${JSON.stringify(a)}\n`, { mode: 0o600 });
}

/** After `make reset` the old chain is gone on purpose: archive the old anchors and start again. */
export function archiveAnchors(): string | null {
  if (!existsSync(ANCHORS)) return null;
  const to = `${ANCHORS}.${new Date().toISOString().slice(0, 10)}.archived`;
  renameSync(ANCHORS, to);
  return to;
}
