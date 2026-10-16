import type { Express, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { db, DATA_DIR, nextSeq, currentSeq, filePath, removeFile, ROLE_RANK, type Role } from "./storage";
import * as C from "../client/src/lib/crypto";
import { hexOf, uuidOf, randHex, iso, isHexId, T, parseItem, serializeItem, timeOf, fnv, sniffMime, type JItem } from "@shared/joplin-format";
import type { BoardData, NoteData, NotebookLinkConfig, NotebookLinkMark, SpaceData } from "@shared/schema";
import { onSpaceChange, spaceChanged, spaceEvent } from "./events";

/**
 * Joplin notebook links (1.21.0).
 *
 * An ordinary space can be paired with one notebook (and its sub-notebooks) on a
 * Joplin Server account. The server keeps the pair in sync on its own, around the
 * clock: it checks Joplin every few seconds and sends Scute changes to Joplin
 * moments after they're saved. Sub-notebooks become boards, tags stay tags, and
 * Joplin attachments become attachment notes in the space.
 *
 * To do that the server needs to read the space, so whoever links a space seals
 * the space key to the server's own key (DATA_DIR/link-key.json). Unlinking
 * deletes the server's copy. Spaces that aren't linked stay end-to-end encrypted.
 *
 * SCUTE_JOPLIN_LINKS=off (or SCUTE_JOPLIN=off) turns this off.
 */

const isOff = (v: string | undefined) => ["off", "0", "false", "no"].includes((v || "").toLowerCase());
export const LINKS_ON = !isOff(process.env.SCUTE_JOPLIN || "on") && !isOff(process.env.SCUTE_JOPLIN_LINKS || "on");
const ALLOWED = (process.env.SCUTE_JOPLIN_URLS || "")
  .split(/[\s,]+/)
  .map((x) => x.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const MAX_FILE = Number(process.env.SCUTE_MAX_UPLOAD_MB || 200) * 1024 * 1024;
export const LINK_INTERVALS = [5, 10, 30, 60, 300, 900];
const DEFAULT_INTERVAL = 10;
const AFTER_EDIT_MS = 1500;
const MASS_DELETE = 25; // more than this (and over half the notes) leaving at once pauses for a confirmation

db.exec(`
CREATE TABLE IF NOT EXISTS joplin_links (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_key TEXT NOT NULL,
  config TEXT NOT NULL,
  state TEXT,
  status TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
`);

interface LinkRow {
  id: string;
  space_id: string;
  user_id: string;
  sealed_key: string;
  config: string;
  state: string | null;
  status: string | null;
  enabled: number;
  created: number;
  updated: number;
}

/** Joplin item metadata kept between runs (the whole account, so parents can be followed). */
interface CItem {
  t: number;
  u: number; // updated_time ms
  p?: string; // parent_id
  d?: 1; // in Joplin's trash
  c?: 1; // a Joplin conflict copy
  title?: string; // tags, folders, resources (file name)
  n?: string; // note_tag -> note
  g?: string; // note_tag -> tag
  m?: string; // resource mime
  s?: number; // resource size
}
interface LinkState {
  v: 1;
  cursor: string | null;
  items: Record<string, CItem>;
  known: string[]; // linked notes present in the space after the last run
  knownRes: string[]; // attachment notes made from Joplin resources
  knownBoards: string[];
  missing: Record<string, { n: number; b: string | null }>; // resources a note points at that weren't there yet
}
export interface LinkStatus {
  phase: "starting" | "syncing" | "ok" | "error" | "paused";
  at?: number; // last run finished
  okAt?: number; // last successful run
  error?: string | null;
  code?: string; // "mass-delete" | "auth" | "notebook" | "collision"
  last?: { pulled: number; pushed: number; deleted: number; conflicts: number; files: number };
  lastAt?: number; // when "last" happened
  notes?: number;
  boards?: number;
  files?: number;
  warnings?: string[];
}

// ------------------------------------------------------------------ server key
let keyP: Promise<{ pub: string; priv: CryptoKey }> | null = null;
function linkKey() {
  if (!keyP)
    keyP = (async () => {
      const f = path.join(DATA_DIR, "link-key.json");
      const s = globalThis.crypto.subtle;
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        const priv = await s.importKey("pkcs8", Buffer.from(j.privateKey, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
        return { pub: j.publicKey as string, priv };
      }
      const kp = await C.newKeyPair();
      const pub = await C.exportPublic(kp.publicKey);
      const pk = Buffer.from(await s.exportKey("pkcs8", kp.privateKey)).toString("base64");
      fs.writeFileSync(f, JSON.stringify({ publicKey: pub, privateKey: pk, created: new Date().toISOString() }), { mode: 0o600 });
      return { pub, priv: kp.privateKey };
    })();
  return keyP;
}

// ------------------------------------------------------------------ Joplin Server client
class JErr extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = "",
  ) {
    super(message);
  }
}
const normUrl = (u: string) => u.trim().replace(/\/+$/, "");
const urlAllowed = (u: string) => !ALLOWED.length || ALLOWED.some((p) => u === p || u.startsWith(p + "/"));
type Creds = { url: string; email: string; password: string };

class JClient {
  private sid: Promise<string> | null = null;
  constructor(public c: Creds) {}

  private async raw(method: string, p: string, o: { session?: string; json?: unknown; bytes?: Uint8Array | string; query?: Record<string, string> } = {}) {
    const base = normUrl(this.c.url);
    if (!/^https?:\/\//i.test(base)) throw new JErr("The Joplin Server URL must start with http:// or https://");
    if (!urlAllowed(base)) throw new JErr("That Joplin Server isn't on this server's allow list (SCUTE_JOPLIN_URLS).", 403, "allow");
    const headers: Record<string, string> = { "X-API-MIN-VERSION": "2.6.0" };
    if (o.session) headers["X-API-AUTH"] = o.session;
    let body: BodyInit | undefined;
    if (o.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    } else if (o.bytes !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      body = o.bytes as BodyInit;
    }
    const qs = o.query && Object.keys(o.query).length ? "?" + new URLSearchParams(o.query).toString() : "";
    let res: globalThis.Response;
    try {
      res = await fetch(`${base}/${p}${qs}`, { method, headers, body, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      throw new JErr(`Can't reach Joplin Server: ${err.cause?.code || err.cause?.message || err.message}`);
    }
    if (!res.ok) {
      let msg = res.statusText, code = "";
      const t = await res.text().catch(() => "");
      try {
        const j = JSON.parse(t);
        msg = j.error || j.message || msg;
        code = String(j.code ?? "");
      } catch {
        if (t) msg = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || msg;
      }
      throw new JErr(msg, res.status, code);
    }
    return res;
  }
  private session(fresh = false) {
    if (fresh) this.sid = null;
    if (!this.sid) {
      const p = (async () => {
        try {
          const r = await this.raw("POST", "api/sessions", { json: { email: this.c.email, password: this.c.password } });
          const j = (await r.json()) as { id?: string };
          if (!j?.id) throw new JErr("Joplin Server didn't return a session");
          return j.id;
        } catch (e) {
          const err = e as JErr;
          if (err.status === 403 || err.status === 401) throw new JErr("Joplin Server rejected that email or password.", err.status, "auth");
          if (err.status === 404) throw new JErr("That URL doesn't look like a Joplin Server (no /api/sessions).", 404);
          throw err;
        }
      })();
      this.sid = p;
      p.catch(() => {
        if (this.sid === p) this.sid = null;
      });
    }
    return this.sid;
  }
  async call(method: string, p: string, o: { json?: unknown; bytes?: Uint8Array | string; query?: Record<string, string> } = {}) {
    const s = await this.session();
    try {
      return await this.raw(method, p, { ...o, session: s });
    } catch (e) {
      const err = e as JErr;
      if (err.status === 403 && /session/i.test(err.message)) return this.raw(method, p, { ...o, session: await this.session(true) });
      throw e;
    }
  }
  static item = (name: string) => `api/items/root:/${name}:`;
  async text(name: string): Promise<string | null> {
    try {
      return await (await this.call("GET", `${JClient.item(name)}/content`)).text();
    } catch (e) {
      if ((e as JErr).status === 404) return null;
      throw e;
    }
  }
  async bytes(name: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await (await this.call("GET", `${JClient.item(name)}/content`)).arrayBuffer());
    } catch (e) {
      if ((e as JErr).status === 404) return null;
      throw e;
    }
  }
  async put(name: string, content: string | Uint8Array) {
    await this.call("PUT", `${JClient.item(name)}/content`, { bytes: content });
  }
  async del(name: string) {
    try {
      await this.call("DELETE", JClient.item(name));
    } catch (e) {
      if ((e as JErr).status !== 404) throw e;
    }
  }
  async checkTarget() {
    const txt = await this.text("info.json");
    if (txt === null) {
      if ((await this.text(".sync/version.txt")) !== null)
        throw new JErr("This Joplin account uses an old sync format. Open it once with a current Joplin app to upgrade it, then try again.");
      throw new JErr("This Joplin account has never been synced. Sync a Joplin app with it first.");
    }
    let info: { version?: number; e2ee?: { value?: boolean } };
    try {
      info = JSON.parse(txt);
    } catch {
      throw new JErr("Joplin Server's info.json is unreadable.");
    }
    if (Number(info.version) !== 3) throw new JErr(`Unsupported Joplin sync version ${info.version} (Scute speaks version 3).`);
    if (info.e2ee?.value)
      throw new JErr("End-to-end encryption is turned on in Joplin for this account. Scute can't read Joplin-encrypted notes, so turn it off in Joplin (Settings → Encryption) or use a separate account.");
  }
  /** Joplin's change feed from `cursor` (null = everything). */
  async delta(cursor: string | null, onPage?: (n: number) => void) {
    const changes: { name: string; type: number; jut: number }[] = [];
    let cur = cursor, resync = false;
    for (let guard = 0; guard < 100000; guard++) {
      let j: { items?: { item_name?: string; type?: number; jop_updated_time?: number }[]; cursor?: string; has_more?: boolean };
      try {
        j = await (await this.call("GET", `${JClient.item("")}/delta`, { query: cur ? { cursor: cur } : {} })).json();
      } catch (e) {
        const err = e as JErr;
        if (cur && (err.code === "resyncRequired" || err.status === 400)) {
          cur = null;
          resync = true;
          changes.length = 0;
          continue;
        }
        throw e;
      }
      for (const ch of j.items || []) changes.push({ name: ch.item_name || "", type: Number(ch.type), jut: Number(ch.jop_updated_time || 0) });
      onPage?.(changes.length);
      cur = j.cursor || cur;
      if (!j.has_more) break;
    }
    return { changes, cursor: cur, resync };
  }
}

async function pool<X>(items: X[], n: number, fn: (x: X) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

function citemOf(it: JItem): CItem {
  const c: CItem = { t: it.type_, u: timeOf(it) };
  if (it.props.parent_id) c.p = it.props.parent_id;
  if (Number(it.props.deleted_time || 0) > 0) c.d = 1;
  if (it.type_ === T.NOTE && it.props.is_conflict === "1") c.c = 1;
  if (it.type_ === T.TAG || it.type_ === T.FOLDER || it.type_ === T.RESOURCE) c.title = it.title || "";
  if (it.type_ === T.NOTE_TAG) {
    c.n = it.props.note_id;
    c.g = it.props.tag_id;
  }
  if (it.type_ === T.RESOURCE) {
    c.m = it.props.mime || "";
    c.s = Number(it.props.size || 0) || undefined;
    if (!c.title && it.props.filename) c.title = it.props.filename;
    if (it.props.blob_updated_time) c.u = Math.max(c.u, Number(it.props.blob_updated_time) || 0);
  }
  return c;
}

// ------------------------------------------------------------------ hashes
const SYNCABLE = ["text", "link", "image", "video", "file"];
const FILE_TYPES = ["image", "video", "file", "link"];
function hashNote(d: NoteData, boardId: string | null) {
  return fnv(JSON.stringify([d.type, d.title || "", d.text || "", d.url || "", [...(d.tags || [])].map((t) => t.trim().toLowerCase()).sort(), boardId ? hexOf(boardId) : ""]));
}
function hashBoard(d: BoardData) {
  return fnv(JSON.stringify([d.title || "", d.parentId ? hexOf(d.parentId) : ""]));
}

// ------------------------------------------------------------------ media details (thumbnails) via ffmpeg
let ffmpegOk: Promise<boolean> | null = null;
function run(cmd: string, args: string[], ms: number): Promise<{ code: number; out: Buffer }> {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve({ code: -1, out: Buffer.alloc(0) });
    }
    const bufs: Buffer[] = [];
    const t = setTimeout(() => p.kill("SIGKILL"), ms);
    p.stdout.on("data", (b: Buffer) => bufs.push(b));
    p.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out: Buffer.alloc(0) });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out: Buffer.concat(bufs) });
    });
  });
}
async function mediaInfo(bytes: Uint8Array, mime: string): Promise<{ thumb?: string; width?: number; height?: number; duration?: number }> {
  if (!/^(image|video)\//.test(mime) || /svg/.test(mime)) return {};
  if (!ffmpegOk) ffmpegOk = run("ffmpeg", ["-version"], 10_000).then((r) => r.code === 0);
  if (!(await ffmpegOk)) return {};
  const f = path.join(os.tmpdir(), `scute-link-${nodeCrypto.randomBytes(8).toString("hex")}`);
  try {
    fs.writeFileSync(f, bytes, { mode: 0o600 });
    const out: { thumb?: string; width?: number; height?: number; duration?: number } = {};
    const pr = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", f], 30_000);
    try {
      const j = JSON.parse(pr.out.toString("utf8"));
      const v = (j.streams || []).find((s: { codec_type?: string }) => s.codec_type === "video");
      if (v?.width) out.width = Number(v.width);
      if (v?.height) out.height = Number(v.height);
      const dur = Number(j.format?.duration || 0);
      if (mime.startsWith("video/") && dur > 0) out.duration = Math.round(dur * 10) / 10;
    } catch {
      /* no details */
    }
    const seek = mime.startsWith("video/") && (out.duration || 0) > 2 ? ["-ss", "1"] : [];
    const th = await run(
      "ffmpeg",
      ["-v", "error", ...seek, "-i", f, "-frames:v", "1", "-vf", "scale='min(560,iw)':'min(560,ih)':force_original_aspect_ratio=decrease,format=yuvj420p", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
      60_000,
    );
    if (th.code === 0 && th.out.length > 100) out.thumb = "data:image/jpeg;base64," + th.out.toString("base64");
    return out;
  } finally {
    fs.rmSync(f, { force: true });
  }
}

// ------------------------------------------------------------------ runtime
interface SNote {
  id: string;
  boardId: string | null;
  data: NoteData;
  key: CryptoKey;
  encKey: string;
  fileSize: number | null;
  seq: number;
}
interface SBoard {
  id: string;
  data: BoardData;
  seq: number;
}
interface Runtime {
  id: string;
  spaceId: string;
  userId: string;
  key: CryptoKey;
  cfg: NotebookLinkConfig;
  client: JClient;
  state: LinkState;
  status: LinkStatus;
  index: { seq: number; notes: Map<string, SNote>; boards: Map<string, SBoard> } | null;
  broken: Set<string>; // notes that couldn't be read (never treated as deleted)
  running: Promise<void> | null;
  again: boolean;
  force: boolean;
  timer: NodeJS.Timeout | null;
  failures: number;
  stopped: boolean;
}
const runtimes = new Map<string, Runtime>(); // link id -> runtime
class Stale extends Error {}

const freshState = (): LinkState => ({ v: 1, cursor: null, items: {}, known: [], knownRes: [], knownBoards: [], missing: {} });

async function loadRuntime(row: LinkRow): Promise<Runtime> {
  const { priv } = await linkKey();
  const key = await C.openSealedKey(priv, row.sealed_key);
  const cfg = await C.decryptJson<NotebookLinkConfig>(key, row.config);
  let state = freshState();
  if (row.state) {
    try {
      state = { ...freshState(), ...(await C.decryptJson<LinkState>(key, row.state)) };
    } catch {
      /* start over */
    }
  }
  let status: LinkStatus = { phase: "starting" };
  try {
    if (row.status) status = JSON.parse(row.status);
  } catch {
    /* keep default */
  }
  return {
    id: row.id,
    spaceId: row.space_id,
    userId: row.user_id,
    key,
    cfg,
    client: new JClient(cfg),
    state,
    status,
    index: null,
    broken: new Set(),
    running: null,
    again: false,
    force: false,
    timer: null,
    failures: 0,
    stopped: false,
  };
}

function setStatus(rt: Runtime, st: LinkStatus, tell = true) {
  rt.status = st;
  db.prepare("UPDATE joplin_links SET status = ?, updated = ? WHERE id = ?").run(JSON.stringify(st), Date.now(), rt.id);
  if (tell) spaceEvent(rt.spaceId, "link");
}

async function saveState(rt: Runtime) {
  db.prepare("UPDATE joplin_links SET state = ? WHERE id = ?").run(await C.encryptJson(rt.key, rt.state), rt.id);
}

function schedule(rt: Runtime, ms: number) {
  if (rt.stopped) return;
  if (rt.timer) clearTimeout(rt.timer);
  rt.timer = setTimeout(() => {
    rt.timer = null;
    void kick(rt);
  }, ms);
}

/** Run now (or right after the current run). */
function kick(rt: Runtime): Promise<void> {
  if (rt.stopped) return Promise.resolve();
  if (rt.running) {
    rt.again = true;
    return rt.running;
  }
  rt.running = (async () => {
    let ok = false;
    try {
      do {
        rt.again = false;
        await runOnce(rt);
      } while (rt.again && !rt.stopped);
      ok = rt.status.phase === "ok";
    } catch (e) {
      console.error(`[links] ${rt.id}:`, e);
    } finally {
      rt.running = null;
      if (ok) rt.failures = 0;
      else if (rt.status.phase === "error") rt.failures++;
      const base = (LINK_INTERVALS.includes(rt.cfg.interval) ? rt.cfg.interval : DEFAULT_INTERVAL) * 1000;
      if (rt.status.phase !== "paused") schedule(rt, rt.failures ? Math.min(base * 2 ** rt.failures, 5 * 60_000) : base);
    }
  })();
  return rt.running;
}

function stopRuntime(id: string) {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.stopped = true;
  if (rt.timer) clearTimeout(rt.timer);
  runtimes.delete(id);
}

async function startRuntime(row: LinkRow, firstDelay = 500) {
  stopRuntime(row.id);
  const rt = await loadRuntime(row);
  runtimes.set(row.id, rt);
  if (row.enabled) schedule(rt, firstDelay);
  return rt;
}

// ------------------------------------------------------------------ the space, decrypted
async function refreshIndex(rt: Runtime) {
  const S = rt.spaceId;
  const top = currentSeq();
  const first = !rt.index;
  const idx = rt.index ?? { seq: 0, notes: new Map<string, SNote>(), boards: new Map<string, SBoard>() };
  const brows = (first
    ? db.prepare("SELECT id, space_id, data, deleted, seq FROM boards WHERE space_id = ? AND deleted = 0").all(S)
    : db.prepare("SELECT id, space_id, data, deleted, seq FROM boards WHERE seq > ?").all(idx.seq)) as { id: string; space_id: string; data: string | null; deleted: number; seq: number }[];
  for (const r of brows) {
    if (r.space_id !== S || r.deleted || !r.data) {
      idx.boards.delete(r.id);
      continue;
    }
    const cur = idx.boards.get(r.id);
    if (cur && cur.seq === r.seq) continue;
    try {
      idx.boards.set(r.id, { id: r.id, data: await C.decryptJson<BoardData>(rt.key, r.data), seq: r.seq });
    } catch {
      /* unreadable board: leave it */
    }
  }
  const nrows = (first
    ? db.prepare("SELECT id, space_id, board_id, enc_key, data, file_size, deleted, seq FROM notes WHERE space_id = ? AND deleted = 0").all(S)
    : db.prepare("SELECT id, space_id, board_id, enc_key, data, file_size, deleted, seq FROM notes WHERE seq > ?").all(idx.seq)) as {
    id: string;
    space_id: string;
    board_id: string | null;
    enc_key: string | null;
    data: string | null;
    file_size: number | null;
    deleted: number;
    seq: number;
  }[];
  for (const r of nrows) {
    if (r.space_id !== S || r.deleted || !r.data || !r.enc_key) {
      idx.notes.delete(r.id);
      rt.broken.delete(r.id);
      continue;
    }
    const cur = idx.notes.get(r.id);
    if (cur && cur.seq === r.seq) continue;
    try {
      const key = cur && cur.encKey === r.enc_key ? cur.key : await C.unwrapKey(rt.key, r.enc_key);
      const data = await C.decryptJson<NoteData>(key, r.data);
      idx.notes.set(r.id, { id: r.id, boardId: r.board_id, data, key, encKey: r.enc_key, fileSize: r.file_size, seq: r.seq });
      rt.broken.delete(r.id);
    } catch {
      idx.notes.delete(r.id);
      rt.broken.add(r.id);
    }
  }
  idx.seq = top;
  rt.index = idx;
  return idx;
}

/** Save a note into the linked space (as the link). Throws Stale if someone changed it meanwhile. */
async function writeNote(rt: Runtime, id: string, boardId: string | null, data: NoteData, file?: Uint8Array) {
  const idx = rt.index!;
  const cur = idx.notes.get(id);
  const key = cur?.key ?? (await C.newAesKey(true));
  const encKey = cur?.encKey ?? (await C.wrapKey(rt.key, key));
  const enc = await C.encryptJson(key, data);
  const encFile = file ? await C.encryptBytes(key, file) : null;
  // check and write without yielding, so a save from a browser can't slip in between
  const row = db.prepare("SELECT space_id, deleted, seq FROM notes WHERE id = ?").get(id) as { space_id: string; deleted: number; seq: number } | undefined;
  if (cur) {
    if (!row || row.seq !== cur.seq || row.space_id !== rt.spaceId || row.deleted) throw new Stale();
  } else if (row && !row.deleted) {
    if (row.space_id !== rt.spaceId) throw new Error("collision");
    throw new Stale();
  } // a deleted note (here or in another space) can come back under its old id
  let size = cur?.fileSize ?? null;
  if (encFile) {
    fs.writeFileSync(filePath(id), encFile);
    size = encFile.length;
  }
  const seq = nextSeq();
  db.prepare(
    `INSERT INTO notes (id, space_id, board_id, enc_key, data, file_size, deleted, seq) VALUES (?,?,?,?,?,?,0,?)
     ON CONFLICT(id) DO UPDATE SET space_id=excluded.space_id, board_id=excluded.board_id, enc_key=excluded.enc_key, data=excluded.data, file_size=excluded.file_size, deleted=0, seq=excluded.seq`,
  ).run(id, rt.spaceId, boardId, encKey, enc, size, seq);
  idx.notes.set(id, { id, boardId, data, key, encKey, fileSize: size, seq });
  rt.broken.delete(id);
}

function deleteNote(rt: Runtime, id: string) {
  const idx = rt.index!;
  const cur = idx.notes.get(id);
  const row = db.prepare("SELECT seq, space_id FROM notes WHERE id = ? AND deleted = 0").get(id) as { seq: number; space_id: string } | undefined;
  if (!row || row.space_id !== rt.spaceId) {
    idx.notes.delete(id);
    return;
  }
  if (cur && row.seq !== cur.seq) throw new Stale();
  db.prepare("UPDATE notes SET deleted = 1, data = NULL, enc_key = NULL, board_id = NULL, file_size = NULL, seq = ? WHERE id = ?").run(nextSeq(), id);
  removeFile(id);
  idx.notes.delete(id);
}

async function writeBoard(rt: Runtime, id: string, data: BoardData) {
  const idx = rt.index!;
  const cur = idx.boards.get(id);
  const enc = await C.encryptJson(rt.key, data);
  const row = db.prepare("SELECT space_id, deleted, seq FROM boards WHERE id = ?").get(id) as { space_id: string; deleted: number; seq: number } | undefined;
  if (row && row.space_id !== rt.spaceId && !row.deleted) throw new Error("collision");
  if (cur ? !row || row.seq !== cur.seq || row.deleted : row && !row.deleted) throw new Stale();
  const seq = nextSeq();
  db.prepare(
    `INSERT INTO boards (id, space_id, data, deleted, seq) VALUES (?,?,?,0,?)
     ON CONFLICT(id) DO UPDATE SET space_id=excluded.space_id, data=excluded.data, deleted=0, seq=excluded.seq`,
  ).run(id, rt.spaceId, enc, seq);
  idx.boards.set(id, { id, data, seq });
}

function deleteBoard(rt: Runtime, id: string) {
  const idx = rt.index!;
  const row = db.prepare("SELECT seq FROM boards WHERE id = ? AND space_id = ? AND deleted = 0").get(id, rt.spaceId) as { seq: number } | undefined;
  if (!row) {
    idx.boards.delete(id);
    return;
  }
  const seq = nextSeq();
  db.prepare("UPDATE boards SET deleted = 1, data = NULL, seq = ? WHERE id = ?").run(seq, id);
  // same as deleting a board in the app: its notes stay, off the board
  const moved = db.prepare("SELECT id FROM notes WHERE board_id = ? AND deleted = 0").all(id) as { id: string }[];
  db.prepare("UPDATE notes SET board_id = NULL, seq = ? WHERE board_id = ? AND deleted = 0").run(seq, id);
  for (const m of moved) {
    const n = idx.notes.get(m.id);
    if (n) idx.notes.set(m.id, { ...n, boardId: null, seq });
  }
  idx.boards.delete(id);
}

/** Another link on the same Joplin account, for a space (notes moved between two linked spaces just change notebooks). */
function sameAccountLink(rt: Runtime, spaceId: string) {
  for (const o of runtimes.values())
    if (o.spaceId === spaceId && o.id !== rt.id && normUrl(o.cfg.url) === normUrl(rt.cfg.url) && o.cfg.email.toLowerCase() === rt.cfg.email.toLowerCase()) return o;
  return null;
}

// ------------------------------------------------------------------ one sync run
async function runOnce(rt: Runtime) {
  const row = db.prepare("SELECT * FROM joplin_links WHERE id = ?").get(rt.id) as LinkRow | undefined;
  if (!row) return stopRuntime(rt.id);
  if (!row.enabled) return;
  const m = db.prepare("SELECT role FROM members WHERE space_id = ? AND user_id = ? AND status = 'active'").get(rt.spaceId, rt.userId) as { role: Role } | undefined;
  if (!m || ROLE_RANK[m.role] < ROLE_RANK.admin) {
    return setStatus(rt, { ...rt.status, phase: "paused", at: Date.now(), error: "The person who set up this link is no longer an admin of this space. An admin can link it again.", code: "access" });
  }
  const force = rt.force;
  rt.force = false;
  const cfg = rt.cfg;
  const jc = rt.client;
  const S = rt.spaceId;
  const root = cfg.notebookId;
  const out = { pulled: 0, pushed: 0, deleted: 0, conflicts: 0, files: 0 };
  const warnings: string[] = [];
  let collisions = 0;
  const startedPhase = rt.status.phase;
  if (startedPhase !== "ok") setStatus(rt, { ...rt.status, phase: "syncing" });
  let wrote = false;
  const clientId = (hexOf(rt.id) + "00000000000000000000000000000000").slice(0, 32);
  let lockTimer: NodeJS.Timeout | null = null;
  try {
    await jc.checkTarget();
    const locks = (await (await jc.call("GET", "api/locks")).json().catch(() => ({ items: [] }))) as { items?: { type: number }[] };
    if ((locks.items || []).some((l) => Number(l.type) === 2)) throw new JErr("A Joplin app is upgrading this sync target right now. Scute will try again shortly.");
    const lock = () => jc.call("POST", "api/locks", { json: { type: 1, clientType: 1, clientId } });
    await lock();
    lockTimer = setInterval(() => void lock().catch(() => {}), 60_000);

    // ------------------------------------------------ what changed in Joplin
    const st = rt.state;
    const d = await jc.delta(st.cursor);
    if (d.resync) st.items = {};
    const toFetch = new Set<string>();
    const removed = new Map<string, CItem>();
    for (const ch of d.changes) {
      if (!/^[0-9a-f]{32}\.md$/.test(ch.name)) continue;
      const jid = ch.name.slice(0, 32);
      if (ch.type === 3) {
        toFetch.delete(jid);
        if (st.items[jid]) removed.set(jid, st.items[jid]);
        continue;
      }
      removed.delete(jid);
      const c = st.items[jid];
      if (c && ch.jut && c.u === ch.jut && c.t !== T.RESOURCE) continue;
      toFetch.add(jid);
    }
    const fetched = new Map<string, JItem>();
    let readFailed = false;
    await pool([...toFetch], 6, async (jid) => {
      try {
        const txt = await jc.text(`${jid}.md`);
        if (txt === null) return;
        const it = parseItem(txt);
        if (it.props.encryption_applied === "1") return;
        fetched.set(jid, it);
      } catch (e) {
        readFailed = true;
        warnings.push(`Couldn't read a Joplin item: ${(e as Error).message}`);
      }
    });
    for (const [jid, it] of fetched) st.items[jid] = citemOf(it);
    for (const jid of removed.keys()) delete st.items[jid];

    // ------------------------------------------------ what's in the notebook
    const rc = st.items[root];
    if (!rc || rc.t !== T.FOLDER) throw new JErr(`The notebook “${cfg.notebookTitle}” isn't on the Joplin Server any more. Stop syncing this space, or restore the notebook in Joplin.`, 0, "notebook");
    if (rc.d) throw new JErr(`The notebook “${cfg.notebookTitle}” is in Joplin's trash. Restore it in Joplin, or stop syncing this space.`, 0, "notebook");
    if (rc.title && rc.title !== cfg.notebookTitle) {
      cfg.notebookTitle = rc.title;
      db.prepare("UPDATE joplin_links SET config = ? WHERE id = ?").run(await C.encryptJson(rt.key, cfg), rt.id);
    }
    const kids = new Map<string, string[]>();
    for (const [jid, c] of Object.entries(st.items)) {
      if (c.t !== T.FOLDER || c.d) continue;
      const p = c.p || "";
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(jid);
    }
    const folders = new Map<string, number>(); // sub-notebook -> depth
    const walk = (p: string, dep: number) => {
      for (const k of kids.get(p) || []) {
        if (folders.has(k) || k === root || dep > 60) continue;
        folders.set(k, dep);
        walk(k, dep + 1);
      }
    };
    walk(root, 0);
    const inScope = (jid: string) => {
      const c = st.items[jid];
      return !!c && c.t === T.NOTE && !c.d && !c.c && (c.p === root || folders.has(c.p || ""));
    };
    const boardOf = (jid: string) => {
      const p = st.items[jid]?.p || "";
      return p && p !== root && folders.has(p) ? uuidOf(p) : null;
    };
    const tagTitle = (tid: string) => {
      const t = st.items[tid];
      return t && t.t === T.TAG && !t.d ? (t.title || "").trim().toLowerCase() : null;
    };
    const tagsByNote = new Map<string, Set<string>>();
    for (const c of Object.values(st.items)) {
      if (c.t !== T.NOTE_TAG || !c.n || !c.g) continue;
      const title = tagTitle(c.g);
      if (!title) continue;
      if (!tagsByNote.has(c.n)) tagsByNote.set(c.n, new Set());
      tagsByNote.get(c.n)!.add(title);
    }
    const remoteTags = (jid: string) => [...(tagsByNote.get(jid) || [])].sort();

    const idx = await refreshIndex(rt);
    const mine = (mk: NotebookLinkMark | undefined): mk is NotebookLinkMark => !!mk && mk.link === rt.id;
    const changed = (n: SNote) => !mine(n.data.jlink) || hashNote(n.data, n.boardId) !== n.data.jlink.hash;
    const known = new Set(st.known), knownRes = new Set(st.knownRes), knownB = new Set(st.knownBoards);
    const goneNotes = [...known].filter((id) => !idx.notes.has(id) && !rt.broken.has(id));
    const goneBoards = [...knownB].filter((id) => !idx.boards.has(id));
    const guard = async (what: string, fn: () => Promise<void> | void) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof Stale) rt.again = true;
        else if ((e as Error).message === "collision") collisions++;
        else warnings.push(`${what}: ${(e as Error).message}`);
      }
    };

    // ------------------------------------------------ Joplin -> Scute: sub-notebooks
    for (const [jid] of [...folders.entries()].sort((a, b) => a[1] - b[1])) {
      const bid = uuidOf(jid);
      const local = idx.boards.get(bid);
      const c = st.items[jid];
      if (!local && knownB.has(bid)) continue; // deleted in Scute: sent to Joplin's trash below
      if (local && mine(local.data.jlink) && local.data.jlink.updated === c.u) continue;
      const parentId = c.p && c.p !== root && folders.has(c.p) ? uuidOf(c.p) : null;
      const data: BoardData = { ...(local?.data || {}), title: c.title || "Untitled", parentId, jlink: { link: rt.id, updated: c.u, hash: "" } };
      delete data.joplin;
      data.jlink!.hash = hashBoard(data);
      const same = local && hashBoard(local.data) === data.jlink!.hash;
      await guard(`Notebook “${c.title}”`, async () => {
        await writeBoard(rt, bid, data);
        wrote = true;
        if (!same) out.pulled++;
      });
    }

    // ------------------------------------------------ Joplin -> Scute: notes
    const need: string[] = [];
    for (const jid of Object.keys(st.items)) {
      if (!inScope(jid)) continue;
      const id = uuidOf(jid);
      const local = idx.notes.get(id);
      if (!local && known.has(id)) continue; // deleted or moved in Scute: handled below
      if (local?.data.jlink?.res) continue;
      const mk = local?.data.jlink;
      if (local && mine(mk) && mk.updated === st.items[jid].u) {
        if (changed(local)) continue; // only Scute changed: sent below
        const tags = remoteTags(jid);
        const have = [...(local.data.tags || [])].map((t) => t.trim().toLowerCase()).sort();
        if (JSON.stringify(have) === JSON.stringify(tags)) continue;
        const data: NoteData = { ...local.data, tags };
        data.jlink = { ...mk, hash: hashNote(data, local.boardId) };
        await guard(`“${local.data.title || "Untitled"}”`, async () => {
          await writeNote(rt, id, local.boardId, data);
          wrote = true;
          out.pulled++;
        });
        continue;
      }
      need.push(jid);
    }
    await pool(
      need.filter((j) => !fetched.has(j)),
      6,
      async (jid) => {
        try {
          const txt = await jc.text(`${jid}.md`);
          if (txt !== null) fetched.set(jid, parseItem(txt));
        } catch (e) {
          readFailed = true;
          warnings.push(`Couldn't read a Joplin note: ${(e as Error).message}`);
        }
      },
    );
    const resWanted = new Map<string, string | null>(); // resource -> board of the first note using it
    const wantRes = (text: string, boardId: string | null) => {
      for (const mm of text.matchAll(/:\/([0-9a-fA-F]{32})/g)) {
        const rid = mm[1].toLowerCase();
        if (!resWanted.has(rid)) resWanted.set(rid, boardId);
      }
    };
    const conflictCopy = async (local: SNote) => {
      const cd: NoteData = { ...local.data, title: `${local.data.title || "Untitled"} (conflict copy)`, modified: Date.now() };
      delete cd.jlink;
      delete cd.joplin;
      let file: Uint8Array | undefined;
      if (local.data.file && local.fileSize && !local.data.jlink?.res) {
        try {
          file = await C.decryptBytes(local.key, new Uint8Array(fs.readFileSync(filePath(local.id))));
        } catch {
          file = undefined;
        }
      }
      if (!file && FILE_TYPES.includes(cd.type) && cd.type !== "link") {
        cd.type = "text";
        delete cd.file;
        delete cd.thumb;
      }
      await writeNote(rt, nodeCrypto.randomUUID(), local.boardId, cd, file);
      out.conflicts++;
    };
    for (const jid of need) {
      const it = fetched.get(jid);
      if (!it || it.type_ !== T.NOTE) continue;
      const id = uuidOf(jid);
      const local = idx.notes.get(id);
      const tags = remoteTags(jid);
      const boardId = boardOf(jid) && idx.boards.has(boardOf(jid)!) ? boardOf(jid) : null;
      const data = fromJoplin(rt, it, local, tags, boardId);
      wantRes(data.text || "", boardId);
      const same = local && data.jlink!.hash === hashNote(local.data, local.boardId);
      await guard(`“${it.title || "Untitled"}”`, async () => {
        if (local && !same && changed(local)) await conflictCopy(local); // edited on both sides: Joplin's version wins, Scute's is kept as a copy
        await writeNote(rt, id, boardId, data);
        wrote = true;
        if (!same) out.pulled++;
      });
    }

    // linked notes that left the notebook in Joplin (deleted, trashed, moved elsewhere)
    const leaving = [...idx.notes.values()].filter((n) => mine(n.data.jlink) && !n.data.jlink.res && !inScope(hexOf(n.id)));
    const linkedCount = [...idx.notes.values()].filter((n) => mine(n.data.jlink) && !n.data.jlink.res).length;
    if (leaving.length > MASS_DELETE && leaving.length > linkedCount / 2 && !force) {
      throw new JErr(`Joplin says ${leaving.length} notes left the notebook “${cfg.notebookTitle}”. Sync is paused so nothing is removed by mistake. Choose Sync now to remove them from this space too.`, 0, "mass-delete");
    }
    for (const n of leaving) {
      await guard(`“${n.data.title || "Untitled"}”`, async () => {
        if (changed(n)) await conflictCopy(n);
        deleteNote(rt, n.id);
        wrote = true;
        out.deleted++;
      });
    }
    // sub-notebooks that are gone or moved out
    for (const b of [...idx.boards.values()]) {
      if (!mine(b.data.jlink) || folders.has(hexOf(b.id))) continue;
      await guard(`Board “${b.data.title}”`, () => {
        deleteBoard(rt, b.id);
        wrote = true;
        out.deleted++;
      });
    }

    // ------------------------------------------------ Joplin attachments -> attachment notes
    for (const [jid, it] of fetched) if (it.type_ === T.RESOURCE && idx.notes.has(uuidOf(jid))) resWanted.set(jid, idx.notes.get(uuidOf(jid))!.boardId);
    for (const [rid, mm] of Object.entries(st.missing)) if (!resWanted.has(rid)) resWanted.set(rid, mm.b);
    for (const [rid, b] of resWanted) {
      const c = st.items[rid];
      if (!c || c.t !== T.RESOURCE) {
        if (st.items[rid]) continue; // a link to a note, not an attachment
        const mm = st.missing[rid] || { n: 0, b };
        if (++mm.n > 60) delete st.missing[rid];
        else st.missing[rid] = mm;
        continue;
      }
      delete st.missing[rid];
      const id = uuidOf(rid);
      const local = idx.notes.get(id);
      if (local && !local.data.jlink?.res) continue; // a Scute note's own attachment
      if (local && mine(local.data.jlink) && local.data.jlink.updated === c.u) continue;
      if (!local && knownRes.has(id)) continue; // deleted in Scute
      if (c.s && c.s > MAX_FILE) {
        warnings.push(`Attachment “${c.title || rid}” is larger than this server's upload limit.`);
        continue;
      }
      await guard(`Attachment “${c.title || rid}”`, async () => {
        const bytes = await jc.bytes(`.resource/${rid}`);
        if (!bytes) return;
        const mime = c.m || sniffMime(bytes) || "application/octet-stream";
        const type = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";
        const name = (c.title || `${rid}`).replace(/[\\/]/g, "_");
        const info = await mediaInfo(bytes, mime);
        const data: NoteData = {
          ...(local?.data || {}),
          type,
          title: name,
          text: "",
          tags: [],
          file: { name, type: mime, size: bytes.length, ...(info.width ? { width: info.width, height: info.height } : {}), ...(info.duration ? { duration: info.duration } : {}) },
          thumb: info.thumb || null,
          created: local?.data.created || c.u || Date.now(),
          modified: c.u || Date.now(),
          jlink: { link: rt.id, updated: c.u, hash: "", res: true, resId: rid },
        } as NoteData;
        data.jlink!.hash = hashNote(data, local?.boardId ?? b);
        await writeNote(rt, id, local?.boardId ?? b, data, bytes);
        wrote = true;
        out.files++;
      });
    }
    // attachment notes nothing points at any more
    const refs = new Set<string>();
    for (const n of idx.notes.values()) if (!n.data.jlink?.res) for (const mm of (n.data.text || "").matchAll(/:\/([0-9a-fA-F]{32})/g)) refs.add(mm[1].toLowerCase());
    for (const n of [...idx.notes.values()]) {
      if (!mine(n.data.jlink) || !n.data.jlink.res || refs.has(hexOf(n.id))) continue;
      await guard("Attachment", () => {
        deleteNote(rt, n.id);
        wrote = true;
      });
    }

    // ------------------------------------------------ Scute -> Joplin
    const now = Date.now();
    const trash = async (jid: string) => {
      const txt = await jc.text(`${jid}.md`);
      if (!txt) return;
      const it = parseItem(txt);
      if (Number(it.props.deleted_time || 0) > 0) return;
      it.props.deleted_time = String(now);
      it.props.updated_time = iso(now);
      await jc.put(`${jid}.md`, serializeItem(it));
      st.items[jid] = { ...st.items[jid], u: now, d: 1 };
      out.deleted++;
    };
    for (const id of goneNotes) {
      if (knownRes.has(id)) continue;
      const jid = hexOf(id);
      if (!inScope(jid)) continue;
      const where = db.prepare("SELECT space_id, deleted FROM notes WHERE id = ?").get(id) as { space_id: string; deleted: number } | undefined;
      if (where && !where.deleted && where.space_id !== S && sameAccountLink(rt, where.space_id)) continue; // moved to a space linked to another notebook: that link moves it
      await guard("Send to Joplin's trash", () => trash(jid));
    }

    const bdepth = (b: SBoard) => {
      let dd = 0, p = b.data.parentId;
      while (p && dd < 60) {
        dd++;
        p = idx.boards.get(p)?.data.parentId;
      }
      return dd;
    };
    const pushBoards = [...idx.boards.values()].filter((b) => !mine(b.data.jlink) || hashBoard(b.data) !== b.data.jlink.hash).sort((a, b) => bdepth(a) - bdepth(b));
    for (const b of pushBoards) {
      await guard(`Board “${b.data.title}”`, async () => {
        const jid = hexOf(b.id);
        if (jid === root) return;
        const parent = b.data.parentId && idx.boards.has(b.data.parentId) ? hexOf(b.data.parentId) : root;
        let props: Record<string, string> = {};
        if (st.items[jid]?.t === T.FOLDER) {
          const txt = await jc.text(`${jid}.md`);
          if (txt) props = parseItem(txt).props;
        }
        Object.assign(props, {
          id: jid,
          parent_id: parent,
          created_time: props.created_time || iso(now),
          user_created_time: props.user_created_time || iso(now),
          updated_time: iso(now),
          user_updated_time: iso(now),
          deleted_time: "0",
        });
        await jc.put(`${jid}.md`, serializeItem({ type_: T.FOLDER, title: b.data.title || "Untitled", props }));
        st.items[jid] = { t: T.FOLDER, u: now, p: parent, title: b.data.title || "Untitled" };
        folders.set(jid, bdepth(b));
        const data: BoardData = { ...b.data, jlink: { link: rt.id, updated: now, hash: "" } };
        data.jlink!.hash = hashBoard(data);
        await writeBoard(rt, b.id, data);
        wrote = true;
        out.pushed++;
      });
    }
    for (const id of goneBoards) {
      const jid = hexOf(id);
      if (folders.has(jid)) await guard("Send notebook to Joplin's trash", () => trash(jid));
    }

    // tags are shared across Joplin notes: found by title, made when missing
    const tagByTitle = new Map<string, string>();
    for (const [jid, c] of Object.entries(st.items)) if (c.t === T.TAG && !c.d) tagByTitle.set((c.title || "").trim().toLowerCase(), jid);
    const ensureTag = async (title: string) => {
      const hit = tagByTitle.get(title);
      if (hit) return hit;
      const jid = randHex();
      const props: Record<string, string> = { id: jid, created_time: iso(now), updated_time: iso(now), user_created_time: iso(now), user_updated_time: iso(now), parent_id: "" };
      await jc.put(`${jid}.md`, serializeItem({ type_: T.TAG, title, props }));
      st.items[jid] = { t: T.TAG, u: now, title };
      tagByTitle.set(title, jid);
      return jid;
    };

    const syncable = [...idx.notes.values()].filter((n) => SYNCABLE.includes(n.data.type) && !n.data.jlink?.res);
    const pushNotes = syncable.filter(changed).sort((a, b) => Number(!!b.data.file) - Number(!!a.data.file));
    const resOfNote = new Map<string, string>();
    for (const n of syncable) if (n.data.file && mine(n.data.jlink) && n.data.jlink.resId) resOfNote.set(hexOf(n.id), n.data.jlink.resId);
    for (const n of pushNotes) {
      await guard(`“${n.data.title || n.data.file?.name || "Untitled"}”`, async () => {
        const jid = hexOf(n.id);
        if (jid === root || folders.has(jid)) return;
        const bid = n.boardId && idx.boards.has(n.boardId) ? hexOf(n.boardId) : root;
        const d = n.data;
        const mk: NotebookLinkMark = { link: rt.id, updated: now, hash: "", ...(mine(d.jlink) && d.jlink.resId ? { resId: d.jlink.resId } : {}) };
        if (FILE_TYPES.includes(d.type) && d.file && n.fileSize && !mk.resId) {
          const blob = await C.decryptBytes(n.key, new Uint8Array(fs.readFileSync(filePath(n.id))));
          const rid = randHex();
          await jc.put(`.resource/${rid}`, blob);
          const ext = (d.file.name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1] || "").toLowerCase();
          const rprops: Record<string, string> = {
            id: rid,
            mime: d.file.type || "application/octet-stream",
            filename: "",
            created_time: iso(now),
            updated_time: iso(now),
            user_created_time: iso(now),
            user_updated_time: iso(now),
            file_extension: ext,
            size: String(blob.length),
            blob_updated_time: String(now),
          };
          await jc.put(`${rid}.md`, serializeItem({ type_: T.RESOURCE, title: d.file.name, props: rprops }));
          st.items[rid] = { t: T.RESOURCE, u: now, title: d.file.name, m: rprops.mime, s: blob.length };
          mk.resId = rid;
        }
        if (mk.resId && d.file) resOfNote.set(jid, mk.resId);
        let body = (d.text || "").replace(/(:\/)([0-9a-fA-F]{32})/g, (x, pre, h) => (resOfNote.has(h.toLowerCase()) ? pre + resOfNote.get(h.toLowerCase()) : x));
        if (mk.resId && d.file) {
          const label = d.file.name.replace(/[[\]]/g, "");
          const embed = d.type === "file" || d.type === "link" ? `[${label}](:/${mk.resId})` : `![${label}](:/${mk.resId})`;
          body = body ? `${body}\n\n${embed}` : embed;
        }
        if (d.type === "link" && d.url) body = body ? `<${d.url}>\n\n${body}` : `<${d.url}>`;
        let props: Record<string, string> = {};
        if (st.items[jid]?.t === T.NOTE) {
          const txt = await jc.text(`${jid}.md`);
          if (txt) props = parseItem(txt).props;
        }
        Object.assign(props, {
          id: jid,
          parent_id: bid,
          created_time: props.created_time || iso(d.created || now),
          user_created_time: props.user_created_time || iso(d.created || now),
          updated_time: iso(now),
          user_updated_time: iso(d.modified || now),
          deleted_time: "0",
          is_conflict: "0",
        });
        if (d.type === "link") props.source_url = d.url || "";
        if (!props.order) props.order = String(d.created || now);
        await jc.put(`${jid}.md`, serializeItem({ type_: T.NOTE, title: d.title || (d.file?.name ?? ""), body, props }));
        st.items[jid] = { t: T.NOTE, u: now, p: bid };

        const want = new Set((d.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean));
        for (const [ntid, c] of Object.entries(st.items).filter(([, c]) => c.t === T.NOTE_TAG && c.n === jid)) {
          const title = tagTitle(c.g!);
          if (title && want.has(title)) want.delete(title);
          else {
            await jc.del(`${ntid}.md`);
            delete st.items[ntid];
          }
        }
        for (const title of want) {
          const tid = await ensureTag(title);
          const ntid = randHex();
          await jc.put(`${ntid}.md`, serializeItem({ type_: T.NOTE_TAG, props: { id: ntid, note_id: jid, tag_id: tid, created_time: iso(now), updated_time: iso(now), user_created_time: iso(now), user_updated_time: iso(now) } }));
          st.items[ntid] = { t: T.NOTE_TAG, u: now, n: jid, g: tid };
        }
        const data: NoteData = { ...d, jlink: mk };
        mk.hash = hashNote(data, n.boardId && idx.boards.has(n.boardId) ? n.boardId : null);
        await writeNote(rt, n.id, n.boardId && idx.boards.has(n.boardId) ? n.boardId : null, data);
        wrote = true;
        out.pushed++;
      });
    }

    // ------------------------------------------------ done
    if (!readFailed) st.cursor = d.cursor;
    const linked = [...idx.notes.values()].filter((n) => mine(n.data.jlink));
    st.known = linked.filter((n) => !n.data.jlink!.res).map((n) => n.id);
    st.knownRes = linked.filter((n) => n.data.jlink!.res).map((n) => n.id);
    st.knownBoards = [...idx.boards.values()].filter((b) => mine(b.data.jlink)).map((b) => b.id);
    await saveState(rt);
    if (collisions)
      warnings.unshift(`${collisions} item${collisions === 1 ? " is" : "s are"} already in another Scute space (perhaps a Joplin space for the same account), so ${collisions === 1 ? "it was" : "they were"} left out here.`);
    const t = Date.now();
    const busy = out.pulled + out.pushed + out.deleted + out.conflicts + out.files > 0;
    setStatus(
      rt,
      {
        phase: "ok",
        at: t,
        okAt: t,
        error: null,
        last: busy ? out : rt.status.last || out,
        lastAt: busy ? t : rt.status.lastAt,
        notes: st.known.length,
        boards: st.knownBoards.length,
        files: st.knownRes.length,
        warnings: warnings.slice(0, 5),
      },
      busy || startedPhase !== "ok" || JSON.stringify(warnings.slice(0, 5)) !== JSON.stringify(rt.status.warnings || []),
    );
  } catch (e) {
    const err = e as JErr;
    if (!(e instanceof JErr)) console.error(`[links] ${rt.id}:`, e);
    const paused = err.code === "mass-delete" || err.code === "notebook";
    setStatus(rt, { ...rt.status, phase: paused ? "paused" : "error", at: Date.now(), error: err.message || String(e), code: err.code || undefined });
    if (err.code === "auth") rt.client = new JClient(cfg);
  } finally {
    if (lockTimer) clearInterval(lockTimer);
    await jc.call("DELETE", `api/locks/1_1_${clientId}`).catch(() => {});
    if (wrote) spaceChanged(S, rt.id);
  }
}

