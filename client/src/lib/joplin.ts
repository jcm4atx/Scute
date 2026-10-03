// Two-way sync between a Scute space and a Joplin Server account.
//
// Scute speaks Joplin's own sync protocol (sync target version 3), the same one
// the Joplin desktop and mobile apps use, so Scute is just another Joplin client:
//   notebooks  <-> boards (nested)
//   notes      <-> notes (Markdown), to-dos keep their Joplin state
//   tags       <-> tags
//   resources  <-> rendered inline; Scute image/video/file notes upload as resources
// Joplin ids are 32 hex chars and Scute ids are UUIDs, so a Scute id is simply the
// Joplin id with dashes. That makes the mapping stable across devices without
// storing a lookup table anywhere.
import type { Board, Note, Space } from "./vault";
import type { BoardData, JoplinConfig, JoplinLink, NoteData } from "@shared/schema";
import { API_BASE } from "./queryClient";
import { getToken } from "./api";
import { idbGet, idbSet, idbDel } from "./idb";

// ---------------------------------------------------------------- ids & formats
export const hexOf = (id: string) => id.replace(/-/g, "").toLowerCase();
export const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
const randHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const iso = (ms: number) => new Date(ms || 0).toISOString();
const isHexId = (s: string) => /^[0-9a-f]{32}$/.test(s);

export const T = { NOTE: 1, FOLDER: 2, RESOURCE: 4, TAG: 5, NOTE_TAG: 6 } as const;
const TIME_FIELDS = new Set(["created_time", "updated_time", "user_created_time", "user_updated_time"]);

// Field order exactly as Joplin 3.x writes them.
const FIELDS: Record<number, string[]> = {
  [T.NOTE]: ["id", "parent_id", "created_time", "updated_time", "is_conflict", "latitude", "longitude", "altitude", "author", "source_url", "is_todo", "todo_due", "todo_completed", "source", "source_application", "application_data", "order", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "markup_language", "is_shared", "share_id", "conflict_original_id", "master_key_id", "user_data", "deleted_time", "is_locked", "extracted_resource_ids"],
  [T.FOLDER]: ["id", "created_time", "updated_time", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "parent_id", "is_shared", "share_id", "master_key_id", "icon", "user_data", "deleted_time"],
  [T.TAG]: ["id", "created_time", "updated_time", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "is_shared", "parent_id", "user_data"],
  [T.NOTE_TAG]: ["id", "note_id", "tag_id", "created_time", "updated_time", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "is_shared"],
  [T.RESOURCE]: ["id", "mime", "filename", "created_time", "updated_time", "user_created_time", "user_updated_time", "file_extension", "encryption_cipher_text", "encryption_applied", "encryption_blob_encrypted", "size", "is_shared", "share_id", "master_key_id", "user_data", "blob_updated_time", "ocr_text", "ocr_details", "ocr_status", "ocr_error", "ocr_driver_id", "is_locked"],
};
const DEFAULTS: Record<string, string> = {
  is_conflict: "0", latitude: "0.00000000", longitude: "0.00000000", altitude: "0.0000", is_todo: "0", todo_due: "0",
  todo_completed: "0", source: "scute", source_application: "app.scute", markup_language: "1", encryption_applied: "0",
  encryption_blob_encrypted: "0", is_shared: "0", deleted_time: "0", is_locked: "0", ocr_status: "0", ocr_driver_id: "1",
};

export interface JItem {
  type_: number;
  title?: string;
  body?: string;
  props: Record<string, string>; // raw serialized values (times as ISO strings)
}

const escapeProp = (v: string) => v.replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const unescapeProp = (v: string) => v.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\n/g, "\\n").replace(/\\\r/g, "\\r");

/** Parse a Joplin item file (the same algorithm as BaseItem.unserialize). */
export function parseItem(content: string): JItem {
  const lines = content.split("\n");
  const props: Record<string, string> = {};
  let body: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") {
      body = lines.slice(0, i);
      break;
    }
    const p = line.indexOf(":");
    if (p < 0) throw new Error(`Invalid Joplin property line: ${line.slice(0, 60)}`);
    props[line.slice(0, p).trim()] = unescapeProp(line.slice(p + 1).trim());
  }
  // keep the original key order (bottom-up loop reversed it)
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(props).reverse()) ordered[k] = props[k];
  const type_ = Number(ordered.type_);
  if (!type_) throw new Error("Joplin item has no type_");
  const out: JItem = { type_, props: ordered };
  if (body.length) {
    out.title = body[0];
    if (type_ === T.NOTE) out.body = body.slice(2).join("\n");
  }
  return out;
}

