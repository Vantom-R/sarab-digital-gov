// Small persistent state for the ops container (last backup, alert states), in the ops-data volume.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const FILE = process.env.OPS_STATE ?? '/data/state.json';

export function load<T extends object>(key: string, fallback: T): T {
  try { return { ...fallback, ...(JSON.parse(readFileSync(FILE, 'utf8'))[key] ?? {}) }; } catch { return fallback; }
}

export function save(key: string, value: unknown): void {
  let all: Record<string, unknown> = {};
  try { all = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* first write */ }
  all[key] = value;
  writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}
