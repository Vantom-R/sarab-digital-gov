// Civil Registry — births, from the hospital's report to the registered child.
//
//  1. A hospital reports the birth to Health (no name). Health announces health.birth.notified.
//  2. The Registry pulls the report through Jisr and opens a birth "awaiting name", with a deadline
//     (NAME_DEADLINE_DAYS). It announces registry.birth.awaiting_name, so both parents are told.
//  3. One parent proposes a name (Mithaq → Jisr → here); the other parent confirms it, or proposes a
//     different one (which the first parent must then confirm). If only one parent can be reached (no
//     father recorded, or Mithaq says the other parent has no activated account), that parent confirms alone.
//  4. On confirmation the Registry allocates the national ID and registers the child (registry.birth.named +
//     registry.person.born). Health opens the health file, Social Insurance awards child benefit.
//  5. Deadline passed: an open proposal is registered as it stands; with no proposal the parents are
//     reminded once (registry.birth.name_overdue) and can still name the baby.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Db } from '#shared/db.ts';
import { tx } from '#shared/db.ts';
import { httpError } from '#shared/http.ts';
import { jisrCall, requireJisr, type JisrContext } from '#shared/jisr.ts';
import { emitEvent, onEvents } from '#shared/events.ts';
import { ID_SCHEMA, NAME_DEADLINE_DAYS, failIf, nameProblems } from '#shared/records.ts';
import type { Bilingual } from '#shared/catalog.ts';

const bi = (ar: string, en: string): Bilingual => ({ ar, en });
const fullName = (r: any) => (r ? bi(`${r.given_name_ar} ${r.family_name_ar}`, `${r.given_name_en} ${r.family_name_en}`) : null);
const NAME_SCHEMA = { type: 'object', required: ['ar', 'en'], additionalProperties: false, properties: { ar: { type: 'string', maxLength: 40 }, en: { type: 'string', maxLength: 40 } } } as const;

type NextId = (c: PoolClient) => Promise<string>;

function requireNaming(req: any, parent: string): JisrContext {
  const ctx = requireJisr(req);
  if (ctx.client !== 'mithaq' || ctx.purpose !== 'birth-naming' || ctx.onBehalfOf !== 'self') throw httpError(403, 'forbidden', 'Only a parent, signed in to Mithaq, names a baby');
  if (ctx.subject !== parent) throw httpError(403, 'subject_mismatch', 'Declared subject must be the parent');
  return ctx;
}

async function person(q: Db | PoolClient, id: string | null) {
  return id ? (await q.query('SELECT * FROM persons WHERE national_id = $1', [id])).rows[0] ?? null : null;
}

/** One birth as a parent sees it. */
async function view(q: Db | PoolClient, b: any) {
  const [mother, father, child] = await Promise.all([person(q, b.mother_id), person(q, b.father_id), person(q, b.national_id)]);
  const { rows: props } = await q.query('SELECT * FROM birth_name_proposals WHERE notification_id = $1 ORDER BY id DESC', [b.notification_id]);
  const open = props.find((p) => p.status === 'open');
  const family = father ?? mother;
  return {
    notification_id: b.notification_id, status: b.status, gender: b.gender, birth_date: b.birth_date, hospital: b.hospital,
    reported_at: b.reported_at, name_deadline: b.name_deadline, overdue: b.status === 'awaiting_name' && new Date(b.name_deadline) < new Date(),
    mother: { national_id: b.mother_id, name: fullName(mother) },
    father: b.father_id ? { national_id: b.father_id, name: fullName(father) } : null,
    family_name: family ? bi(family.family_name_ar, family.family_name_en) : null,
    proposal: open ? { id: Number(open.id), given_name: bi(open.given_name_ar, open.given_name_en), proposed_by: open.proposed_by, proposed_at: open.proposed_at, awaiting: open.awaiting } : null,
    history: props.map((p) => ({ id: Number(p.id), given_name: bi(p.given_name_ar, p.given_name_en), proposed_by: p.proposed_by, proposed_at: p.proposed_at, status: p.status, decided_by: p.decided_by, decided_at: p.decided_at })),
    child: child ? { national_id: child.national_id, name: fullName(child) } : null,
    registered_at: b.registered_at, named_by: b.named_by,
  };
}