function fromJoplin(rt: Runtime, it: JItem, local: SNote | undefined, tags: string[], boardId: string | null): NoteData {
  const u = timeOf(it);
  let text = it.body || "";
  let type: NoteData["type"] = "text";
  let url: string | undefined = it.props.source_url || undefined;
  const mk: NotebookLinkMark = { link: rt.id, updated: u, hash: "" };
  if (local && FILE_TYPES.includes(local.data.type)) {
    type = local.data.type;
    const resId = local.data.jlink?.link === rt.id ? local.data.jlink.resId : undefined;
    if (resId) {
      mk.resId = resId;
      text = text.replace(new RegExp(`\\n*!?\\[[^\\]]*\\]\\(:/${resId}\\)\\s*$`), "");
    }
  }
  if (type !== "link") url = local?.data.url || url;
  else if (url) {
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^<${esc}>\\s*`), "");
  }
  const data = {
    ...(local?.data || {}),
    type,
    title: it.title || "",
    text,
    url,
    tags,
    created: timeOf(it, "user_created_time") || timeOf(it, "created_time") || u,
    modified: timeOf(it, "user_updated_time") || u,
    jlink: mk,
  } as NoteData;
  delete data.joplin;
  if (!url) delete data.url;
  mk.hash = hashNote(data, boardId);
  return data;
}

// ------------------------------------------------------------------ notebook scan (for the picker)
interface Scan {
  id: string;
  user: string;
  creds: Creds;
  done: boolean;
  phase: string;
  fetched: number;
  total: number;
  error?: string;
  cursor: string | null;
  items: Record<string, CItem>;
  at: number;
}
const scans = new Map<string, Scan>();
setInterval(() => {
  for (const [k, s] of scans) if (Date.now() - s.at > 30 * 60_000) scans.delete(k);
}, 60_000).unref();

async function runScan(s: Scan) {
  try {
    const jc = new JClient(s.creds);
    await jc.checkTarget();
    s.phase = "Listing items…";
    const d = await jc.delta(null, (n) => (s.total = n));
    const names = new Set<string>();
    for (const ch of d.changes) {
      if (!/^[0-9a-f]{32}\.md$/.test(ch.name)) continue;
      if (ch.type === 3) names.delete(ch.name);
      else names.add(ch.name);
    }
    s.total = names.size;
    s.phase = "Reading items…";
    await pool([...names], 8, async (name) => {
      const txt = await jc.text(name);
      s.fetched++;
      if (txt === null) return;
      const it = parseItem(txt);
      if (it.props.encryption_applied === "1") return;
      s.items[name.slice(0, 32)] = citemOf(it);
    });
    s.cursor = d.cursor;
    s.done = true;
  } catch (e) {
    s.error = (e as Error).message;
    s.done = true;
  }
}

function notebooksOf(s: Scan) {
  const out: { id: string; title: string; parentId: string; notes: number; total: number; taken: string | null }[] = [];
  const direct = new Map<string, number>();
  for (const c of Object.values(s.items)) if (c.t === T.NOTE && !c.d && !c.c) direct.set(c.p || "", (direct.get(c.p || "") || 0) + 1);
  const folders = Object.entries(s.items).filter(([, c]) => c.t === T.FOLDER && !c.d);
  const kids = new Map<string, string[]>();
  for (const [id, c] of folders) {
    if (!kids.has(c.p || "")) kids.set(c.p || "", []);
    kids.get(c.p || "")!.push(id);
  }
  const total = (id: string, dep = 0): number => (direct.get(id) || 0) + (dep > 60 ? 0 : (kids.get(id) || []).reduce((a, k) => a + total(k, dep + 1), 0));
  const takenBy = takenNotebooks(s.creds);
  const chain = (id: string) => {
    const ids: string[] = [];
    let p: string | undefined = id;
    while (p && ids.length < 60) {
      ids.push(p);
      p = s.items[p]?.p;
    }
    return ids;
  };
  for (const [id, c] of folders) {
    let taken: string | null = null;
    for (const [nb, sp] of takenBy) if (chain(id).includes(nb) || chain(nb).includes(id)) taken = sp;
    out.push({ id, title: c.title || "Untitled", parentId: c.p && s.items[c.p] ? c.p : "", notes: direct.get(id) || 0, total: total(id), taken });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

/** Notebooks of this account already linked: notebook id -> space id. */
function takenNotebooks(c: Creds, exceptLink?: string) {
  const m = new Map<string, string>();
  for (const o of runtimes.values())
    if (o.id !== exceptLink && normUrl(o.cfg.url) === normUrl(c.url) && o.cfg.email.toLowerCase() === c.email.toLowerCase()) m.set(o.cfg.notebookId, o.spaceId);
  return m;
}

// ------------------------------------------------------------------ start-up and triggers
let started = false;
export function startLinks() {
  if (!LINKS_ON || started) return;
  started = true;
  db.prepare("DELETE FROM joplin_links WHERE space_id NOT IN (SELECT id FROM spaces)").run();
  const rows = db.prepare("SELECT * FROM joplin_links").all() as LinkRow[];
  rows.forEach((row, i) => {
    startRuntime(row, 3000 + i * 1500).catch((e) => console.error(`[links] couldn't start ${row.id}:`, (e as Error).message));
  });
  // Scute edits in a linked space go to Joplin moments later
  const pend = new Map<string, NodeJS.Timeout>();
  onSpaceChange((spaceId, origin) => {
    for (const rt of runtimes.values()) {
      if (rt.spaceId !== spaceId || origin === rt.id || rt.stopped) continue;
      if (pend.has(rt.id)) clearTimeout(pend.get(rt.id)!);
      pend.set(
        rt.id,
        setTimeout(() => {
          pend.delete(rt.id);
          const row = db.prepare("SELECT enabled FROM joplin_links WHERE id = ?").get(rt.id) as { enabled: number } | undefined;
          if (row?.enabled && rt.status.phase !== "paused") void kick(rt);
        }, AFTER_EDIT_MS),
      );
    }
  });
}

