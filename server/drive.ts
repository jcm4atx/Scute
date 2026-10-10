import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DATA_DIR, db } from "./storage";
import { PLUGINS_ON, listPlugins } from "./plugins";

/**
 * Scute Drive (plug-in API 8, "drive" permission): a WebDAV folder for each user.
 *
 * Files are stored as ordinary files, unencrypted, at SCUTE_DRIVE_DIR/<username>/
 * (default <data>/drive/), so they can be read on the server, backed up or
 * served by other tools. Clients: rclone (bisync / mount), Round Sync on
 * Android, GNOME Files / Dolphin (davs://), davfs2, and the Scute Drive plug-in.
 *
 * WebDAV lives at /dav/ (class 1 plus pretend locks). Clients sign in with the
 * Scute username and an app password made in the plug-in; the web app uses
 * its normal session. Deleted and replaced files go to a trash kept for
 * SCUTE_DRIVE_TRASH_DAYS (default 30).
 */

const off = (v: string | undefined, d: string) => ["off", "0", "false", "no"].includes((v || d).toLowerCase());
export const DRIVE_ON = PLUGINS_ON && !off(process.env.SCUTE_DRIVE, "on");
const DRIVE_DIR = path.resolve(process.env.SCUTE_DRIVE_DIR || path.join(DATA_DIR, "drive"));
const META_DIR = path.join(DRIVE_DIR, ".scute"); // trash and uploads in progress (same disk, so renames are instant)
const QUOTA_GB = Number(process.env.SCUTE_DRIVE_QUOTA_GB || 0); // per user, 0 = no limit
const MAX_FILE_GB = Number(process.env.SCUTE_DRIVE_MAX_FILE_GB || 50);
const TRASH_DAYS = Math.max(0, Number(process.env.SCUTE_DRIVE_TRASH_DAYS ?? 30));
const BASE_PATH = (process.env.SCUTE_BASE_PATH || "").replace(/\/+$/, "");

db.exec(`
CREATE TABLE IF NOT EXISTS drive_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS drive_tokens_user ON drive_tokens(user_id);
CREATE TABLE IF NOT EXISTS drive_hashes (
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sha1 TEXT NOT NULL,
  md5 TEXT NOT NULL,
  PRIMARY KEY (user_id, path)
);
`);

interface User {
  id: string;
  username: string;
}
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Is a plug-in with the "drive" permission switched on? */
function pluginOn(): boolean {
  try {
    return listPlugins().some((p) => p.enabled && !p.error && p.permissions.includes("drive"));
  } catch {
    return false;
  }
}

const folderName = (u: User) => (u.username.startsWith(".") ? `_${u.username}` : u.username);
const userRoot = (u: User) => path.join(DRIVE_DIR, folderName(u));
const trashRoot = (u: User) => path.join(META_DIR, "trash", u.id);
const tmpRoot = (u: User) => path.join(META_DIR, "tmp", u.id);

function ensure(u: User) {
  fs.mkdirSync(userRoot(u), { recursive: true });
  fs.mkdirSync(tmpRoot(u), { recursive: true });
}

