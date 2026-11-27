// Nightly encrypted backup: every database + secrets/ + .env (without the Telegram bot token).
//
//   1. Each database is dumped (pg_dump custom format) inside a REPEATABLE READ snapshot whose exact
//      row counts go into manifest.json, so a restore can be checked table by table.
//   2. tar + gzip, then encrypted with age to a PUBLIC key (BACKUP_AGE_RECIPIENT). This container can
//      encrypt but never decrypt: the private key lives only in the operator's hands (outside Telegram).
//   3. Kept on the server (./backups, last BACKUP_KEEP sets) and sent to the operator's Telegram chat as the
//      off-server copy, split into parts below Telegram's 50 MB bot upload limit.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, cpSync, openSync, readSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { postDocument } from './notify.ts';
import { riyadh, riyadhAr } from '#shared/time.ts';

export const DATABASES = [
  { name: 'jisr', host: 'jisr-db', env: 'JISR_DB_PASSWORD' },
  { name: 'identity', host: 'identity-db', env: 'IDENTITY_DB_PASSWORD' },
  { name: 'registry', host: 'registry-db', env: 'REGISTRY_DB_PASSWORD' },
  { name: 'consent', host: 'consent-db', env: 'CONSENT_DB_PASSWORD' },
  { name: 'bank', host: 'bank-db', env: 'BANK_DB_PASSWORD' },
  { name: 'education', host: 'education-db', env: 'EDUCATION_DB_PASSWORD' },
  { name: 'health', host: 'health-db', env: 'HEALTH_DB_PASSWORD' },
  { name: 'labor', host: 'labor-db', env: 'LABOR_DB_PASSWORD' },
  { name: 'property', host: 'property-db', env: 'PROPERTY_DB_PASSWORD' },
] as const;

const OUT = process.env.BACKUP_DIR ?? '/backups';
const SRC = process.env.BACKUP_SRC ?? '/src';      // secrets/ and .env, mounted read-only
const KEEP = Number(process.env.BACKUP_KEEP ?? 7);
export const PART_BYTES = Number(process.env.BACKUP_PART_BYTES ?? 45 * 1024 * 1024);
/** Never leaves the server inside a backup: Telegram is where the backup goes, and the token can be re-issued by BotFather. */
const ENV_EXCLUDE = /^TELEGRAM_BOT_TOKEN=/;

export const COUNT_SQL = `SELECT table_name AS t,
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::bigint AS n
  FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`;

export function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listFiles(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]));
}

export interface BackupResult { name: string; size: number; sha256: string; parts: { file: string; sha256: string; size: number }[]; databases: number; tables: number; rows: number; seconds: number }

