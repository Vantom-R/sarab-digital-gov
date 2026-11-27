// Every time shown to people (Telegram messages, reports) is in Riyadh time (UTC+3, no daylight saving).
// Storage, logs and APIs stay in UTC/ISO.
export const TZ = 'Asia/Riyadh';
export const TZ_LABEL = { ar: 'بتوقيت الرياض', en: 'Riyadh time' } as const;

const parts = (d: Date) => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]),
) as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;

const asDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

/** "2026-11-24 09:05" in Riyadh. */
export function riyadh(d: Date | string | number): string {
  const p = parts(asDate(d));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
/** "09:05" in Riyadh. */
export function riyadhHM(d: Date | string | number): string {
  const p = parts(asDate(d));
  return `${p.hour}:${p.minute}`;
}
/** "2026-11-24" — the calendar day in Riyadh. */
export function riyadhDay(d: Date | string | number = Date.now()): string {
  const p = parts(asDate(d));
  return `${p.year}-${p.month}-${p.day}`;
}
/** Minutes since midnight in Riyadh (for "every day at HH:MM" schedules). */
export function riyadhMinutes(d: Date | string | number = Date.now()): number {
  const p = parts(asDate(d));
  return Number(p.hour) * 60 + Number(p.minute);
}
/** "2026-11-24 09:05 بتوقيت الرياض" / "… Riyadh time" */
export const riyadhAr = (d: Date | string | number) => `${riyadh(d)} ${TZ_LABEL.ar}`;
export const riyadhEn = (d: Date | string | number) => `${riyadh(d)} ${TZ_LABEL.en}`;
/** "HH:MM" → minutes since midnight. */
export const hhmmToMinutes = (s: string) => { const [h, m] = s.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