async function loadBirth(c: PoolClient, id: string, parent: string) {
  const b = (await c.query('SELECT * FROM births WHERE notification_id = $1 FOR UPDATE', [id])).rows[0];
  // Not a parent of this birth → as if it did not exist.
  if (!b || (b.mother_id !== parent && b.father_id !== parent)) throw httpError(404, 'not_found', 'No birth for you with this number');
  if (b.status !== 'awaiting_name') throw httpError(409, 'already_registered', 'This baby is already registered');
  return b;
}

/** Register the child under the confirmed name (caller holds the row lock). */
async function registerChild(c: PoolClient, nextNationalId: NextId, b: any, p: any, how: 'both' | 'sole' | 'deadline', decidedBy: string) {
  await c.query('SELECT pg_advisory_xact_lock(4711)'); // serialise ID allocation (shared with registrations)
  const mother = await person(c, b.mother_id);
  const father = await person(c, b.father_id);
  if (!mother) throw httpError(409, 'mother_missing', 'The mother is no longer in the registry');
  const family = father ?? mother;
  const nationalId = await nextNationalId(c);
  await c.query(
    `INSERT INTO persons (national_id, given_name_ar, given_name_en, family_name_ar, family_name_en, gender, birth_date, nationality,
       marital_status, city_ar, city_en, district_ar, district_en, street, phone, father_id, mother_id, spouse_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SRB','single',$8,$9,$10,$11,$12,NULL,$13,$14,NULL,'alive')`,
    [nationalId, p.given_name_ar, p.given_name_en, family.family_name_ar, family.family_name_en, b.gender, b.birth_date,
      mother.city_ar, mother.city_en, mother.district_ar, mother.district_en, mother.street, father?.national_id ?? null, mother.national_id],
  );
  const namedBy = how === 'both' ? `both:${p.proposed_by},${decidedBy}` : `${how}:${p.proposed_by}`;
  await c.query("UPDATE births SET status = 'registered', national_id = $2, registered_at = now(), named_by = $3 WHERE notification_id = $1", [b.notification_id, nationalId, namedBy]);
  await c.query("UPDATE birth_name_proposals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [p.id, how === 'deadline' ? 'deadline' : 'confirmed', decidedBy]);
  const parents = [mother.national_id, ...(father ? [father.national_id] : [])];
  const given_name = bi(p.given_name_ar, p.given_name_en);
  await emitEvent(c, 'registry.birth.named', {
    subjects: parents, correlationId: b.notification_id,
    data: { notification_id: b.notification_id, given_name, family_name: bi(family.family_name_ar, family.family_name_en), proposed_by: p.proposed_by, confirmed_by: decidedBy, how },
  });
  await emitEvent(c, 'registry.person.born', {
    subjects: [nationalId, ...parents], correlationId: b.notification_id,
    data: { national_id: nationalId, mother_id: mother.national_id, father_id: father?.national_id ?? null, birth_date: b.birth_date, notification_id: b.notification_id, given_name },
  });
  return nationalId;
}

export function registerBirths(app: FastifyInstance, db: Db, nextNationalId: NextId): void {
  // ---- 1 → 2: the hospital's report opens a birth awaiting its name ----
  onEvents('registry-births', {
    'health.birth.notified': async (e) => {
      const { notification_id, mother_id } = e.data as { notification_id: string; mother_id: string };
      if ((await db.query('SELECT 1 FROM births WHERE notification_id = $1', [notification_id])).rowCount) return;
      // The event only says "a report exists" — pull the details through Jisr (audited).
      const n = await jisrCall<any>({
        target: 'health', method: 'GET', path: `/x/birth-notifications/${notification_id}`,
        purpose: 'birth-registration', subject: mother_id,
      });
      await tx(db, async (c) => {
        const ins = await c.query(
          `INSERT INTO births (notification_id, national_id, status, mother_id, father_id, gender, birth_date, hospital, reported_at, name_deadline, registered_at)
           VALUES ($1, NULL, 'awaiting_name', $2, $3, $4, $5, $6, $7, $7::timestamptz + make_interval(days => $8), NULL) ON CONFLICT DO NOTHING`,
          [notification_id, n.mother_id, n.father_id, n.child_gender, n.birth_date, n.hospital, n.reported_at ?? new Date().toISOString(), NAME_DEADLINE_DAYS],
        );
        if (!ins.rowCount) return;
        const b = (await c.query('SELECT name_deadline FROM births WHERE notification_id = $1', [notification_id])).rows[0];
        await emitEvent(c, 'registry.birth.awaiting_name', {
          subjects: [n.mother_id, ...(n.father_id ? [n.father_id] : [])], correlationId: notification_id,
          data: { notification_id, mother_id: n.mother_id, father_id: n.father_id, child_gender: n.child_gender, birth_date: n.birth_date, hospital: n.hospital, name_deadline: b.name_deadline },
        });
      });
    },
  }, db);

  // ---- The parent's view ----
  app.get('/x/births', {
    schema: {
      tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }], summary: 'Births of my children: waiting for a name, or registered in the last 60 days',
      querystring: { type: 'object', required: ['parent'], properties: { parent: ID_SCHEMA } },
    },
  }, async (req) => {
    const { parent } = req.query as { parent: string };
    requireNaming(req, parent);
    const { rows } = await db.query(
      `SELECT * FROM births WHERE (mother_id = $1 OR father_id = $1)
         AND (status = 'awaiting_name' OR registered_at > now() - interval '60 days') ORDER BY reported_at DESC NULLS LAST LIMIT 20`, [parent]);
    return { births: await Promise.all(rows.map((b) => view(db, b))) };
  });

  // ---- 3: propose a name ----
  app.post('/x/births/:nid/proposal', {
    schema: {
      tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }], summary: 'A parent proposes the baby’s name (replaces any open proposal)',
      params: { type: 'object', required: ['nid'], properties: { nid: { type: 'string', pattern: '^BN-[A-Za-z0-9_-]{4,20}$' } } },
      body: {
        type: 'object', required: ['parent_id', 'given_name'], additionalProperties: false,
        properties: { parent_id: ID_SCHEMA, given_name: NAME_SCHEMA, other_parent_unreachable: { type: 'boolean', default: false } },
      },
    },
  }, async (req) => {
    const { nid } = req.params as { nid: string };
    const body = req.body as { parent_id: string; given_name: Bilingual; other_parent_unreachable: boolean };
    requireNaming(req, body.parent_id);
    failIf(nameProblems(body.given_name));
    const given = { ar: body.given_name.ar.trim(), en: body.given_name.en.trim() };
    return tx(db, async (c) => {
      const b = await loadBirth(c, nid, body.parent_id);
      const other = b.mother_id === body.parent_id ? b.father_id : b.mother_id;
      // Mithaq vouches that the other parent cannot be reached (no activated account); recorded either way.
      const awaiting = other && !body.other_parent_unreachable ? other : null;
      await c.query("UPDATE birth_name_proposals SET status = 'replaced', decided_by = $2, decided_at = now() WHERE notification_id = $1 AND status = 'open'", [nid, body.parent_id]);
      const p = (await c.query(
        'INSERT INTO birth_name_proposals (notification_id, given_name_ar, given_name_en, proposed_by, awaiting) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [nid, given.ar, given.en, body.parent_id, awaiting])).rows[0];
      await emitEvent(c, 'registry.birth.name_proposed', {
        subjects: [b.mother_id, ...(b.father_id ? [b.father_id] : [])], correlationId: nid,
        data: { notification_id: nid, proposal_id: Number(p.id), given_name: given, proposed_by: body.parent_id, awaiting, other_parent_unreachable: !!(other && body.other_parent_unreachable) },
      });
      return view(c, { ...b });
    });
  });

  // ---- 3 → 4: confirm the proposed name ----
  app.post('/x/births/:nid/confirmation', {
    schema: {
      tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }], summary: 'Confirm the proposed name: the child is registered',
      params: { type: 'object', required: ['nid'], properties: { nid: { type: 'string', pattern: '^BN-[A-Za-z0-9_-]{4,20}$' } } },
      body: { type: 'object', required: ['parent_id', 'proposal_id'], additionalProperties: false, properties: { parent_id: ID_SCHEMA, proposal_id: { type: 'integer', minimum: 1 } } },
    },
  }, async (req) => {
    const { nid } = req.params as { nid: string };
    const { parent_id, proposal_id } = req.body as { parent_id: string; proposal_id: number };
    requireNaming(req, parent_id);
    return tx(db, async (c) => {
      const b = await loadBirth(c, nid, parent_id);
      const p = (await c.query("SELECT * FROM birth_name_proposals WHERE notification_id = $1 AND status = 'open'", [nid])).rows[0];
      if (!p) throw httpError(409, 'no_proposal', 'No name has been proposed yet');
      // The name on the parent's screen must be the one being confirmed (the other parent may just have changed it).
      if (Number(p.id) !== proposal_id) throw httpError(409, 'proposal_changed', 'The proposed name changed meanwhile; check the new name');
      if (p.awaiting ? p.awaiting !== parent_id : p.proposed_by !== parent_id) {
        throw httpError(403, 'other_parent_confirms', 'You proposed this name: the other parent confirms it');
      }
      const nationalId = await registerChild(c, nextNationalId, b, p, p.awaiting ? 'both' : 'sole', parent_id);
      return view(c, { ...b, status: 'registered', national_id: nationalId, registered_at: new Date().toISOString(), named_by: p.awaiting ? 'both' : 'sole' });
    });
  });

  // ---- Only the name, for Mithaq's news feed ----
  app.get('/x/persons/:id/name', {
    schema: { tags: ['exchange (via Jisr only)'], security: [{ jisr: [] }], summary: 'Only the name of a person (for the operator’s news feed)', params: { type: 'object', required: ['id'], properties: { id: ID_SCHEMA } } },
  }, async (req) => {
    const ctx = requireJisr(req);
    const { id } = req.params as { id: string };
    if (ctx.client !== 'mithaq' || ctx.purpose !== 'news-feed' || ctx.subject !== id) throw httpError(403, 'forbidden', 'Names only for the news feed');
    const p = await person(db, id);
    if (!p) throw httpError(404, 'not_found', 'No such person');
    return { national_id: id, name: fullName(p) };
  });

  // ---- 5: deadlines (checked every minute) ----
  const sweep = async () => {
    const { rows } = await db.query("SELECT notification_id FROM births WHERE status = 'awaiting_name' AND name_deadline < now() AND (NOT overdue_notified OR EXISTS (SELECT 1 FROM birth_name_proposals p WHERE p.notification_id = births.notification_id AND p.status = 'open')) LIMIT 20");
    for (const { notification_id } of rows) {
      await tx(db, async (c) => {
        const b = (await c.query("SELECT * FROM births WHERE notification_id = $1 AND status = 'awaiting_name' FOR UPDATE", [notification_id])).rows[0];
        if (!b) return;
        const p = (await c.query("SELECT * FROM birth_name_proposals WHERE notification_id = $1 AND status = 'open'", [notification_id])).rows[0];
        if (p) { await registerChild(c, nextNationalId, b, p, 'deadline', 'deadline'); return; }
        if (b.overdue_notified) return;
        await c.query('UPDATE births SET overdue_notified = true WHERE notification_id = $1', [notification_id]);
        await emitEvent(c, 'registry.birth.name_overdue', {
          subjects: [b.mother_id, ...(b.father_id ? [b.father_id] : [])], correlationId: notification_id,
          data: { notification_id, mother_id: b.mother_id, father_id: b.father_id, name_deadline: b.name_deadline },
        });
      }).catch((err) => app.log.error({ err, notification_id }, 'birth deadline sweep failed'));
    }
  };
  setInterval(() => { sweep().catch((err) => app.log.error({ err }, 'birth deadline sweep failed')); }, 60_000).unref();
}