/** Serialize a Joplin item (the same layout as BaseItem.serialize). */
export function serializeItem(it: JItem): string {
  const keys = FIELDS[it.type_] || Object.keys(it.props);
  const extra = Object.keys(it.props).filter((k) => k !== "type_" && !keys.includes(k));
  const props = [...keys, ...extra].map((k) => `${k}: ${escapeProp(it.props[k] ?? DEFAULTS[k] ?? "")}`);
  props.push(`type_: ${it.type_}`);
  const parts: string[] = [];
  if (it.type_ !== T.NOTE_TAG) parts.push((it.title || "").replace(/[\r\n]+/g, " "));
  if (it.type_ === T.NOTE && it.body) parts.push(it.body);
  parts.push(props.join("\n"));
  return parts.join("\n\n");
}

export const timeOf = (it: JItem, k = "updated_time") => {
  const v = it.props[k];
  if (!v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : Number(v) || 0;
};

// ---------------------------------------------------------------- hashing
function fnv(s: string) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
export function hashNote(d: NoteData, boardId: string | null) {
  return fnv(JSON.stringify([d.type, d.title || "", d.text || "", d.url || "", [...(d.tags || [])].sort(), boardId ? hexOf(boardId) : ""]));
}
export function hashBoard(d: BoardData) {
  return fnv(JSON.stringify([d.title || "", d.parentId ? hexOf(d.parentId) : ""]));
}
export const syncableNote = (n: Note) => ["text", "link", "image", "video", "file"].includes(n.data.type);
export const noteChanged = (n: Note) => !n.data.joplin || hashNote(n.data, n.boardId) !== n.data.joplin.hash;

// ---------------------------------------------------------------- HTTP via the Scute relay
export class JoplinError extends Error {
  constructor(message: string, public status = 0, public code = "") {
    super(message);
  }
}
const sessions = new Map<string, Promise<string>>();
const skey = (c: JoplinConfig) => `${c.url}\n${c.email}`;
export const normUrl = (u: string) => u.trim().replace(/\/+$/, "");

async function rawRequest(c: JoplinConfig, method: string, path: string, opts: { session?: string; json?: unknown; bytes?: BodyInit; query?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "X-Joplin-Url": normUrl(c.url) };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (opts.session) headers["X-API-AUTH"] = opts.session;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.bytes !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = opts.bytes;
  }
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/joplin/${path}${qs}`, { method, headers, body, cache: "no-store" });
  } catch (e) {
    throw new JoplinError(`Can't reach Scute: ${(e as Error).message}`);
  }
  const fromJoplin = res.headers.has("X-Joplin-Status");
  if (!res.ok) {
    let msg = res.statusText, code = "";
    try {
      const j = await res.clone().json();
      msg = j.error || j.message || msg;
      code = String(j.code ?? "");
    } catch {
      const t = await res.text().catch(() => "");
      if (t) msg = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || msg;
    }
    if (!fromJoplin && res.status === 401) msg = "Your Scute session expired. Sign in again.";
    throw new JoplinError(msg, res.status, code);
  }
  return res;
}

async function session(c: JoplinConfig, fresh = false): Promise<string> {
  const k = skey(c);
  if (fresh) sessions.delete(k);
  let p = sessions.get(k);
  if (!p) {
    p = (async () => {
      try {
        const r = await rawRequest(c, "POST", "api/sessions", { json: { email: c.email, password: c.password } });
        const j = await r.json();
        if (!j?.id) throw new JoplinError("Joplin Server didn't return a session");
        return j.id as string;
      } catch (e) {
        const err = e as JoplinError;
        if (err.status === 403 || err.status === 401) throw new JoplinError("Joplin Server rejected that email or password.", err.status);
        if (err.status === 404) throw new JoplinError("That URL doesn't look like a Joplin Server (no /api/sessions).", 404);
        throw err;
      }
    })();
    sessions.set(k, p);
    p.catch(() => sessions.delete(k));
  }
  return p;
}

/** Authenticated call with one automatic re-login on an expired session. */
async function call(c: JoplinConfig, method: string, path: string, opts: { json?: unknown; bytes?: BodyInit; query?: Record<string, string> } = {}) {
  let s = await session(c);
  try {
    return await rawRequest(c, method, path, { ...opts, session: s });
  } catch (e) {
    const err = e as JoplinError;
    if (err.status === 403 && /session/i.test(err.message)) {
      s = await session(c, true);
      return rawRequest(c, method, path, { ...opts, session: s });
    }
    throw e;
  }
}
const itemPath = (name: string) => `api/items/root:/${name}:`;

async function getText(c: JoplinConfig, name: string): Promise<string | null> {
  try {
    const r = await call(c, "GET", `${itemPath(name)}/content`);
    return await r.text();
  } catch (e) {
    if ((e as JoplinError).status === 404) return null;
    throw e;
  }
}
async function putContent(c: JoplinConfig, name: string, content: string | Blob) {
  const r = await call(c, "PUT", `${itemPath(name)}/content`, { bytes: content });
  return r.json().catch(() => ({}));
}
async function deleteItem(c: JoplinConfig, name: string) {
  try {
    await call(c, "DELETE", itemPath(name));
  } catch (e) {
    if ((e as JoplinError).status !== 404) throw e;
  }
}