/** Quick view of a link for the space's members (no password). */
function publicView(row: LinkRow, rt: Runtime | undefined, role: Role) {
  let status: LinkStatus = { phase: "starting" };
  try {
    if (row.status) status = JSON.parse(row.status);
  } catch {
    /* default */
  }
  const by = db.prepare("SELECT username FROM users WHERE id = ?").get(row.user_id) as { username: string } | undefined;
  return {
    id: row.id,
    spaceId: row.space_id,
    enabled: !!row.enabled,
    created: row.created,
    createdBy: by?.username || null,
    running: !!rt?.running,
    status,
    info: rt
      ? {
          url: normUrl(rt.cfg.url),
          email: ROLE_RANK[role] >= ROLE_RANK.admin ? rt.cfg.email : undefined,
          notebookId: rt.cfg.notebookId,
          notebookTitle: rt.cfg.notebookTitle,
          interval: rt.cfg.interval,
        }
      : null,
  };
}

// ------------------------------------------------------------------ routes
type Deps = {
  auth: (req: Request, res: Response, next: NextFunction) => void;
  wrap: (fn: (req: any, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => void;
  HttpError: new (status: number, message: string) => Error;
  requireRole: (spaceId: string, userId: string, min: Role) => { role: Role };
  parse: <S extends z.ZodTypeAny>(schema: S, data: unknown) => z.infer<S>;
};

export function registerLinkRoutes(app: Express, d: Deps) {
  const { auth, wrap, HttpError, requireRole, parse } = d;
  const off = () => {
    throw new HttpError(404, "Joplin notebook links are turned off on this server");
  };
  const creds = z.object({ url: z.string().url().max(500), email: z.string().min(1).max(200), password: z.string().min(1).max(500) });
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const linkFor = (id: string, userId: string, min: Role) => {
    const row = db.prepare("SELECT * FROM joplin_links WHERE id = ?").get(id) as LinkRow | undefined;
    if (!row) throw new HttpError(404, "Link not found");
    const m = requireRole(row.space_id, userId, min);
    return { row, role: m.role };
  };

  app.get(
    "/api/links/key",
    auth,
    wrap(async (_req, res) => {
      if (!LINKS_ON) off();
      res.json({ publicKey: (await linkKey()).pub });
    }),
  );

  // Look through a Joplin account for its notebooks (reads every item once; progress is polled)
  app.post(
    "/api/links/scan",
    auth,
    wrap(async (req, res) => {
      if (!LINKS_ON) off();
      const b = parse(creds, req.body);
      const c = { url: normUrl(b.url), email: b.email.trim(), password: b.password };
      if (!urlAllowed(c.url)) throw new HttpError(403, "That Joplin Server isn't on this server's allow list (SCUTE_JOPLIN_URLS)");
      for (const s of scans.values()) if (s.user === req.user.id && !s.done) throw new HttpError(429, "Already looking through a Joplin account. Wait for it to finish.");
      const s: Scan = { id: nodeCrypto.randomUUID(), user: req.user.id, creds: c, done: false, phase: "Signing in…", fetched: 0, total: 0, cursor: null, items: {}, at: Date.now() };
      scans.set(s.id, s);
      void runScan(s);
      res.json({ id: s.id });
    }),
  );
  app.get(
    "/api/links/scan/:id",
    auth,
    wrap(async (req, res) => {
      const s = scans.get(req.params.id);
      if (!s || s.user !== req.user.id) throw new HttpError(404, "That look-up has expired. Start again.");
      res.json({ done: s.done, phase: s.phase, fetched: s.fetched, total: s.total, error: s.error || null, notebooks: s.done && !s.error ? notebooksOf(s) : null });
    }),
  );

  app.get(
    "/api/links",
    auth,
    wrap(async (req, res) => {
      if (!LINKS_ON) return res.json({ links: [] });
      const rows = db
        .prepare("SELECT l.*, m.role AS my_role FROM joplin_links l JOIN members m ON m.space_id = l.space_id AND m.user_id = ? AND m.status = 'active'")
        .all(req.user.id) as (LinkRow & { my_role: Role })[];
      res.json({ links: rows.map((r) => publicView(r, runtimes.get(r.id), r.my_role)) });
    }),
  );

  app.post(
    "/api/links",
    auth,
    wrap(async (req, res) => {
      if (!LINKS_ON) off();
      const b = parse(z.object({ spaceId: z.string().regex(uuidRe), sealedKey: z.string().max(2000), config: z.string().max(20000), scanId: z.string().max(64) }), req.body);
      requireRole(b.spaceId, req.user.id, "admin");
      if (db.prepare("SELECT 1 FROM joplin_links WHERE space_id = ?").get(b.spaceId)) throw new HttpError(409, "This space is already linked to a Joplin notebook");
      const { priv } = await linkKey();
      let key: CryptoKey, cfg: NotebookLinkConfig, sd: SpaceData;
      try {
        key = await C.openSealedKey(priv, b.sealedKey);
        const sp = db.prepare("SELECT data FROM spaces WHERE id = ?").get(b.spaceId) as { data: string };
        sd = await C.decryptJson<SpaceData>(key, sp.data);
        cfg = await C.decryptJson<NotebookLinkConfig>(key, b.config);
      } catch {
        throw new HttpError(400, "That key doesn't open this space");
      }
      if (sd.kind && sd.kind !== "notes") throw new HttpError(400, "Only ordinary note spaces can be linked to a Joplin notebook");
      const s = scans.get(b.scanId);
      if (!s || s.user !== req.user.id || !s.done || s.error) throw new HttpError(400, "Look through the Joplin account again, then pick the notebook");
      cfg.url = normUrl(cfg.url);
      if (cfg.url !== s.creds.url || cfg.email.trim().toLowerCase() !== s.creds.email.toLowerCase()) throw new HttpError(400, "The account doesn't match the one looked through");
      if (!isHexId(cfg.notebookId) || s.items[cfg.notebookId]?.t !== T.FOLDER) throw new HttpError(400, "Pick a notebook from the list");
      const nb = notebooksOf(s).find((x) => x.id === cfg.notebookId);
      if (nb?.taken) throw new HttpError(409, "That notebook (or one inside or around it) is already linked to another space");
      if (!LINK_INTERVALS.includes(cfg.interval)) cfg.interval = DEFAULT_INTERVAL;
      cfg.notebookTitle = nb?.title || cfg.notebookTitle || "Notebook";
      const id = nodeCrypto.randomUUID();
      const state: LinkState = { ...freshState(), cursor: s.cursor, items: s.items };
      const now = Date.now();
      db.prepare("INSERT INTO joplin_links (id, space_id, user_id, sealed_key, config, state, status, enabled, created, updated) VALUES (?,?,?,?,?,?,?,1,?,?)").run(
        id,
        b.spaceId,
        req.user.id,
        b.sealedKey,
        await C.encryptJson(key, cfg),
        await C.encryptJson(key, state),
        JSON.stringify({ phase: "starting" } satisfies LinkStatus),
        now,
        now,
      );
      scans.delete(b.scanId);
      const row = db.prepare("SELECT * FROM joplin_links WHERE id = ?").get(id) as LinkRow;
      await startRuntime(row, 100);
      spaceEvent(b.spaceId, "link");
      res.json({ id });
    }),
  );

  app.patch(
    "/api/links/:id",
    auth,
    wrap(async (req, res) => {
      if (!LINKS_ON) off();
      const { row } = linkFor(req.params.id, req.user.id, "admin");
      const b = parse(
        z.object({ password: z.string().max(500).optional(), interval: z.number().int().optional(), enabled: z.boolean().optional() }),
        req.body,
      );
      let rt = runtimes.get(row.id);
      if (!rt) rt = await startRuntime(row, 1000);
      if (b.password || b.interval !== undefined) {
        if (b.password) rt.cfg.password = b.password;
        if (b.interval !== undefined && LINK_INTERVALS.includes(b.interval)) rt.cfg.interval = b.interval;
        db.prepare("UPDATE joplin_links SET config = ?, updated = ? WHERE id = ?").run(await C.encryptJson(rt.key, rt.cfg), Date.now(), row.id);
        rt.client = new JClient(rt.cfg);
      }
      if (b.enabled !== undefined) {
        db.prepare("UPDATE joplin_links SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, row.id);
        if (!b.enabled) {
          if (rt.timer) clearTimeout(rt.timer);
          setStatus(rt, { ...rt.status, phase: "paused", error: null, code: "off" });
        } else setStatus(rt, { ...rt.status, phase: "starting", error: null, code: undefined });
      }
      if (b.enabled !== false && (b.enabled || b.password || rt.status.phase === "error")) {
        rt.failures = 0;
        void kick(rt);
      }
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/links/:id/run",
    auth,
    wrap(async (req, res) => {
      if (!LINKS_ON) off();
      const { row } = linkFor(req.params.id, req.user.id, "member");
      const b = parse(z.object({ force: z.boolean().optional() }), req.body || {});
      if (!row.enabled) throw new HttpError(409, "Syncing is paused for this space");
      const rt = runtimes.get(row.id) || (await startRuntime(row, 60_000));
      if (b.force) {
        const { role } = linkFor(req.params.id, req.user.id, "admin");
        if (role) rt.force = true;
      }
      if (rt.status.phase === "paused" && rt.status.code !== "mass-delete") rt.status = { ...rt.status, phase: "error" };
      rt.failures = 0;
      await Promise.race([kick(rt), new Promise((r) => setTimeout(r, 25_000))]);
      res.json({ status: rt.status });
    }),
  );

  app.delete(
    "/api/links/:id",
    auth,
    wrap(async (req, res) => {
      if (!LINKS_ON) off();
      const { row } = linkFor(req.params.id, req.user.id, "admin");
      stopRuntime(row.id);
      db.prepare("DELETE FROM joplin_links WHERE id = ?").run(row.id);
      spaceEvent(row.space_id, "link");
      res.json({ ok: true });
    }),
  );
}

/** When a space is deleted its link row goes with it (foreign key); stop the job too. */
export function forgetSpaceLinks(spaceId: string) {
  for (const rt of [...runtimes.values()]) if (rt.spaceId === spaceId) stopRuntime(rt.id);
}
