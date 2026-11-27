// docker-api — the monitor's ONLY window on Docker (replaces tecnativa/docker-socket-proxy, red-team item C).
//
// The general-purpose proxy let the ops container read every container's environment (MASTER_KEY, database
// passwords) and copy any file out of any container (GET /containers/{id}/archive). This one is written for
// exactly what ops needs and nothing more:
//   GET /_ping                                  → OK
//   GET /containers/json?all=&filters=          → the Sarab containers only: id, names, labels, state
//   GET /containers/{id}/json                   → id, name, restart count, state (health included), labels,
//                                                 image. No environment, no mounts, no command line.
//   GET /containers/{id}/stats?stream=false     → one stats sample (memory, CPU)
//   GET /containers/{id}/logs?stdout&stderr&since&until&timestamps → the logs (never "follow")
// Everything else answers 403: any other method or path (archive, export, exec, start, stop, create,
// images, volumes, networks, …), any container outside the Sarab project, and any versioned path.
// It reaches Docker through the socket (read-only mount), on a private network only ops is on.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const PROJECT = process.env.COMPOSE_PROJECT ?? 'sarab';
const PORT = Number(process.env.PORT ?? 2375);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** One request to the Docker Engine API over the socket. */
function docker(path: string): Promise<{ status: number; body: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: SOCKET, path, method: 'GET', timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 32 * 1024 * 1024) r.destroy(new Error('too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? 'application/octet-stream') }));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json'): void => void
  res.writeHead(status, { 'content-type': type }).end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
const refuse = (res: ServerResponse): void => send(res, 403, { message: 'not allowed by the Sarab docker-api proxy' });

const inProject = (labels: Record<string, string> | undefined) => labels?.['com.docker.compose.project'] === PROJECT;

/** Inspect a container and keep only what the monitor reads. Null when it is not a Sarab container. */
async function inspect(id: string): Promise<Record<string, unknown> | null> {
  const r = await docker(`/containers/${encodeURIComponent(id)}/json`);
  if (r.status !== 200) return null;
  const c = JSON.parse(r.body.toString('utf8'));
  if (!inProject(c.Config?.Labels)) return null;
  return {
    Id: c.Id, Name: c.Name, Created: c.Created, RestartCount: c.RestartCount,
    State: c.State,                                    // status, health, exit code, OOM, start time
    Config: { Labels: c.Config?.Labels ?? {}, Image: c.Config?.Image },
  };
}

function pick(q: URLSearchParams, keys: string[], fixed: Record<string, string> = {}): string {
  const out = new URLSearchParams();
  for (const k of keys) { const v = q.get(k); if (v !== null && /^[\w.:,{}\[\]"=\/-]{0,400}$/.test(v)) out.set(k, v); }
  for (const [k, v] of Object.entries(fixed)) out.set(k, v);
  return out.toString();
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res);
  const url = new URL(req.url ?? '/', 'http://docker-api');
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/_ping') return send(res, 200, 'OK', 'text/plain');

  if (url.pathname === '/containers/json') {
    const r = await docker(`/containers/json?${pick(url.searchParams, ['all', 'filters'])}`);
    if (r.status !== 200) return send(res, r.status, { message: 'docker error' });
    const list = (JSON.parse(r.body.toString('utf8')) as any[]).filter((c) => inProject(c.Labels))
      .map((c) => ({ Id: c.Id, Names: c.Names, Labels: c.Labels, State: c.State, Status: c.Status, Image: c.Image, Created: c.Created }));
    return send(res, 200, list);
  }

  if (parts.length === 3 && parts[0] === 'containers' && ID.test(parts[1]!)) {
    const info = await inspect(parts[1]!);
    if (!info) return send(res, 404, { message: 'no such container' });
    const id = String(info.Id);
    if (parts[2] === 'json') return send(res, 200, info);
    if (parts[2] === 'stats') {
      const r = await docker(`/containers/${id}/stats?stream=false&one-shot=true`);
      return send(res, r.status, r.body, r.type);
    }
    if (parts[2] === 'logs') {
      const r = await docker(`/containers/${id}/logs?${pick(url.searchParams, ['stdout', 'stderr', 'since', 'until', 'timestamps', 'tail'], { follow: '0' })}`);
      return send(res, r.status, r.body, r.type);
    }
  }
  return refuse(res);
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`docker-api: ${(e as Error).message}`);
    if (!res.headersSent) send(res, 502, { message: 'docker unreachable' });
  });
}).listen(PORT, () => console.log(`docker-api: read-only Sarab proxy on :${PORT}`));
