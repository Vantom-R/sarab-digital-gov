// Manual ops commands, run inside the ops container:
//   node services/ops/src/cli.ts backup [--no-upload]   take a backup now (and send it to Telegram)
//   node services/ops/src/cli.ts verify-anchors [file]  check the audit chain against the stored anchors, or
//                                                       against anchors pasted from Telegram into <file>
//   node services/ops/src/cli.ts anchors-reset          archive the anchors (only after `make reset`)
import { runBackup } from './backup.ts';
import { save } from './state.ts';
import { readFileSync } from 'node:fs';
import { archiveAnchors, checkChain, loadAnchors, parseAnchorText } from './anchor.ts';

const cmd = process.argv[2];
if (cmd === 'backup') {
  const upload = !process.argv.includes('--no-upload');
  const r = await runBackup({ upload });
  save('backup', { last_ok: Date.now(), failures: 0, last: { name: r.name, size: r.size, parts: r.parts.length, rows: r.rows, seconds: r.seconds } });
  console.log(`backup ${r.name}: ${(r.size / 1024 / 1024).toFixed(2)} MB, ${r.parts.length} part(s), ${r.databases} databases, ${r.tables} tables, ${r.rows} rows, ${r.seconds} s — ${upload ? 'sent to Telegram, ' : 'NOT uploaded, '}kept in ./backups`);
} else if (cmd === 'verify-anchors') {
  const file = process.argv[3];
  const anchors = file ? parseAnchorText(readFileSync(file, 'utf8')) : loadAnchors();
  if (!anchors.length) { console.error(file ? 'no anchors found in that text (paste whole Telegram messages)' : 'no anchors stored yet'); process.exit(1); }
  const r = await checkChain(anchors);
  console.log(`${anchors.length} anchor(s) from ${file ? 'the pasted text' : 'the local list'}, ${anchors[0]!.at} to ${anchors.at(-1)!.at}`);
  console.log(`audit chain recomputed: ${r.entries} entries`);
  if (r.ok) console.log('RESULT: PASS — every anchor signature is valid and every anchored entry still has its hash');
  else { console.log(`RESULT: FAIL\n- ${r.problems.join('\n- ')}`); process.exit(1); }
} else if (cmd === 'test-alert') {
  const { postText } = await import('./notify.ts');
  await postText('/alert', { text: 'اختبار — ليس عطلًا | TEST — not a real problem\nThis is how a monitoring alert looks. Nothing to do.' });
  await postText('/alert', { resolved: true, text: 'اختبار — ليس عطلًا | TEST — not a real problem\nThis is how the matching "resolved" message looks.' });
  console.log('two test messages (alert + resolved) sent to Telegram');
} else if (cmd === 'status') {
  const r = await fetch('http://127.0.0.1:3000/status');
  console.log((await r.json()).report);
} else if (cmd === 'maintenance') {
  // make up / deploy / restart / reset wrap docker compose in "maintenance start" … "maintenance end".
  const { startMaintenance, endMaintenance } = await import('./maintenance.ts');
  if (process.argv[3] === 'start') { await startMaintenance(Number(process.argv[4] ?? 30)); console.log('maintenance window open (alerts about containers paused, at most 30 min)'); }
  else if (process.argv[3] === 'end') { const c = await endMaintenance(); console.log(c.length ? `maintenance over; updated: ${c.join(', ')} (one 🔧 message sent)` : 'maintenance over; nothing changed (no message)'); }
  else { console.error('usage: cli.ts maintenance start [minutes] | end'); process.exit(2); }
} else if (cmd === 'send-report') {
  // A plain-text report (e.g. the red-team report) to the operator's Telegram, as a file. Never put secrets in it.
  const { postDocument } = await import('./notify.ts');
  const file = process.argv[3]!; const caption = process.argv.slice(4).join(' ').slice(0, 800);
  await postDocument(file, file.split('/').pop()!, caption, 'security');
  console.log('report sent to Telegram');
} else if (cmd === 'anchors-reset') {
  const to = archiveAnchors();
  console.log(to ? `old anchors archived to ${to.replace('/backups/', 'backups/')}` : 'no anchors to archive');
} else {
  console.error('usage: cli.ts backup [--no-upload] | verify-anchors [file] | anchors-reset | test-alert | status | maintenance start|end');
  process.exit(2);
}