// Joplin's own info.json for a freshly created (empty) sync target.
const FRESH_INFO = {
  version: 3,
  e2ee: { value: false, updatedTime: 0 },
  activeMasterKeyId: { value: "", updatedTime: 0 },
  masterKeys: [],
  noteLockKey: null,
  ppk: { value: null, updatedTime: 0 },
  appMinVersion: "3.7.0",
  revisionServiceEnabled: { value: true, updatedTime: 0 },
  revisionServiceTtlDays: { value: 90, updatedTime: 0 },
};

async function checkTarget(c: JoplinConfig, allowInit: boolean): Promise<{ fresh: boolean }> {
  const txt = await getText(c, "info.json");
  if (txt === null) {
    const old = await getText(c, ".sync/version.txt");
    if (old !== null) throw new JoplinError("This Joplin account uses an old sync format. Open it once with a current Joplin app to upgrade it, then try again.");
    if (allowInit) await putContent(c, "info.json", JSON.stringify(FRESH_INFO, null, "\t"));
    return { fresh: true };
  }
  let info: any;
  try {
    info = JSON.parse(txt);
  } catch {
    throw new JoplinError("Joplin Server's info.json is unreadable.");
  }
  if (Number(info.version) !== 3) throw new JoplinError(`Unsupported Joplin sync version ${info.version} (Scute speaks version 3).`);
  if (info.e2ee?.value) throw new JoplinError("End-to-end encryption is turned on in Joplin for this account. Scute can't read Joplin-encrypted notes, so turn it off in Joplin (Settings → Encryption) or use a separate account.");
  return { fresh: false };
}

/** Log in and check the sync target without changing anything. */
export async function testConnection(c: JoplinConfig): Promise<{ fresh: boolean; items: number }> {
  sessions.delete(skey(c));
  const { fresh } = await checkTarget(c, false);
  const r = await call(c, "GET", `${itemPath("")}/children`, { query: { limit: "100" } });
  const j = await r.json();
  const items = (j.items || []).filter((x: any) => /^[0-9a-f]{32}\.md$/.test(x.name)).length;
  return { fresh, items: j.has_more ? Math.max(items, 100) : items };
}

// ---------------------------------------------------------------- resources (rendered inline)
const resUrls = new Map<string, Promise<{ url: string; mime: string; name: string }>>();
function sniffMime(b: Uint8Array): string | null {
  const h = (n: number) => Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, "0")).join("");
  if (h(3) === "ffd8ff") return "image/jpeg";
  if (h(8) === "89504e470d0a1a0a") return "image/png";
  if (h(4) === "47494638") return "image/gif";
  if (h(4) === "52494646" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (h(4) === "25504446") return "application/pdf";
  if (String.fromCharCode(...b.slice(4, 8)) === "ftyp") return "video/mp4";
  return null;
}

// Limit parallel attachment downloads so a grid full of photos doesn't flood the relay.
let resActive = 0;
const resQueue: (() => void)[] = [];
async function resSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (resActive >= 4) await new Promise<void>((r) => resQueue.push(r));
  resActive++;
  try {
    return await fn();
  } finally {
    resActive--;
    resQueue.shift()?.();
  }
}

export function fetchResource(c: JoplinConfig, rawId: string): Promise<{ url: string; mime: string; name: string }> {
  const rid = (/[0-9a-fA-F]{32}/.exec(rawId || "")?.[0] || rawId || "").toLowerCase();
  const k = `${normUrl(c.url)}|${rid}`;
  let p = resUrls.get(k);
  if (!p) {
    p = resSlot(async () => {
      if (!isHexId(rid)) throw new JoplinError("Not a Joplin attachment link");
      let mime = "application/octet-stream", name = rid;
      const meta = await getText(c, `${rid}.md`);
      if (meta) {
        try {
          const it = parseItem(meta);
          mime = it.props.mime || mime;
          name = it.title || (it.props.file_extension ? `${rid}.${it.props.file_extension}` : rid);
        } catch {
          /* ignore */
        }
      }
      let r: Response;
      try {
        r = await call(c, "GET", `${itemPath(`.resource/${rid}`)}/content`);
      } catch (e) {
        const err = e as JoplinError;
        if (err.status === 404) throw new JoplinError(meta ? "The file hasn't been uploaded to Joplin Server yet. Sync the Joplin app that added it." : "This attachment isn't on the Joplin Server.", 404);
        throw err;
      }
      const buf = await r.arrayBuffer();
      if (mime === "application/octet-stream") mime = sniffMime(new Uint8Array(buf.slice(0, 16))) || r.headers.get("content-type")?.split(";")[0] || mime;
      const blob = new Blob([buf], { type: mime });
      return { url: URL.createObjectURL(blob), mime, name };
    });
    resUrls.set(k, p);
    p.catch(() => resUrls.delete(k));
  }
  return p;
}

