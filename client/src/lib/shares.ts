// Published shares (/shared/<name>/): the upload protocol shared by plug-ins and
// Scute's own shared saved copies (1.18.0).
import { api } from "./api";
import { API_BASE } from "./queryClient";

export interface ShareInfo {
  slug: string;
  plugin: string;
  published: boolean;
  bytes: number;
  files: number;
  created: number;
  updated: number;
  expires: number | null;
  path: string;
}

/** Upload a new version of a share; `produce` is only called for files the server doesn't already have. */
export async function publishFiles(
  plugin: string,
  name: string,
  opts: { files: string[]; produce: (file: string) => Promise<Blob | Uint8Array | string>; expires?: number | null; onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
): Promise<ShareInfo> {
  const slug = encodeURIComponent(name);
  const begin = await api<{ version: string; have: string[] }>("POST", `/api/shares/${slug}/begin`, { plugin });
  const have = new Set(begin.have);
  const todo = opts.files.filter((f) => f === "share.json" || !have.has(f));
  let done = 0;
  opts.onProgress?.(0, todo.length);
  for (const f of todo) {
    if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const data = await opts.produce(f);
    const body = typeof data === "string" ? new Blob([data]) : data instanceof Blob ? data : new Blob([data as BlobPart]);
    await api("PUT", `/api/shares/${slug}/${begin.version}/${f.split("/").map(encodeURIComponent).join("/")}`, undefined, body);
    opts.onProgress?.(++done, todo.length);
  }
  const body: Record<string, unknown> = { files: opts.files };
  if (opts.expires !== undefined) body.expires = opts.expires;
  return api<ShareInfo>("POST", `/api/shares/${slug}/${begin.version}/commit`, body);
}

export const listShares = (plugin?: string) => api<{ enabled: boolean; maxMb: number; maxFileMb: number; shares: ShareInfo[] }>("GET", `/api/shares${plugin ? `?plugin=${encodeURIComponent(plugin)}` : ""}`);
export const checkShare = (name: string) => api<{ slug: string; valid: boolean; available: boolean; mine: boolean; share: ShareInfo | null }>("GET", `/api/shares/${encodeURIComponent(name)}`);
export const removeShare = (name: string) => api("DELETE", `/api/shares/${encodeURIComponent(name)}`);
export const setShareExpiry = (name: string, expires: number | null) => api<ShareInfo>("PATCH", `/api/shares/${encodeURIComponent(name)}`, { expires });
/** The public address of a share on this server. */
export const shareUrl = (slug: string) => new URL(`${API_BASE}/shared/${slug}/`, location.href).href;