class DavError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** "/a/b c/d" (decoded, relative to the drive) from a URL path below /dav. */
function cleanRel(p: string): string {
  const parts: string[] = [];
  for (const raw of p.split("/")) {
    if (!raw) continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      throw new DavError(400, "Bad file name encoding");
    }
    if (seg === "." || seg === ".." || seg.includes("\0") || seg.includes("/") || seg.includes("\\")) throw new DavError(400, "Bad file name");
    if (Buffer.byteLength(seg) > 255) throw new DavError(400, "File name too long");
    parts.push(seg.normalize("NFC"));
  }
  return parts.join("/");
}
const absOf = (u: User, rel: string) => {
  const root = userRoot(u);
  const abs = path.join(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new DavError(400, "Bad path");
  return abs;
};
const encPath = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");

async function statOrNull(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ usage (cached)
const usage = new Map<string, { bytes: number; at: number }>();
async function dirSize(p: string): Promise<number> {
  let total = 0;
  let list: fs.Dirent[];
  try {
    list = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of list) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(f);
    else if (e.isFile()) total += (await statOrNull(f))?.size || 0;
  }
  return total;
}
async function used(u: User, fresh = false): Promise<number> {
  const c = usage.get(u.id);
  if (c && !fresh && Date.now() - c.at < 5 * 60_000) return c.bytes;
  const bytes = await dirSize(userRoot(u));
  usage.set(u.id, { bytes, at: Date.now() });
  return bytes;
}
const adjust = (u: User, delta: number) => {
  const c = usage.get(u.id);
  if (c) c.bytes = Math.max(0, c.bytes + delta);
};

// ------------------------------------------------------------------ hashes (for rclone's checksum compare)
function hashOf(u: User, rel: string, st: fs.Stats): { sha1: string; md5: string } | null {
  const r = db.prepare("SELECT size, mtime, sha1, md5 FROM drive_hashes WHERE user_id = ? AND path = ?").get(u.id, rel) as { size: number; mtime: number; sha1: string; md5: string } | undefined;
  return r && r.size === st.size && r.mtime === Math.floor(st.mtimeMs) ? r : null;
}
function forgetHashes(u: User, rel: string) {
  db.prepare("DELETE FROM drive_hashes WHERE user_id = ? AND (path = ? OR substr(path, 1, ?) = ?)").run(u.id, rel, rel.length + 1, rel + "/");
}
function moveHashes(u: User, from: string, to: string, copy: boolean) {
  const rows = db.prepare("SELECT * FROM drive_hashes WHERE user_id = ? AND (path = ? OR substr(path, 1, ?) = ?)").all(u.id, from, from.length + 1, from + "/") as any[];
  const ins = db.prepare("INSERT OR REPLACE INTO drive_hashes (user_id, path, size, mtime, sha1, md5) VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    forgetHashes(u, to);
    if (!copy) forgetHashes(u, from);
    for (const r of rows) ins.run(u.id, to + r.path.slice(from.length), r.size, r.mtime, r.sha1, r.md5);
  })();
}

// ------------------------------------------------------------------ trash
interface TrashMeta {
  id: string;
  path: string;
  dir: boolean;
  size: number;
  deleted: number;
  reason: "deleted" | "replaced";
}
async function toTrash(u: User, rel: string, reason: TrashMeta["reason"]): Promise<void> {
  const abs = absOf(u, rel);
  const st = await statOrNull(abs);
  if (!st) return;
  if (!TRASH_DAYS) {
    await fsp.rm(abs, { recursive: true, force: true });
    adjust(u, -(st.isDirectory() ? await dirSizeSafe(abs) : st.size));
    forgetHashes(u, rel);
    return;
  }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const d = path.join(trashRoot(u), id);
  await fsp.mkdir(d, { recursive: true });
  const size = st.isDirectory() ? await dirSize(abs) : st.size;
  await fsp.rename(abs, path.join(d, "item"));
  const meta: TrashMeta = { id, path: rel, dir: st.isDirectory(), size, deleted: Date.now(), reason };
  await fsp.writeFile(path.join(d, "meta.json"), JSON.stringify(meta));
  adjust(u, -size);
  forgetHashes(u, rel);
}
const dirSizeSafe = async (p: string) => {
  try {
    return await dirSize(p);
  } catch {
    return 0;
  }
};
async function trashList(u: User): Promise<TrashMeta[]> {
  const root = trashRoot(u);
  let ids: string[] = [];
  try {
    ids = await fsp.readdir(root);
  } catch {
    return [];
  }
  const out: TrashMeta[] = [];
  for (const id of ids) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(root, id, "meta.json"), "utf8")));
    } catch {
      /* half-written entry */
    }
  }
  return out.sort((a, b) => b.deleted - a.deleted);
}
export async function purgeTrash() {
  if (!TRASH_DAYS) return;
  const cutoff = Date.now() - TRASH_DAYS * 86400_000;
  const base = path.join(META_DIR, "trash");
  let users: string[] = [];
  try {
    users = await fsp.readdir(base);
  } catch {
    return;
  }
  for (const uid of users) {
    for (const id of await fsp.readdir(path.join(base, uid)).catch(() => [] as string[])) {
      const ms = parseInt(id.split("-")[0], 36);
      if (Number.isFinite(ms) && ms < cutoff) await fsp.rm(path.join(base, uid, id), { recursive: true, force: true });
    }
  }
  // uploads that never finished
  const tbase = path.join(META_DIR, "tmp");
  for (const uid of await fsp.readdir(tbase).catch(() => [] as string[])) {
    for (const f of await fsp.readdir(path.join(tbase, uid)).catch(() => [] as string[])) {
      const st = await statOrNull(path.join(tbase, uid, f));
      if (st && st.mtimeMs < Date.now() - 86400_000) await fsp.rm(path.join(tbase, uid, f), { force: true });
    }
  }
}