async function dumpDatabase(db: typeof DATABASES[number], file: string): Promise<Record<string, number>> {
  const password = process.env[db.env];
  if (!password) throw new Error(`${db.env} missing`);
  const client = new pg.Client({ host: db.host, user: db.name, database: db.name, password });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS s')).rows[0].s as string;
    const counts = Object.fromEntries((await client.query(COUNT_SQL)).rows.map((r) => [r.t, Number(r.n)]));
    await run('pg_dump', ['-h', db.host, '-U', db.name, '-d', db.name, '-Fc', '-Z', '0', `--snapshot=${snapshot}`, '-f', file], { PGPASSWORD: password });
    await client.query('COMMIT');
    return counts;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function runBackup(opts: { upload?: boolean } = {}): Promise<BackupResult> {
  const started = Date.now();
  const recipient = process.env.BACKUP_AGE_RECIPIENT ?? '';
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error('BACKUP_AGE_RECIPIENT is not set (run: make backup-key)');
  const work = mkdtempSync('/tmp/sarab-backup-');
  try {
    const stamp = riyadh(Date.now()).replace(/[-:]/g, '').replace(' ', '-');   // 20261124-0330, Riyadh time
    const name = `sarab-backup-${stamp}KSA.tar.gz.age`;
    const content = join(work, 'content');
    mkdirSync(join(content, 'db'), { recursive: true });

    const manifest: any = { format: 1, created_at: new Date().toISOString(), databases: {}, files: {}, notes: 'Telegram bot token removed from env on purpose (re-issue it with BotFather).' };
    for (const db of DATABASES) {
      const file = join(content, 'db', `${db.name}.dump`);
      const tables = await dumpDatabase(db, file);
      manifest.databases[db.name] = { tables, sha256: await sha256File(file) };
    }
    // The audit chain's head at backup time (the restore test re-verifies the whole chain against it).
    const jisr = new pg.Client({ host: 'jisr-db', user: 'jisr', database: 'jisr', password: process.env.JISR_DB_PASSWORD });
    await jisr.connect();
    const head = (await jisr.query('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
    await jisr.end();
    manifest.audit_head = head ? { seq: Number(head.seq), hash: head.hash } : null;

    cpSync(join(SRC, 'secrets'), join(content, 'secrets'), { recursive: true });
    const env = readFileSync(join(SRC, 'env'), 'utf8').split('\n').filter((l) => !ENV_EXCLUDE.test(l)).join('\n');
    writeFileSync(join(content, 'env'), env, { mode: 0o600 });
    for (const f of listFiles(content)) if (!f.startsWith('db/')) manifest.files[f] = await sha256File(join(content, f));
    writeFileSync(join(content, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const out = join(OUT, name);
    await run('sh', ['-c', 'set -o pipefail; tar -C "$W" -czf - . | age -r "$R" -o "$O"'], { W: content, R: recipient, O: `${out}.tmp` });
    await run('mv', [`${out}.tmp`, out]);
    chmodSync(out, 0o600);
    const size = statSync(out).size;
    const sha256 = await sha256File(out);

    // Parts (only when needed) are the exact bytes sent to Telegram; `cat part* > file` rebuilds the file.
    const parts: BackupResult['parts'] = [];
    if (size > PART_BYTES) {
      const fd = openSync(out, 'r');
      const buf = Buffer.alloc(1024 * 1024);
      for (let i = 0, pos = 0; pos < size; i++) {
        const file = `${out}.part${String(i + 1).padStart(2, '0')}`;
        const chunks: Buffer[] = [];
        let n = 0;
        while (n < PART_BYTES && pos < size) {
          const got = readSync(fd, buf, 0, Math.min(buf.length, PART_BYTES - n, size - pos), pos);
          chunks.push(Buffer.from(buf.subarray(0, got)));
          n += got; pos += got;
        }
        writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
        parts.push({ file, sha256: await sha256File(file), size: n });
      }
      closeSync(fd);
    } else {
      parts.push({ file: out, sha256, size });
    }
    const tables = Object.values(manifest.databases).reduce((a: number, d: any) => a + Object.keys(d.tables).length, 0);
    const rows = Object.values(manifest.databases).reduce((a: number, d: any) => a + Object.values(d.tables as Record<string, number>).reduce((x, y) => x + y, 0), 0);
    writeFileSync(`${out}.sha256`, [`${sha256}  ${name}`, ...(parts.length > 1 ? parts.map((p) => `${p.sha256}  ${p.file.slice(OUT.length + 1)}`) : [])].join('\n') + '\n', { mode: 0o600 });

    if (opts.upload !== false) {
      for (const [i, p] of parts.entries()) {
        const caption = [
          `Sarab — ${riyadhAr(manifest.created_at)}`,
          `الجزء ${i + 1} من ${parts.length} | part ${i + 1}/${parts.length}`,
          `${DATABASES.length} قواعد بيانات، ${rows} سجل | ${DATABASES.length} databases, ${rows} rows, + secrets/`,
          `الحجم | size: ${(size / 1024 / 1024).toFixed(2)} MB`,
          `SHA-256 (whole file): ${sha256}`,
          ...(parts.length > 1 ? [`SHA-256 (this part): ${p.sha256}`, 'cat part* > file'] : []),
          'فك التشفير يحتاج مفتاح age المحفوظ خارج تيليجرام | decrypt with the age key kept outside Telegram',
        ].join('\n');
        await postDocument(p.file, p.file.slice(OUT.length + 1), caption);
      }
    }
    prune();
    return { name, size, sha256, parts, databases: DATABASES.length, tables, rows, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Keeps the newest KEEP backup sets (file + parts + .sha256). */
function prune(): void {
  const sets = [...new Set(readdirSync(OUT).filter((f) => /^sarab-backup-\d{8}-\d{4}(Z|KSA)\.tar\.gz\.age/.test(f)).map((f) => f.replace(/(\.part\d+|\.sha256|\.tmp)$/, '')))].sort();
  for (const old of sets.slice(0, Math.max(0, sets.length - KEEP))) {
    for (const f of readdirSync(OUT)) if (f.startsWith(old)) rmSync(join(OUT, f), { force: true });
  }
}
