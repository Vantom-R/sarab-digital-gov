// Thin client for the public APIs. The browser authenticates with an HttpOnly session cookie.
export class ApiError extends Error {
  status: number;
  code: string;
  details?: any;
  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: opts.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const code = res.status === 429 && data?.error !== 'code_recently_sent' ? 'rate_limited' : data?.error ?? `http_${res.status}`;
    // A revoked session (signed out elsewhere, or by an administrator): tell the app to drop it.
    if (code === 'session_revoked') window.dispatchEvent(new Event('sarab:session-revoked'));
    throw new ApiError(res.status, code, data?.message ?? res.statusText, data?.details);
  }
  return data as T;
}
