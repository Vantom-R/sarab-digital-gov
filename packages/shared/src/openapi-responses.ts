// Response documentation for every route, generated from real traffic.
//
// Hand-written `response` schemas in Fastify also drive serialization (fields missing from the schema are
// silently dropped), so they are risky to add to ~150 existing routes. Instead:
//   * `make openapi` restarts the services with OPENAPI_CAPTURE=1 and runs the e2e and browser test suites.
//     Each service infers a JSON Schema from every JSON response it sends — keys and types only, never
//     values — and merges them per route and status code;
//   * the result is committed as services/<service>/openapi-responses.json;
//   * at start-up each service adds those schemas to its OpenAPI document (documentation only — they never
//     touch serialization), for every route that has no hand-written response schema.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';

type Schema = Record<string, any>;
export type Captured = Record<string, Record<string, Schema>>;   // "GET /api/x/:id" → status → schema

const CAPTURE_FILE = '/tmp/openapi-capture.json';
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_D = /^\d{4}-\d{2}-\d{2}$/;

/** Objects keyed by data (IDs, table names, dates) are maps, not records with fixed fields. */
function isMap(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  if (keys.length > 40) return true;
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k) || ISO_D.test(k) || /^[A-Z]{2,4}-\d+$/.test(k));
}

export function infer(v: unknown): Schema {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) return { type: 'array', items: v.reduce<Schema | null>((acc, x) => merge(acc, infer(x)), null) ?? {} };
  switch (typeof v) {
    case 'string': return ISO_DT.test(v) ? { type: 'string', format: 'date-time' } : ISO_D.test(v) ? { type: 'string', format: 'date' } : { type: 'string' };
    case 'number': return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      const o = v as Record<string, unknown>;
      if (isMap(o)) return { type: 'object', additionalProperties: Object.values(o).reduce<Schema | null>((acc, x) => merge(acc, infer(x)), null) ?? {} };
      const properties: Record<string, Schema> = {};
      for (const [k, x] of Object.entries(o)) properties[k] = infer(x);
      return { type: 'object', properties, required: Object.keys(o).sort() };
    }
    default: return {};
  }
}

const types = (s: Schema): string[] => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []);

/** Merges two observed schemas: fields seen only sometimes become optional; differing types become a union. */
export function merge(a: Schema | null, b: Schema): Schema {
  if (!a) return b;
  const ta = types(a), tb = types(b);
  const t = [...new Set([...ta, ...tb])];
  if (t.includes('integer') && t.includes('number')) t.splice(t.indexOf('integer'), 1);
  const out: Schema = { type: t.length === 1 ? t[0] : t.sort() };
  if (a.format && a.format === b.format) out.format = a.format;
  else if ((a.format || b.format) && (!ta.includes('string') || !tb.includes('string'))) out.format = a.format ?? b.format;
  if (t.includes('array')) out.items = merge(a.items ?? null, b.items ?? {});
  if (t.includes('object')) {
    if (a.additionalProperties || b.additionalProperties) {
      const vals = [a.additionalProperties, b.additionalProperties, ...Object.values(a.properties ?? {}), ...Object.values(b.properties ?? {})].filter(Boolean) as Schema[];
      out.additionalProperties = vals.reduce<Schema | null>((acc, x) => merge(acc, x), null) ?? {};
    } else {
      const pa = a.properties ?? {}, pb = b.properties ?? {};
      out.properties = {};
      for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) out.properties[k] = pa[k] && pb[k] ? merge(pa[k], pb[k]) : (pa[k] ?? pb[k]);
      const ra = ta.includes('object') ? (a.required ?? []) : null, rb = tb.includes('object') ? (b.required ?? []) : null;
      const req = ra && rb ? ra.filter((k: string) => rb.includes(k)) : (ra ?? rb ?? []);
      if (req.length) out.required = req.sort();
    }
  }
  return out;
}

/** Records the shape of every JSON response (only when OPENAPI_CAPTURE=1). */
export function installCapture(app: FastifyInstance): void {
  if (process.env.OPENAPI_CAPTURE !== '1') return;
  let captured: Captured = {};
  try { captured = JSON.parse(readFileSync(CAPTURE_FILE, 'utf8')); } catch { /* first run */ }
  let dirty = false;
  app.addHook('onSend', async (req, reply, payload) => {
    const route = req.routeOptions?.url;
    const ct = String(reply.getHeader('content-type') ?? '');
    if (!route || !ct.includes('json') || typeof payload !== 'string' || route.includes('/docs')) return payload;
    try {
      const key = `${req.method} ${route}`;
      const status = String(reply.statusCode);
      captured[key] ??= {};
      captured[key][status] = merge(captured[key][status] ?? null, infer(JSON.parse(payload)));
      dirty = true;
    } catch { /* not JSON after all */ }
    return payload;
  });
  setInterval(() => { if (dirty) { writeFileSync(CAPTURE_FILE, JSON.stringify(captured)); dirty = false; } }, 2000).unref();
}

/**
 * The committed responses of the running service: services/<name>/openapi-responses.json, plus
 * openapi-responses.manual.json for success responses the tests cannot reach without spoiling demo data
 * (e.g. renewing a registration that is not due). A manual entry is a schema, or {"same_as": "[service:]ROUTE STATUS"}
 * pointing at an identical observed response (another service's file when prefixed).
 */
export function loadCaptured(): Captured {
  const dir = join(dirname(process.argv[1] ?? '.'), '..');
  const read = (f: string): Captured => { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; } catch { return {}; } };
  const captured = read(join(dir, 'openapi-responses.json'));
  for (const [route, statuses] of Object.entries(read(join(dir, 'openapi-responses.manual.json')))) {
    for (const [status, s] of Object.entries(statuses)) {
      let schema: Schema | undefined = s;
      if (typeof s.same_as === 'string') {
        const m = /^(?:([\w-]+):)?([A-Z]+ \S+) (\d{3})$/.exec(s.same_as);
        const src = m?.[1] ? read(join(dir, '..', m[1], 'openapi-responses.json')) : captured;
        schema = m ? src[m[2]!]?.[m[3]!] : undefined;
      }
      if (schema) (captured[route] ??= {})[status] = schema;
    }
  }
  return captured;
}

const STATUS_TEXT: Record<string, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 400: 'Bad request', 401: 'Not signed in / sign-in required', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 410: 'Gone', 422: 'Validation failed', 423: 'Locked', 429: 'Too many requests', 502: 'Upstream error', 503: 'Unavailable' };

/** For @fastify/swagger's `transform`: adds observed responses where the route has no hand-written ones. */
export function responsesTransform(captured: Captured) {
  return ({ schema, url, route }: { schema: any; url: string; route: any }) => {
    const methods: string[] = Array.isArray(route?.method) ? route.method : [route?.method];
    const observed = methods.map((m) => captured[`${m} ${route?.url ?? url}`]).find(Boolean);
    if (!observed || schema?.hide) return { schema, url };
    const response: Record<string, any> = { ...(schema?.response ?? {}) };
    for (const [status, s] of Object.entries(observed)) {
      if (response[status]) continue;
      response[status] = { description: `${STATUS_TEXT[status] ?? 'Response'} (shape observed in the test suites)`, ...s };
    }
    return { schema: { ...schema, response }, url };
  };
}
