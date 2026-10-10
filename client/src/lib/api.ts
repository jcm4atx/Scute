import { API_BASE } from "./queryClient";

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setToken(t: string | null) {
  token = t;
}
export function getToken() {
  return token;
}
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}
/** Told after every request whether the server could be reached, so "offline" can't get stuck. */
let onReach: ((ok: boolean) => void) | null = null;
export function setReachabilityHandler(fn: ((ok: boolean) => void) | null) {
  onReach = fn;
}
const gateway = (status: number) => status >= 502 && status <= 504;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Thrown when the request never reached the server (offline, DNS, etc). */
export class NetworkError extends Error {
  name = "NetworkError";
}

export async function api<T = any>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    payload = raw;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${url}`, { method, headers, body: payload, cache: "no-store" });
  } catch (e) {
    onReach?.(false);
    throw new NetworkError((e as Error)?.message || "Network error");
  }
  onReach?.(!gateway(res.status));
  if (res.status === 401 && token && !url.startsWith("/api/auth/")) {
    onUnauthorized?.();
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.message || msg;
    } catch {
      /* not json */
    }
    // 502/503/504 from a reverse proxy usually means the server is down: treat as offline
    if (gateway(res.status)) throw new NetworkError(`${res.status} ${msg || "from the proxy"}`.trim());
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.arrayBuffer()) as unknown as T;
}

/** GET a binary resource, reporting download progress (0..1) when the size is known. */
export async function apiDownload(url: string, onProgress?: (frac: number) => void): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${url}`, { headers, cache: "no-store" });
  } catch {
    onReach?.(false);
    throw new NetworkError("Couldn't reach your server. Try again in a moment.");
  }
  onReach?.(!gateway(res.status));
  if (res.status === 401 && token) onUnauthorized?.();
  if (!res.ok) {
    if (res.status >= 502 && res.status <= 504) throw new NetworkError(res.statusText);
    throw new ApiError(res.status, res.statusText);
  }
  const total = Number(res.headers.get("content-length") || 0);
  // A connection that drops part-way through must not hand back a short file:
  // it would fail to decrypt and look like damaged data.
  const cut = (_e?: unknown) => {
    onReach?.(false);
    return new NetworkError("The connection dropped during the download. Try again.");
  };
  try {
    if (!res.body || !onProgress || !total) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (total && !res.headers.get("content-encoding") && buf.length !== total) throw cut();
      return buf;
    }
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) {
        // server sent more than advertised (e.g. compression); fall back to growing
        const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
        bigger.set(out.subarray(0, got));
        return await finishGrow(bigger, got, value, reader, onProgress, total);
      }
      out.set(value, got);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    if (got !== out.length && !res.headers.get("content-encoding")) throw cut();
    return got === out.length ? out : out.slice(0, got);
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    throw cut(e);
  }
}

async function finishGrow(
  buf: Uint8Array,
  got: number,
  first: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onProgress: (f: number) => void,
  total: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [buf.subarray(0, got), first];
  let n = got + first.length;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onProgress(Math.min(1, n / total));
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