/** A Joplin attachment as a File (used when a note moves out of a Joplin space). */
export async function resourceFile(c: JoplinConfig, rawId: string): Promise<File> {
  const r = await fetchResource(c, rawId);
  const blob = await (await fetch(r.url)).blob();
  let name = r.name || rawId;
  if (!/\.[A-Za-z0-9]{1,10}$/.test(name)) {
    const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "application/pdf": "pdf" } as Record<string, string>)[r.mime];
    if (ext) name = `${name}.${ext}`;
  }
  return new File([blob], name, { type: r.mime });
}

// ---------------------------------------------------------------- local cache (per device)
interface CItem {
  t: number; // type
  u: number; // updated_time ms
  p?: string; // parent_id (notes, folders)
  d?: 1; // in Joplin's trash
  title?: string; // tags
  n?: string; // note_tag -> note id
  g?: string; // note_tag -> tag id
}
interface Cache {
  key: string;
  cursor: string | null;
  items: Record<string, CItem>;
  lastSync?: number;
}
const cacheKey = (userId: string, spaceId: string) => `joplin:${userId}:${spaceId}`;
export async function readCache(userId: string, spaceId: string) {
  return idbGet<Cache>(cacheKey(userId, spaceId));
}
export async function forgetCache(userId: string, spaceId: string) {
  await idbDel(cacheKey(userId, spaceId));
}

// ---------------------------------------------------------------- sync
export interface SyncDeps {
  userId: string;
  space: Space;
  boards: Board[];
  notes: Note[];
  tombstones: () => Promise<{ notes: string[]; boards: string[] }>;
  saveBoard: (spaceId: string, data: BoardData, id?: string) => Promise<string>;
  deleteBoard: (id: string) => Promise<unknown>;
  saveNotesBulk: (spaceId: string, items: { id: string; boardId?: string | null; data: NoteData }[]) => Promise<void>;
  deleteNote: (id: string) => Promise<unknown>;
  fileBlob: (note: Note) => Promise<Blob>;
  /** Current space of a note in the live vault (null if gone), to avoid re-saving notes moved or deleted mid-sync. */
  liveSpaceOf?: (id: string) => string | null;
  onProgress?: (msg: string) => void;
}
export interface SyncResult {
  pulled: number;
  pushed: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  skipped: number;
  errors: string[];
  at: number;
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k], k);
      }
    }),
  );
}

const running = new Map<string, Promise<SyncResult>>();
/** Run a sync for one space; concurrent calls share the same run. */
export function syncJoplinSpace(deps: SyncDeps): Promise<SyncResult> {
  const k = deps.space.id;
  let p = running.get(k);
  if (!p) {
    p = runSync(deps).finally(() => running.delete(k));
    running.set(k, p);
  }
  return p;
}
export const isSyncing = (spaceId: string) => running.has(spaceId);

