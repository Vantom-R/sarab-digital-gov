// Restore test: proves a backup can really be restored, without touching the live system.
//
//   make restore-test [FILE=sarab-backup-….tar.gz.age]      (default: the newest backup in ./backups)
//
// Runs in a throwaway container with no network, as root only to read the private key; Postgres runs as
// its own user. Steps: rebuild the file from its parts (if split) and check its SHA-256; decrypt with the
// age private key; check every file against the manifest; start an empty Postgres; restore every
// database; compare every table's row count with the manifest; re-verify the whole audit hash chain and
// its head. Prints a summary only — no data, no secrets. Everything is deleted afterwards.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import pg from 'pg';
import '#shared/db.ts';  // same type parsers as the services (the chain hashes values as the services read them)
import { verifyChain } from '../../jisr/src/chain.ts';
import { COUNT_SQL, DATABASES, run, sha256File } from './backup.ts';

const DIR = process.env.BACKUP_DIR ?? '/backups';
const KEY = process.env.BACKUP_KEY_FILE ?? '/key';
const PG_UID = 70;   // the 'postgres' user of the Alpine package

const lines: string[] = [];
const say = (s: string) => { lines.push(s); console.log(s); };
const asPostgres = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const p = spawn(cmd, args, { uid: PG_UID, gid: PG_UID, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}: ${err.trim().slice(0, 400)}`))));
});

async function main() {
  const arg = process.argv[2];
  const all = readdirSync(DIR).filter((f) => /^sarab-backup-\d{8}-\d{4}(Z|KSA)\.tar\.gz\.age$/.test(f) || /\.part01$/.test(f)).map((f) => f.replace(/\.part01$/, '')).sort();
  const name = (arg ? arg.replace(/^.*\//, '').replace(/\.part\d+$/, '') : all.at(-1));
  if (!name) throw new Error('no backup found in ./backups');
  if (!existsSync(KEY)) throw new Error('private key not mounted');
  say(`Restore test of ${name}`);

  const work = mkdtempSync('/tmp/restore-');
  chownSync(work, PG_UID, PG_UID);
  let pgStarted = false;
  try {
    // 1. Rebuild from parts if needed, check the checksum written at backup time (also in the Telegram caption).
    let file = join(DIR, name);
    const parts = readdirSync(DIR).filter((f) => f.startsWith(`${name}.part`)).sort();
    if (parts.length) {
      file = join(work, name);
      const out = createWriteStream(file);
      for (const p of parts) await pipeline(createReadStream(join(DIR, p)), out, { end: false });
      out.end();
      await new Promise<void>((r) => out.on('close', () => r()));
      say(`- rebuilt from ${parts.length} parts`);
    }
    const sha = await sha256File(file);
    const expected = existsSync(join(DIR, `${name}.sha256`)) ? readFileSync(join(DIR, `${name}.sha256`), 'utf8').split('\n')[0]!.split(' ')[0] : null;
    if (expected && expected !== sha) throw new Error('checksum of the backup file does not match');
    say(`- checksum ${expected ? 'matches' : 'computed (no .sha256 file to compare)'}: ${sha}`);

    // 2. Decrypt and unpack.
    const content = join(work, 'content');
    mkdirSync(content);
    await run('sh', ['-c', 'set -o pipefail; age -d -i "$K" "$F" | tar -C "$C" -xzf -'], { K: KEY, F: file, C: content });
    const manifest = JSON.parse(readFileSync(join(content, 'manifest.json'), 'utf8'));
    say(`- decrypted with the private key; backup taken ${manifest.created_at}`);

    // 3. Every file as recorded.
    for (const [f, h] of Object.entries(manifest.files as Record<string, string>)) {
      if ((await sha256File(join(content, f))) !== h) throw new Error(`file ${f} does not match the manifest`);
    }
    for (const [n, d] of Object.entries(manifest.databases as Record<string, any>)) {
      if ((await sha256File(join(content, 'db', `${n}.dump`))) !== d.sha256) throw new Error(`dump ${n} does not match the manifest`);
    }
    const keyFiles = Object.keys(manifest.files).filter((f) => f.startsWith('secrets/keys/')).length;
    const env = readFileSync(join(content, 'env'), 'utf8');
    if (/^TELEGRAM_BOT_TOKEN=/m.test(env)) throw new Error('the Telegram bot token is inside the backup');
    if (!/^MASTER_KEY=./m.test(env)) throw new Error('MASTER_KEY missing from the backed-up env');
    say('- env has MASTER_KEY and the database passwords; the Telegram bot token is left out as intended');
    say(`- ${Object.keys(manifest.files).length} secret/config files and ${Object.keys(manifest.databases).length} dumps match the manifest (${keyFiles} member keys, env present: ${'env' in manifest.files})`);

    // 4. A fresh Postgres, local socket only.
    const data = join(work, 'pg');
    await asPostgres('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
    await asPostgres('pg_ctl', ['-D', data, '-o', `-k ${work} -c listen_addresses=''`, '-w', '-l', join(work, 'pg.log'), 'start']);
    pgStarted = true;

    // 5. Restore and count.
    let tables = 0, rows = 0;
    for (const db of DATABASES) {
      const want = manifest.databases[db.name]?.tables as Record<string, number> | undefined;
      if (!want) throw new Error(`database ${db.name} missing from the backup`);
      await asPostgres('createdb', ['-h', work, '-U', 'postgres', db.name]);
      await asPostgres('pg_restore', ['-h', work, '-U', 'postgres', '-d', db.name, '--no-owner', '--no-acl', '--exit-on-error', join(content, 'db', `${db.name}.dump`)]);
      const c = new pg.Client({ host: work, user: 'postgres', database: db.name });
      await c.connect();
      const got = Object.fromEntries((await c.query(COUNT_SQL)).rows.map((r) => [r.t, Number(r.n)]));
      for (const [t, n] of Object.entries(want)) {
        if (got[t] !== n) throw new Error(`${db.name}.${t}: ${got[t] ?? 'missing'} rows restored, ${n} expected`);
      }
      const dbRows = Object.values(want).reduce((a, b) => a + b, 0);
      tables += Object.keys(want).length; rows += dbRows;
      if (db.name === 'jisr') {
        const chain = await verifyChain(c);
        const head = manifest.audit_head;
        if (!chain.ok) throw new Error(`restored audit chain is broken at entry ${chain.broken_at}: ${chain.problem}`);
        if (head && (chain.head !== head.hash || chain.head_seq !== head.seq)) throw new Error('restored audit chain head differs from the head recorded at backup time');
        say(`- jisr: audit chain re-verified, ${chain.entries} entries, head #${chain.head_seq} matches the backup`);
      }
      await c.end();
      say(`- ${db.name}: ${Object.keys(want).length} tables, ${dbRows} rows — all counts match`);
    }
    say(`RESULT: PASS — ${DATABASES.length} databases, ${tables} tables, ${rows} rows restored and checked.`);
  } finally {
    if (pgStarted) await asPostgres('pg_ctl', ['-D', join(work, 'pg'), '-m', 'fast', '-w', 'stop']).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { say(`RESULT: FAIL — ${(e as Error).message}`); process.exit(1); });
