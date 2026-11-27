import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { installCapture, loadCaptured, responsesTransform } from './openapi-responses.ts';

/** The public API's major version: apps call /api/v1/<service>/… (the gateway maps it); breaking changes get /api/v2. */
export const API_VERSION = '1';

export class HttpError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const httpError = (status: number, code: string, message: string, details?: unknown) =>
  new HttpError(status, code, message, details);

export interface ServiceOptions {
  /** e.g. "identity" — public routes live under /api/<prefix>/ */
  prefix: string;
  title: string;
  description: string;
}

/** Common Fastify setup: JSON logging, cookies, OpenAPI + docs, uniform errors, health check. */
export async function createService(opts: ServiceOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: (_addr: string, hop: number) => hop < 2, // host reverse proxy -> gateway nginx -> service
    bodyLimit: 1024 * 1024,
  });

  // Keep the exact request bytes so Jisr body hashes can be verified.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      (e as any).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(swagger, {
    transform: responsesTransform(loadCaptured()) as any,
    openapi: {
      openapi: '3.1.0',
      info: { title: opts.title, description: `${opts.description}\n\nApps: call these routes as \`/api/v${API_VERSION}/<service>/…\` (e.g. \`/api/identity/session\` → \`/api/v${API_VERSION}/identity/session\`). The combined public spec is at \`/api/v${API_VERSION}/openapi.json\`. Responses marked "observed" were generated from the test suites.`, version: `${API_VERSION}.0.0` },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'sarab_session', description: 'Citizen/staff session issued by Mithaq (also accepted as Bearer token)' },
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          jisr: { type: 'apiKey', in: 'header', name: 'X-Jisr-Assertion', description: 'Signed assertion added by Jisr; /x/* routes are reachable only through Jisr' },
        },
      },
    },
  });
  installCapture(app);
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('API-Version', API_VERSION); return payload; });
  await app.register(swaggerUi, { routePrefix: `/api/${opts.prefix}/docs` });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if ((err as FastifyError).validation) {
      return reply.status(400).send({ error: 'validation_error', message: err.message });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'internal_error' : 'request_error', message: status >= 500 ? 'Internal error' : err.message });
  });

  app.get('/healthz', { schema: { hide: true }, logLevel: 'silent' }, async () => ({ ok: true }));
  return app;
}

export async function start(app: FastifyInstance): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: '0.0.0.0', port });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Reusable JSON-schema fragments for OpenAPI. */
export const S = {
  error: {
    type: 'object',
    properties: { error: { type: 'string' }, message: { type: 'string' }, details: {} },
  },
  bilingual: { type: 'object', properties: { ar: { type: 'string' }, en: { type: 'string' } } },
} as const;