/** Remove a user's drive (their token rows go with the user). */
export function removeUserDrive(u: User) {
  fs.rmSync(userRoot(u), { recursive: true, force: true });
  fs.rmSync(trashRoot(u), { recursive: true, force: true });
  fs.rmSync(tmpRoot(u), { recursive: true, force: true });
  db.prepare("DELETE FROM drive_hashes WHERE user_id = ?").run(u.id);
}

// ------------------------------------------------------------------ WebDAV XML
const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", flac: "audio/flac", opus: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml",
  html: "text/html", htm: "text/html", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
};
export const mimeOf = (name: string) => MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

function propXml(href: string, st: fs.Stats, name: string, hashes: { sha1: string; md5: string } | null, quota?: { used: number; avail: number | null }) {
  const dir = st.isDirectory();
  const etag = `"${Math.floor(st.mtimeMs).toString(16)}-${st.size.toString(16)}"`;
  return (
    `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>` +
    `<d:displayname>${xmlEsc(name)}</d:displayname>` +
    `<d:resourcetype>${dir ? "<d:collection/>" : ""}</d:resourcetype>` +
    (dir ? "" : `<d:getcontentlength>${st.size}</d:getcontentlength><d:getcontenttype>${xmlEsc(mimeOf(name))}</d:getcontenttype>`) +
    `<d:getlastmodified>${new Date(st.mtimeMs).toUTCString()}</d:getlastmodified>` +
    `<d:creationdate>${new Date(st.birthtimeMs || st.ctimeMs).toISOString()}</d:creationdate>` +
    `<d:getetag>${etag}</d:getetag>` +
    (hashes ? `<oc:checksums><oc:checksum>SHA1:${hashes.sha1} MD5:${hashes.md5}</oc:checksum></oc:checksums>` : "") +
    (quota ? `<d:quota-used-bytes>${quota.used}</d:quota-used-bytes>${quota.avail != null ? `<d:quota-available-bytes>${quota.avail}</d:quota-available-bytes>` : ""}` : "") +
    `<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}
const MULTI_OPEN = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">`;

// ------------------------------------------------------------------ routes
type Wrap = (fn: (req: any, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;

const tickets = new Map<string, { user: User; rel: string; exp: number }>();

export function registerDriveRoutes(
  app: Express,
  deps: { auth: (req: Request, res: Response, next: NextFunction) => void; sessionUser: (token: string) => User | null; wrap: Wrap; HttpError: new (status: number, message: string) => Error },
) {
  const { auth, wrap, HttpError, sessionUser } = deps;
  const need = () => {
    if (!DRIVE_ON) throw new HttpError(403, "Scute Drive is turned off on this server (SCUTE_DRIVE=off)");
    if (!pluginOn()) throw new HttpError(403, "Scute Drive isn't installed on this server");
  };

  if (TRASH_DAYS) {
    void purgeTrash();
    setInterval(() => purgeTrash().catch((e) => console.error("[drive] trash", e)), 6 * 3600_000).unref();
  }

  // ---------------------------------------------------------------- JSON API for the plug-in
  app.get(
    "/api/drive",
    auth,
    wrap(async (req, res) => {
      const on = DRIVE_ON && pluginOn();
      if (on) ensure(req.user);
      res.json({
        enabled: on,
        username: req.user.username,
        dav: "/dav/",
        used: on ? await used(req.user, req.query.fresh === "1") : 0,
        quota: QUOTA_GB ? QUOTA_GB * 1024 ** 3 : null,
        maxFile: MAX_FILE_GB * 1024 ** 3,
        trashDays: TRASH_DAYS,
        folder: folderName(req.user),
      });
    }),
  );

  app.get(
    "/api/drive/list",
    auth,
    wrap(async (req, res) => {
      need();
      ensure(req.user);
      const rel = cleanRel(String(req.query.path || ""));
      const abs = absOf(req.user, rel);
      const st = await statOrNull(abs);
      if (!st || !st.isDirectory()) throw new HttpError(404, "No such folder");
      const items = [];
      for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
        const s = await statOrNull(path.join(abs, e.name));
        if (!s || (!s.isFile() && !s.isDirectory())) continue;
        items.push({ name: e.name, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: Math.floor(s.mtimeMs), type: s.isDirectory() ? "" : mimeOf(e.name) });
      }
      res.json({ path: rel, items });
    }),
  );

  // Short-lived links to one file, so the browser can stream it (video seeking,
  // big downloads) without the session token in the address. Valid for 6 hours.
  app.post(
    "/api/drive/link",
    auth,
    wrap(async (req, res) => {
      need();
      const rel = cleanRel(String(req.body?.path || ""));
      const st = await statOrNull(absOf(req.user, rel));
      if (!rel || !st?.isFile()) throw new HttpError(404, "No such file");
      const now = Date.now();
      for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
      const tok = crypto.randomBytes(18).toString("base64url");
      tickets.set(tok, { user: req.user, rel, exp: now + 6 * 3600_000 });
      res.json({ url: `/api/drive/f/${tok}/${encodeURIComponent(path.basename(rel))}` });
    }),
  );
  app.get(
    "/api/drive/f/:tok/:name",
    wrap(async (req, res) => {
      const t = tickets.get(String(req.params.tok));
      if (!t || t.exp < Date.now() || !DRIVE_ON) throw new HttpError(404, "This link has expired");
      const abs = absOf(t.user, t.rel);
      const st = await statOrNull(abs);
      if (!st?.isFile()) throw new HttpError(404, "No such file");
      const type = mimeOf(abs);
      const inline = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$|text\/plain$)/.test(type) && req.query.dl !== "1";
      // PDFs need the browser's viewer, which a sandboxed page can't use
      res.setHeader("Content-Security-Policy", type === "application/pdf" && inline ? "default-src 'none'; object-src 'self'; plugin-types application/pdf" : "default-src 'none'; sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
      res.type(inline ? type : "application/octet-stream").sendFile(abs, { dotfiles: "allow", acceptRanges: true, lastModified: true, cacheControl: false }, (err) => {
        if (err && !res.headersSent) res.status(500).end();
      });
    }),
  );

  // walk a folder, for downloading a folder as a zip
  app.get(
    "/api/drive/tree",
    auth,
    wrap(async (req, res) => {
      need();
      const rel = cleanRel(String(req.query.path || ""));
      const out: { path: string; size: number; mtime: number }[] = [];
      const walk = async (r: string) => {
        for (const e of await fsp.readdir(absOf(req.user, r), { withFileTypes: true })) {
          const sub = r ? `${r}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(sub);
          else if (e.isFile()) {
            const s = await statOrNull(absOf(req.user, sub));
            if (s) out.push({ path: sub, size: s.size, mtime: Math.floor(s.mtimeMs) });
          }
          if (out.length > 20000) throw new HttpError(413, "Too many files to download at once");
        }
      };
      await walk(rel);
      res.json({ files: out });
    }),
  );

  app.get(
    "/api/drive/tokens",
    auth,
    wrap((req, res) => {
      const rows = db.prepare("SELECT id, label, created, last_used FROM drive_tokens WHERE user_id = ? ORDER BY created DESC").all(req.user.id);
      res.json({ tokens: rows });
    }),
  );
  app.post(
    "/api/drive/tokens",
    auth,
    express.json(),
    wrap((req, res) => {
      need();
      const label = String(req.body?.label || "").trim().slice(0, 60) || "Device";
      const n = (db.prepare("SELECT COUNT(*) c FROM drive_tokens WHERE user_id = ?").get(req.user.id) as { c: number }).c;
      if (n >= 50) throw new HttpError(400, "That's 50 app passwords already; remove some first");
      // 4 groups of 5 from an unambiguous alphabet: easy to type on a phone
      const A = "abcdefghjkmnpqrstuvwxyz23456789";
      const bytes = crypto.randomBytes(20);
      let token = "";
      for (let i = 0; i < 20; i++) token += (i && i % 5 === 0 ? "-" : "") + A[bytes[i] % A.length];
      const id = crypto.randomBytes(8).toString("hex");
      db.prepare("INSERT INTO drive_tokens (id, user_id, label, token_hash, created) VALUES (?,?,?,?,?)").run(id, req.user.id, label, sha256(token), Date.now());
      res.json({ id, label, token });
    }),
  );
  app.delete(
    "/api/drive/tokens/:id",
    auth,
    wrap((req, res) => {
      db.prepare("DELETE FROM drive_tokens WHERE id = ? AND user_id = ?").run(String(req.params.id), req.user.id);
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/drive/trash",
    auth,
    wrap(async (req, res) => {
      need();
      res.json({ days: TRASH_DAYS, items: await trashList(req.user) });
    }),
  );
  app.post(
    "/api/drive/trash/:id/restore",
    auth,
    express.json(),
    wrap(async (req, res) => {
      need();
      const id = String(req.params.id);
      if (!/^[a-z0-9]+-[a-f0-9]{8}$/.test(id)) throw new HttpError(400, "Bad id");
      const d = path.join(trashRoot(req.user), id);
      const meta = JSON.parse(await fsp.readFile(path.join(d, "meta.json"), "utf8").catch(() => "null")) as TrashMeta | null;
      if (!meta) throw new HttpError(404, "Not in the trash any more");
      const to = req.body?.to != null ? cleanRel(String(req.body.to)) : meta.path;
      const abs = absOf(req.user, to);
      if (await statOrNull(abs)) {
        if (!req.body?.replace) throw new HttpError(409, "Something with that name is there now");
        await toTrash(req.user, to, "replaced");
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.rename(path.join(d, "item"), abs);
      await fsp.rm(d, { recursive: true, force: true });
      adjust(req.user, meta.size);
      res.json({ ok: true, path: to });
    }),
  );
  app.delete(
    "/api/drive/trash/:id",
    auth,
    wrap(async (req, res) => {
      const id = String(req.params.id);
      if (!/^[a-z0-9]+-[a-f0-9]{8}$/.test(id)) throw new HttpError(400, "Bad id");
      await fsp.rm(path.join(trashRoot(req.user), id), { recursive: true, force: true });
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/drive/trash",
    auth,
    wrap(async (req, res) => {
      await fsp.rm(trashRoot(req.user), { recursive: true, force: true });
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- WebDAV
  const failures = new Map<string, { n: number; t: number }>();
  function davUser(req: Request): User | null {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) return sessionUser(h.slice(7));
    if (!h.startsWith("Basic ")) return null;
    const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
    const i = raw.indexOf(":");
    const name = raw.slice(0, i);
    const pass = raw.slice(i + 1).trim().toLowerCase();
    // App passwords are long and random, so a right one always works; wrong ones
    // are slowed down per address and name (behind a proxy every device shares one address).
    const key = `${req.ip || "?"}|${name.toLowerCase()}`;
    const f = failures.get(key);
    const u = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(name) as User | undefined;
    const t = u ? (db.prepare("SELECT id FROM drive_tokens WHERE user_id = ? AND token_hash = ?").get(u.id, sha256(pass)) as { id: string } | undefined) : undefined;
    if (!u || !t) {
      const recent = f && Date.now() - f.t < 15 * 60_000;
      if (recent && f.n >= 20) throw new DavError(429, "Too many wrong passwords. Try again in a few minutes.");
      failures.set(key, { n: (recent ? f.n : 0) + 1, t: Date.now() });
      if (failures.size > 5000) failures.clear();
      return null;
    }
    db.prepare("UPDATE drive_tokens SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)").run(Date.now(), t.id, Date.now() - 60_000);
    return u;
  }

  const prefixOf = (req: Request) => {
    const fwd = String(req.headers["x-forwarded-prefix"] || "").trim().replace(/\/+$/, "");
    return (/^\/[\w./~-]*$/.test(fwd) ? fwd : BASE_PATH) + "/dav";
  };
  /** The drive path a Destination header points at (full URL or path). */
  const destRel = (req: Request): string => {
    const d = String(req.headers.destination || "");
    if (!d) throw new DavError(400, "Destination missing");
    let p: string;
    try {
      p = new URL(d, "http://x").pathname;
    } catch {
      throw new DavError(400, "Bad Destination");
    }
    const at = p.indexOf("/dav/") >= 0 ? p.indexOf("/dav/") : p.endsWith("/dav") ? p.length - 4 : -1;
    if (at < 0) throw new DavError(502, "Destination is on another server");
    return cleanRel(p.slice(at + 4));
  };

  const dav = async (req: Request, res: Response) => {
    res.setHeader("DAV", "1, 2");
    res.setHeader("MS-Author-Via", "DAV");
    if (req.method === "OPTIONS") {
      res.setHeader("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK");
      return res.status(200).end();
    }
    if (!DRIVE_ON || !pluginOn()) return res.status(503).type("text").send("Scute Drive isn't installed or is turned off on this server");
    const user = davUser(req);
    if (!user) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Scute Drive", charset="UTF-8"');
      return res.status(401).type("text").send("Sign in with your Scute username and a Scute Drive app password");
    }
    ensure(user);
    const rel = cleanRel(req.path.replace(/^\/dav/, ""));
    const abs = absOf(user, rel);
    const href = (r: string, dir: boolean) => `${prefixOf(req)}/${encPath(r)}${dir && r ? "/" : ""}`.replace(/\/\/+/g, "/");
    const st = await statOrNull(abs);

    switch (req.method) {
      case "PROPFIND": {
        if (!st) return res.status(404).end();
        const depth = String(req.headers.depth ?? "1");
        if (depth === "infinity") return res.status(403).type("text").send("Depth: infinity isn't supported");
        req.resume();
        let q: { used: number; avail: number | null } | undefined;
        if (rel === "") {
          const u = await used(user);
          // free space: what's left of the quota, and never more than the disk has
          const disk = await fsp.statfs(DRIVE_DIR).then((f) => f.bavail * f.bsize).catch(() => null);
          const left = QUOTA_GB ? Math.max(0, QUOTA_GB * 1024 ** 3 - u) : null;
          q = { used: u, avail: left == null ? disk : disk == null ? left : Math.min(left, disk) };
        }
        let body = MULTI_OPEN + propXml(href(rel, st.isDirectory()), st, rel.split("/").pop() || "", st.isFile() ? hashOf(user, rel, st) : null, q);
        if (st.isDirectory() && depth !== "0") {
          for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
            const sub = rel ? `${rel}/${e.name}` : e.name;
            const s = await statOrNull(path.join(abs, e.name));
            if (!s || (!s.isFile() && !s.isDirectory())) continue;
            body += propXml(href(sub, s.isDirectory()), s, e.name, s.isFile() ? hashOf(user, sub, s) : null);
          }
        }
        body += "</d:multistatus>";
        return res.status(207).type("application/xml; charset=utf-8").send(body);
      }
      case "PROPPATCH": {
        if (!st) return res.status(404).end();
        const xml = await readSmall(req);
        // modification times: <d:getlastmodified>, Windows' <Win32LastModifiedTime>, or <oc:lastmodified> (seconds)
        const m = /<(?:[\w-]+:)?(getlastmodified|Win32LastModifiedTime|lastmodified)[^>]*>([^<]+)</i.exec(xml);
        if (m) {
          const v = m[2].trim();
          const t = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v);
          if (Number.isFinite(t)) await fsp.utimes(abs, new Date(), new Date(t));
        }
        const props = [...xml.matchAll(/<(?:([\w-]+):)?([\w-]+)\s*(?:\/>|>[^<]*<\/)/g)].map((x) => x[2]).filter((n) => !["set", "prop", "propertyupdate", "remove"].includes(n));
        let body = MULTI_OPEN + `<d:response><d:href>${xmlEsc(href(rel, st.isDirectory()))}</d:href><d:propstat><d:prop>`;
        for (const p of props) body += `<d:${p.replace(/[^\w-]/g, "")}/>`;
        body += "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";
        return res.status(207).type("application/xml; charset=utf-8").send(body);
      }
      case "GET":
      case "HEAD": {
        if (!st) return res.status(404).end();
        if (st.isDirectory()) {
          if (req.method === "HEAD") return res.status(200).type("text/html").end();
          // a plain listing, so a browser pointed at /dav/ shows something useful
          const items = (await fsp.readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isFile()).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
          return res
            .status(200)
            .type("text/html; charset=utf-8")
            .send(
              `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Scute Drive /${xmlEsc(rel)}</title><style>body{font:15px system-ui;margin:2em}a{display:block;padding:2px 0}</style><h1>/${xmlEsc(rel)}</h1>` +
                (rel ? `<a href="../">../</a>` : "") +
                items.map((e) => `<a href="${encodeURIComponent(e.name)}${e.isDirectory() ? "/" : ""}">${xmlEsc(e.name)}${e.isDirectory() ? "/" : ""}</a>`).join(""),
            );
        }
        // never let a stored file run as a page on this origin
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader("X-Content-Type-Options", "nosniff");
        const type = mimeOf(abs);
        const safeInline = /^(image\/(?!svg)|video\/|audio\/|application\/pdf$|text\/plain$)/.test(type);
        res.setHeader("Content-Disposition", `${safeInline && req.query.dl !== "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
        const h = hashOf(user, rel, st);
        if (h) res.setHeader("OC-Checksum", `SHA1:${h.sha1}`);
        return res.type(safeInline ? type : "application/octet-stream").sendFile(abs, { dotfiles: "allow", acceptRanges: true, lastModified: true, cacheControl: false, etag: true }, (err) => {
          if (err && !res.headersSent) res.status(500).end();
        });
      }
      case "PUT": {
        if (st?.isDirectory()) return res.status(405).type("text").send("That's a folder");
        const parent = await statOrNull(path.dirname(abs));
        if (!rel || !parent?.isDirectory()) return res.status(409).type("text").send("The folder for this file doesn't exist");
        const len = Number(req.headers["content-length"] || -1);
        const maxFile = MAX_FILE_GB * 1024 ** 3;
        if (len > maxFile) return res.status(413).type("text").send(`Files can be up to ${MAX_FILE_GB} GB on this server`);
        if (QUOTA_GB && len > 0 && (await used(user)) - (st?.size || 0) + len > QUOTA_GB * 1024 ** 3) return res.status(507).type("text").send("Your Scute Drive is full");
        const tmp = path.join(tmpRoot(user), `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`);
        const sha1 = crypto.createHash("sha1"),
          md5 = crypto.createHash("md5");
        let n = 0;
        const tap = new Transform({
          transform(chunk, _e, cb) {
            n += chunk.length;
            if (n > maxFile) return cb(new DavError(413, "Too big"));
            sha1.update(chunk);
            md5.update(chunk);
            cb(null, chunk);
          },
        });
        try {
          await pipeline(req, tap, fs.createWriteStream(tmp));
        } catch (e) {
          await fsp.rm(tmp, { force: true });
          if (e instanceof DavError) return res.status(e.status).type("text").send(e.message);
          return res.status(400).type("text").send("The upload was cut short");
        }
        if (len >= 0 && n !== len) {
          await fsp.rm(tmp, { force: true });
          return res.status(400).type("text").send("The upload was cut short");
        }
        // modification time: ownCloud's X-OC-Mtime (rclone, Round Sync), or X-Mtime
        const mt = Number(req.headers["x-oc-mtime"] || req.headers["x-mtime"] || 0);
        if (mt > 0) await fsp.utimes(tmp, new Date(), new Date(mt * 1000));
        if (st) await toTrash(user, rel, "replaced");
        await fsp.rename(tmp, abs);
        adjust(user, n);
        const fin = await fsp.stat(abs);
        db.prepare("INSERT OR REPLACE INTO drive_hashes (user_id, path, size, mtime, sha1, md5) VALUES (?,?,?,?,?,?)").run(user.id, rel, fin.size, Math.floor(fin.mtimeMs), sha1.digest("hex"), md5.digest("hex"));
        if (mt > 0) res.setHeader("X-OC-Mtime", "accepted");
        res.setHeader("ETag", `"${Math.floor(fin.mtimeMs).toString(16)}-${fin.size.toString(16)}"`);
        return res.status(st ? 204 : 201).end();
      }
      case "DELETE": {
        if (!st) return res.status(404).end();
        if (!rel) return res.status(403).type("text").send("The drive itself can't be deleted");
        await toTrash(user, rel, "deleted");
        return res.status(204).end();
      }
      case "MKCOL": {
        if (Number(req.headers["content-length"] || 0) > 0) return res.status(415).end();
        if (st) return res.status(405).type("text").send("Already exists");
        const parent = await statOrNull(path.dirname(abs));
        if (!parent?.isDirectory()) return res.status(409).type("text").send("The parent folder doesn't exist");
        try {
          await fsp.mkdir(abs);
        } catch (e: any) {
          if (e?.code === "EEXIST") return res.status(405).type("text").send("Already exists");
          throw e;
        }
        return res.status(201).end();
      }
      case "MOVE":
      case "COPY": {
        if (!st) return res.status(404).end();
        if (!rel) return res.status(403).end();
        const to = destRel(req);
        if (!to) return res.status(403).end();
        if (to === rel) return res.status(403).type("text").send("Source and destination are the same");
        if (to.startsWith(rel + "/")) return res.status(409).type("text").send("Can't put a folder inside itself");
        const toAbs = absOf(user, to);
        const parent = await statOrNull(path.dirname(toAbs));
        if (!parent?.isDirectory()) return res.status(409).type("text").send("The destination folder doesn't exist");
        const exists = await statOrNull(toAbs);
        const overwrite = String(req.headers.overwrite || "T").toUpperCase() !== "F";
        if (exists && !overwrite) return res.status(412).type("text").send("Something with that name is already there");
        if (exists) await toTrash(user, to, "replaced");
        if (req.method === "MOVE") {
          // a change of case only ("a.txt" → "A.txt") works on case-insensitive disks too
          await fsp.rename(abs, toAbs);
          moveHashes(user, rel, to, false);
        } else {
          if (QUOTA_GB) {
            const add = st.isDirectory() ? await dirSize(abs) : st.size;
            if ((await used(user)) + add > QUOTA_GB * 1024 ** 3) return res.status(507).type("text").send("Your Scute Drive is full");
          }
          await fsp.cp(abs, toAbs, { recursive: true, preserveTimestamps: true, errorOnExist: false });
          adjust(user, st.isDirectory() ? await dirSize(toAbs) : st.size);
          moveHashes(user, rel, to, true);
        }
        return res.status(exists ? 204 : 201).end();
      }
      case "LOCK": {
        // pretend locks, for clients (Windows, macOS, Office) that won't write without one
        await readSmall(req);
        const token = `opaquelocktoken:${crypto.randomUUID()}`;
        if (!st) {
          const parent = await statOrNull(path.dirname(abs));
          if (!parent?.isDirectory()) return res.status(409).end();
          await fsp.writeFile(abs, "");
        }
        res.setHeader("Lock-Token", `<${token}>`);
        return res
          .status(st ? 200 : 201)
          .type("application/xml; charset=utf-8")
          .send(
            `<?xml version="1.0" encoding="utf-8"?><d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>0</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken><d:lockroot><d:href>${xmlEsc(href(rel, false))}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`,
          );
      }
      case "UNLOCK":
        return res.status(204).end();
      default:
        res.setHeader("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK");
        return res.status(405).end();
    }
  };

  app.use((req, res, next) => {
    if (req.path !== "/dav" && !req.path.startsWith("/dav/")) return next();
    dav(req, res).catch((e) => {
      const status = e instanceof DavError ? e.status : e?.code === "ENOENT" ? 404 : e?.code === "ENOSPC" ? 507 : e?.code === "EACCES" ? 403 : 500;
      if (status === 500) console.error("Scute Drive:", e);
      if (!res.headersSent) res.status(status).type("text").send(e?.message || "Error");
    });
  });
}

async function readSmall(req: Request): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 256 * 1024) throw new DavError(413, "Too big");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