function noteFromRemote(it: JItem, local: Note | undefined, tags: string[]): { data: NoteData; boardId: string | null } {
  const u = timeOf(it);
  const props = { ...it.props };
  delete props.id;
  delete props.type_;
  const parent = it.props.parent_id || "";
  const boardId = isHexId(parent) ? uuidOf(parent) : null;
  const link: JoplinLink = { updated: u, hash: "", props };
  let text = it.body || "";
  let type: NoteData["type"] = "text";
  let url: string | undefined = it.props.source_url || undefined;
  if (local && ["image", "video", "file", "link"].includes(local.data.type)) {
    type = local.data.type;
    if (local.data.joplin?.resId) {
      link.resId = local.data.joplin.resId;
      const re = new RegExp(`\\n*!?\\[[^\\]]*\\]\\(:/${local.data.joplin.resId}\\)\\s*$`);
      text = text.replace(re, "");
    }
  }
  if (type !== "link") url = local?.data.url || url;
  else if (url) {
    // bookmarks are sent with the URL as the first line so Joplin users can see it
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^<${esc}>\\s*`), "");
  }
  const data: NoteData = {
    ...(local?.data || {}),
    type,
    title: it.title || "",
    text,
    url,
    tags,
    created: timeOf(it, "user_created_time") || timeOf(it, "created_time") || u,
    modified: timeOf(it, "user_updated_time") || u,
    joplin: link,
  } as NoteData;
  if (!url) delete data.url;
  data.joplin!.hash = hashNote(data, boardId);
  return { data, boardId };
}

async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const cfg = deps.space.data.joplin;
  if (!cfg?.url || !cfg.email) throw new JoplinError("Set up the Joplin Server connection first.");
  const say = deps.onProgress || (() => {});
  const res: SyncResult = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0, errors: [], at: Date.now() };
  const spaceId = deps.space.id;
  const hadLocally = new Set(deps.notes.map((n) => n.id));
  // A note may be moved to another space or deleted while this sync runs; never bring it back.
  const saveGuarded = async (items: { id: string; boardId?: string | null; data: NoteData }[]) => {
    let gone = new Set<string>();
    try {
      gone = new Set((await deps.tombstones()).notes);
    } catch {
      /* keep going */
    }
    const keep = items.filter((it) => {
      if (gone.has(it.id) && hadLocally.has(it.id)) return false; // deleted since this sync started
      if (!deps.liveSpaceOf) return true;
      const where = deps.liveSpaceOf(it.id);
      if (where && where !== spaceId) return false;
      if (where === null && hadLocally.has(it.id)) return false;
      return true;
    });
    if (keep.length) await deps.saveNotesBulk(spaceId, keep);
  };
  const ck = `${normUrl(cfg.url)}|${cfg.email.toLowerCase()}`;
  let cache = (await readCache(deps.userId, spaceId)) || null;
  if (!cache || cache.key !== ck) cache = { key: ck, cursor: null, items: {} };

  say("Connecting to Joplin Server…");
  await checkTarget(cfg, true);

  // Polite Joplin client: take a sync lock, refuse while another client holds an exclusive one.
  const clientId = hexOf(deps.userId).slice(0, 16) + hexOf(spaceId).slice(0, 16);
  const locks = await (await call(cfg, "GET", "api/locks")).json().catch(() => ({ items: [] }));
  if ((locks.items || []).some((l: any) => Number(l.type) === 2))
    throw new JoplinError("A Joplin app is upgrading this sync target right now. Try again in a few minutes.");
  const lock = () => call(cfg, "POST", "api/locks", { json: { type: 1, clientType: 1, clientId } });
  await lock();
  const refresh = setInterval(() => void lock().catch(() => {}), 60_000);

  try {
    // ------------------------------------------------ pull
    say("Checking Joplin for changes…");
    const fetched = new Map<string, JItem>();
    const removed = new Map<string, CItem>();
    const prev: Record<string, CItem | undefined> = {};
    const toFetch = new Set<string>();
    let cursor = cache.cursor;
    for (let guard = 0; guard < 10000; guard++) {
      let j: any;
      try {
        j = await (await call(cfg, "GET", `${itemPath("")}/delta`, { query: cursor ? { cursor } : {} })).json();
      } catch (e) {
        if (cursor && ((e as JoplinError).code === "resyncRequired" || (e as JoplinError).status === 400)) {
          cursor = null;
          continue;
        }
        throw e;
      }
      for (const ch of j.items || []) {
        const name: string = ch.item_name || "";
        if (!/^[0-9a-f]{32}\.md$/.test(name)) continue;
        const jid = name.slice(0, 32);
        if (Number(ch.type) === 3) {
          toFetch.delete(jid);
          if (cache.items[jid]) removed.set(jid, cache.items[jid]);
          continue;
        }
        removed.delete(jid);
        const c = cache.items[jid];
        if (c && ch.jop_updated_time && c.u === Number(ch.jop_updated_time)) continue;
        toFetch.add(jid);
      }
      cursor = j.cursor || cursor;
      if (!j.has_more) break;
    }
    let n = 0;
    const ids = [...toFetch];
    await pool(ids, 6, async (jid) => {
      try {
        const txt = await getText(cfg, `${jid}.md`);
        if (txt === null) return;
        const it = parseItem(txt);
        if (it.props.encryption_applied === "1") {
          res.skipped++;
          return;
        }
        fetched.set(jid, it);
      } catch (e) {
        res.errors.push(`Read ${jid}: ${(e as Error).message}`);
      }
      if (++n % 25 === 0) say(`Downloading from Joplin… ${n}/${ids.length}`);
    });
    for (const [jid, it] of fetched) {
      prev[jid] = cache.items[jid];
      const c: CItem = { t: it.type_, u: timeOf(it) };
      if (it.props.parent_id) c.p = it.props.parent_id;
      if (Number(it.props.deleted_time || 0) > 0) c.d = 1;
      if (it.type_ === T.TAG) c.title = it.title || "";
      if (it.type_ === T.NOTE_TAG) {
        c.n = it.props.note_id;
        c.g = it.props.tag_id;
      }
      cache.items[jid] = c;
    }
    for (const jid of removed.keys()) delete cache.items[jid];

    const tagTitle = (tid: string) => {
      const t = cache!.items[tid];
      return t && t.t === T.TAG && !t.d ? (t.title || "").trim().toLowerCase() : null;
    };
    const remoteTags = (nid: string) =>
      [...new Set(Object.values(cache!.items).filter((x) => x.t === T.NOTE_TAG && x.n === nid).map((x) => tagTitle(x.g!)).filter((x): x is string => !!x))].sort();

    const tomb = await deps.tombstones();
    const tombNotes = new Set(tomb.notes);
    const tombBoards = new Set(tomb.boards);
    const boards = new Map(deps.boards.map((b) => [b.id, b]));
    const notes = new Map(deps.notes.map((x) => [x.id, x]));

    // folders first, parents before children
    const depth = (jid: string) => {
      let d = 0, p = cache!.items[jid]?.p;
      while (p && isHexId(p) && d < 50) {
        d++;
        p = cache!.items[p]?.p;
      }
      return d;
    };
    const folderIds = [...fetched.entries()].filter(([, it]) => it.type_ === T.FOLDER).map(([id]) => id).sort((a, b) => depth(a) - depth(b));
    for (const jid of folderIds) {
      const it = fetched.get(jid)!;
      const bid = uuidOf(jid);
      const local = boards.get(bid);
      if (Number(it.props.deleted_time || 0) > 0) {
        if (local) {
          await deps.deleteBoard(bid);
          boards.delete(bid);
          res.deletedLocal++;
        }
        continue;
      }
      if (!local && tombBoards.has(bid) && !prev[jid]) continue; // deleted in Scute: push trashes it
      const parent = it.props.parent_id && isHexId(it.props.parent_id) ? uuidOf(it.props.parent_id) : null;
      const props = { ...it.props };
      delete props.id;
      delete props.type_;
      const data: BoardData = { title: it.title || "Untitled", parentId: parent, joplin: { updated: timeOf(it), hash: "", props } };
      data.joplin!.hash = hashBoard(data);
      await deps.saveBoard(spaceId, data, bid);
      boards.set(bid, { id: bid, spaceId, data });
      res.pulled++;
    }
    for (const [jid, c] of removed) {
      if (c.t !== T.FOLDER) continue;
      const bid = uuidOf(jid);
      if (boards.has(bid)) {
        await deps.deleteBoard(bid);
        boards.delete(bid);
        res.deletedLocal++;
      }
    }

    // notes touched directly, through a note_tag, or through a renamed tag
    const touched = new Set<string>();
    for (const [jid, it] of fetched) {
      if (it.type_ === T.NOTE) touched.add(jid);
      if (it.type_ === T.NOTE_TAG && it.props.note_id) touched.add(it.props.note_id);
      if (it.type_ === T.TAG) for (const x of Object.values(cache.items)) if (x.t === T.NOTE_TAG && x.g === jid && x.n) touched.add(x.n);
    }
    for (const [jid, c] of removed) {
      if (c.t === T.NOTE) touched.add(jid);
      if (c.t === T.NOTE_TAG && c.n) touched.add(c.n);
    }
    const saves: { id: string; boardId: string | null; data: NoteData }[] = [];
    const restore = new Set<string>(); // trashed in Joplin but edited in Scute: push back
    for (const jid of touched) {
      if (!isHexId(jid)) continue;
      const id = uuidOf(jid);
      const local = notes.get(id);
      const it = fetched.get(jid);
      const gone = removed.has(jid) && removed.get(jid)!.t === T.NOTE;
      if (gone || (it && it.type_ === T.NOTE && Number(it.props.deleted_time || 0) > 0)) {
        if (!local) continue;
        if (noteChanged(local)) restore.add(id);
        else {
          await deps.deleteNote(id);
          notes.delete(id);
          res.deletedLocal++;
        }
        continue;
      }
      if (it && it.type_ !== T.NOTE) continue;
      if (it && it.props.is_conflict === "1") continue; // Joplin's own conflict copies stay in Joplin
      const tags = remoteTags(jid);
      if (!it) {
        // tag change only
        const c = cache.items[jid];
        if (!local || !c || c.t !== T.NOTE || c.d || noteChanged(local)) continue;
        if (JSON.stringify([...local.data.tags].sort()) === JSON.stringify(tags)) continue;
        const data = { ...local.data, tags };
        data.joplin = { ...local.data.joplin!, hash: hashNote(data, local.boardId) };
        saves.push({ id, boardId: local.boardId, data });
        notes.set(id, { ...local, data });
        res.pulled++;
        continue;
      }
      if (!local && tombNotes.has(id) && !prev[jid]) continue; // deleted in Scute: push trashes it
      const same = local && noteFromRemote(it, local, tags).data.joplin!.hash === hashNote(local.data, local.boardId);
      if (local && same) {
        // content already matches (e.g. our own earlier upload): just adopt Joplin's version info
      } else if (local && noteChanged(local) && local.data.joplin?.updated !== timeOf(it)) {
        // edited on both sides: Joplin's version wins the note, Scute's edit is kept as a copy
        const copyId = crypto.randomUUID();
        const cd: NoteData = { ...local.data, title: `${local.data.title || "Untitled"} (conflict copy)`, joplin: undefined, modified: Date.now() };
        if (["image", "video", "file"].includes(cd.type)) cd.type = "text";
        delete cd.file;
        delete cd.thumb;
        saves.push({ id: copyId, boardId: local.boardId, data: cd });
        notes.set(copyId, { ...local, id: copyId, data: cd });
        res.conflicts++;
      } else if (local && noteChanged(local) && local.data.joplin?.updated === timeOf(it)) {
        continue; // only Scute changed; push handles it
      }
      const { data, boardId } = noteFromRemote(it, local, tags);
      const bid = boardId && boards.has(boardId) ? boardId : null;
      saves.push({ id, boardId: bid, data });
      notes.set(id, { ...(local || ({ id, spaceId, key: null as any, fileSize: null } as unknown as Note)), boardId: bid, data });
      res.pulled++;
    }
    if (saves.length) {
      say(`Saving ${saves.length} note${saves.length === 1 ? "" : "s"} from Joplin…`);
      await saveGuarded(saves);
    }

    // ------------------------------------------------ push
    const now = Date.now();
    const liveRemote = (jid: string, t: number) => cache!.items[jid] && cache!.items[jid].t === t && !cache!.items[jid].d;
    const trash = async (jid: string) => {
      const txt = await getText(cfg, `${jid}.md`);
      if (!txt) return;
      const it = parseItem(txt);
      it.props.deleted_time = String(now);
      it.props.updated_time = iso(now);
      await putContent(cfg, `${jid}.md`, serializeItem(it));
      cache!.items[jid] = { ...cache!.items[jid], u: now, d: 1 };
      res.deletedRemote++;
    };
    for (const id of tombNotes) {
      const jid = hexOf(id);
      if (!notes.has(id) && liveRemote(jid, T.NOTE)) {
        try {
          await trash(jid);
        } catch (e) {
          res.errors.push(`Trash note: ${(e as Error).message}`);
        }
      }
    }

    // Boards (and the default notebook for notes that aren't on a board)
    const spaceNotes = [...notes.values()].filter((x) => x.spaceId === spaceId && syncableNote(x));
    // notes with attachments first, so other notes can point at their resources
    const pushNotes = spaceNotes.filter((x) => noteChanged(x) || restore.has(x.id)).sort((a, b) => Number(!!b.data.file) - Number(!!a.data.file));
    // Scute notes may embed another note's attachment as ":/<that note's id>" (e.g. after a
    // note with several photos moved in from another space); Joplin needs the resource id.
    const resOfNote = new Map<string, string>();
    for (const x of spaceNotes) if (x.data.file && x.data.joplin?.resId) resOfNote.set(hexOf(x.id), x.data.joplin.resId);
    const defaultBid = spaceId; // Joplin id of the default notebook = the space id
    if (pushNotes.some((x) => !x.boardId || !boards.has(x.boardId)) && !boards.has(defaultBid)) {
      const data: BoardData = { title: deps.space.data.title || "Scute", parentId: null };
      await deps.saveBoard(spaceId, data, defaultBid);
      boards.set(defaultBid, { id: defaultBid, spaceId, data });
    }
    const bdepth = (b: Board) => {
      let d = 0, p = b.data.parentId;
      while (p && d < 50) {
        d++;
        p = boards.get(p)?.data.parentId;
      }
      return d;
    };
    const pushBoards = [...boards.values()].filter((b) => !b.data.joplin || hashBoard(b.data) !== b.data.joplin.hash).sort((a, b) => bdepth(a) - bdepth(b));
    for (const b of pushBoards) {
      try {
        const jid = hexOf(b.id);
        const props: Record<string, string> = { ...(b.data.joplin?.props || {}) };
        const parent = b.data.parentId && boards.has(b.data.parentId) ? hexOf(b.data.parentId) : "";
        Object.assign(props, {
          id: jid,
          parent_id: parent,
          created_time: props.created_time || iso(now),
          user_created_time: props.user_created_time || iso(now),
          updated_time: iso(now),
          user_updated_time: iso(now),
          deleted_time: "0",
        });
        await putContent(cfg, `${jid}.md`, serializeItem({ type_: T.FOLDER, title: b.data.title || "Untitled", props }));
        cache.items[jid] = { t: T.FOLDER, u: now, p: parent || undefined };
        const data: BoardData = { ...b.data, joplin: { updated: now, hash: "", props: Object.fromEntries(Object.entries(props).filter(([k]) => k !== "id")) } };
        data.joplin!.hash = hashBoard(data);
        await deps.saveBoard(spaceId, data, b.id);
        boards.set(b.id, { ...b, data });
        res.pushed++;
      } catch (e) {
        res.errors.push(`Notebook “${b.data.title}”: ${(e as Error).message}`);
      }
    }
    for (const id of tombBoards) {
      const jid = hexOf(id);
      if (!boards.has(id) && liveRemote(jid, T.FOLDER)) {
        try {
          await trash(jid);
        } catch (e) {
          res.errors.push(`Trash notebook: ${(e as Error).message}`);
        }
      }
    }

    // Tags: Joplin tags are shared across notes; find by title, create when missing.
    const tagByTitle = new Map<string, string>();
    for (const [jid, c] of Object.entries(cache.items)) if (c.t === T.TAG && !c.d) tagByTitle.set((c.title || "").trim().toLowerCase(), jid);
    const ensureTag = async (title: string) => {
      const hit = tagByTitle.get(title);
      if (hit) return hit;
      const jid = randHex();
      const props: Record<string, string> = { id: jid, created_time: iso(now), updated_time: iso(now), user_created_time: iso(now), user_updated_time: iso(now), parent_id: "" };
      await putContent(cfg, `${jid}.md`, serializeItem({ type_: T.TAG, title, props }));
      cache!.items[jid] = { t: T.TAG, u: now, title };
      tagByTitle.set(title, jid);
      return jid;
    };

    const updates: { id: string; boardId: string | null; data: NoteData }[] = [];
    let done = 0;
    for (const x of pushNotes) {
      try {
        const jid = hexOf(x.id);
        const bid = x.boardId && boards.has(x.boardId) ? x.boardId : defaultBid;
        const d = x.data;
        const link: JoplinLink = { updated: now, hash: "", props: {}, resId: d.joplin?.resId };
        // attachments become Joplin resources (uploaded once)
        if (["image", "video", "file", "link"].includes(d.type) && d.file && !link.resId) {
          const rid = randHex();
          const blob = await deps.fileBlob(x);
          await putContent(cfg, `.resource/${rid}`, blob);
          const ext = (d.file.name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1] || "").toLowerCase();
          const rprops: Record<string, string> = {
            id: rid, mime: d.file.type || "application/octet-stream", filename: "", created_time: iso(now), updated_time: iso(now),
            user_created_time: iso(now), user_updated_time: iso(now), file_extension: ext, size: String(blob.size), blob_updated_time: String(now),
          };
          await putContent(cfg, `${rid}.md`, serializeItem({ type_: T.RESOURCE, title: d.file.name, props: rprops }));
          cache.items[rid] = { t: T.RESOURCE, u: now };
          link.resId = rid;
        }
        if (link.resId && d.file) resOfNote.set(jid, link.resId);
        let body = (d.text || "").replace(/(:\/)([0-9a-fA-F]{32})/g, (m, pre, h) => (resOfNote.has(h.toLowerCase()) ? pre + resOfNote.get(h.toLowerCase()) : m));
        if (link.resId && d.file) {
          const label = d.file.name.replace(/[[\]]/g, "");
          const embed = d.type === "file" || d.type === "link" ? `[${label}](:/${link.resId})` : `![${label}](:/${link.resId})`;
          body = body ? `${body}\n\n${embed}` : embed;
        }
        if (d.type === "link" && d.url) body = body ? `<${d.url}>\n\n${body}` : `<${d.url}>`;
        const props: Record<string, string> = { ...(d.joplin?.props || {}) };
        Object.assign(props, {
          id: jid,
          parent_id: hexOf(bid),
          created_time: props.created_time || iso(d.created || now),
          user_created_time: props.user_created_time || iso(d.created || now),
          updated_time: iso(now),
          user_updated_time: iso(d.modified || now),
          deleted_time: "0",
          is_conflict: "0",
        });
        if (d.type === "link") props.source_url = d.url || "";
        if (!props.order) props.order = String(d.created || now);
        await putContent(cfg, `${jid}.md`, serializeItem({ type_: T.NOTE, title: d.title || (d.file?.name ?? ""), body, props }));
        cache.items[jid] = { t: T.NOTE, u: now, p: hexOf(bid) };

        // tags
        const want = new Set((d.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean));
        const have = Object.entries(cache.items).filter(([, c]) => c.t === T.NOTE_TAG && c.n === jid);
        for (const [ntid, c] of have) {
          const title = tagTitle(c.g!);
          if (title && want.has(title)) want.delete(title);
          else {
            await deleteItem(cfg, `${ntid}.md`);
            delete cache.items[ntid];
          }
        }
        for (const title of want) {
          const tid = await ensureTag(title);
          const ntid = randHex();
          await putContent(cfg, `${ntid}.md`, serializeItem({ type_: T.NOTE_TAG, props: { id: ntid, note_id: jid, tag_id: tid, created_time: iso(now), updated_time: iso(now), user_created_time: iso(now), user_updated_time: iso(now) } }));
          cache.items[ntid] = { t: T.NOTE_TAG, u: now, n: jid, g: tid };
        }

        delete props.id;
        link.props = props;
        const data: NoteData = { ...d, joplin: link };
        link.hash = hashNote(data, bid);
        updates.push({ id: x.id, boardId: bid, data });
        res.pushed++;
      } catch (e) {
        res.errors.push(`“${x.data.title || "Untitled"}”: ${(e as Error).message}`);
      }
      if (++done % 10 === 0) say(`Sending to Joplin… ${done}/${pushNotes.length}`);
    }
    if (updates.length) await saveGuarded(updates);

    cache.cursor = cursor;
    cache.lastSync = Date.now();
    await idbSet(cacheKey(deps.userId, spaceId), cache);
    res.at = Date.now();
    return res;
  } finally {
    clearInterval(refresh);
    await call(cfg, "DELETE", `api/locks/1_1_${clientId}`).catch(() => {});
  }
}
