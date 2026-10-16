// Library: ebooks, magazines and comics, with an OPDS catalog for e-reader apps.
//
// E-reader apps (KOReader, Thorium, Moon+ Reader, Librera, Panels, Chunky…) can't
// decrypt Scute's notes, so like Scute Drive the books are ordinary files on the
// server, one folder per book, and their details live in a plain table. The
// Library plug-in (scute-extras) uploads them and fills in the details, reading
// them from the files and from free online catalogues in the browser.
//
//   $SCUTE_LIBRARY_DIR/<user id>/<book id>/book.<format>   (one file per format)
//                                         /cover.jpg
//
// /api/library/*  JSON for the plug-in (session sign-in)
// /api/library/k/<key>/...  covers and downloads by signed link (no sign-in, for <img>)
// /opds/*         OPDS 1.2 catalog, HTTP Basic with the username and a Library app password

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
import { registerBookSearchRoutes } from "./booksearch";

const off = (v: string | undefined, d: string) => ["off", "0", "false", "no"].includes((v || d).toLowerCase());
export const LIBRARY_ON = PLUGINS_ON && !off(process.env.SCUTE_LIBRARY, "on");
const LIB_DIR = path.resolve(process.env.SCUTE_LIBRARY_DIR || path.join(DATA_DIR, "library"));
const TMP_DIR = path.join(LIB_DIR, ".tmp");
const MAX_MB = Math.max(1, Number(process.env.SCUTE_LIBRARY_MAX_MB || 1024));
const BASE_PATH = (process.env.SCUTE_BASE_PATH || "").replace(/\/+$/, "");
const PAGE = 50;

db.exec(`
CREATE TABLE IF NOT EXISTS library_books (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'book',
  title TEXT NOT NULL,
  sort_title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  series TEXT,
  series_index REAL,
  issue TEXT,
  publisher TEXT,
  published TEXT,
  language TEXT,
  isbn TEXT,
  identifiers TEXT NOT NULL DEFAULT '{}',
  description TEXT,
  subjects TEXT NOT NULL DEFAULT '[]',
  pages INTEGER,
  rating INTEGER,
  files TEXT NOT NULL DEFAULT '[]',
  cover INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL,
  modified INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_books_user ON library_books(user_id, sort_title);
CREATE TABLE IF NOT EXISTS library_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS library_tokens_user ON library_tokens(user_id);
`);

interface User {
  id: string;
  username: string;
}
interface BookFile {
  format: string;
  name: string;
  size: number;
  sha1: string;
  added: number;
}
interface Row {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  sort_title: string;
  authors: string;
  series: string | null;
  series_index: number | null;
  issue: string | null;
  publisher: string | null;
  published: string | null;
  language: string | null;
  isbn: string | null;
  identifiers: string;
  description: string | null;
  subjects: string;
  pages: number | null;
  rating: number | null;
  files: string;
  cover: number;
  added: number;
  modified: number;
}
export interface Book {
  id: string;
  kind: "book" | "magazine" | "comic";
  title: string;
  sortTitle: string;
  authors: string[];
  series: string | null;
  seriesIndex: number | null;
  issue: string | null;
  publisher: string | null;
  published: string | null;
  language: string | null;
  isbn: string | null;
  identifiers: Record<string, string>;
  description: string | null;
  subjects: string[];
  pages: number | null;
  rating: number | null;
  files: BookFile[];
  cover: number; // 0 = none, otherwise when it last changed (for cache-busting)
  added: number;
  modified: number;
}

const J = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) ?? d;
  } catch {
    return d;
  }
};
const toBook = (r: Row): Book => ({
  id: r.id,
  kind: (["book", "magazine", "comic"].includes(r.kind) ? r.kind : "book") as Book["kind"],
  title: r.title,
  sortTitle: r.sort_title,
  authors: J<string[]>(r.authors, []),
  series: r.series,
  seriesIndex: r.series_index,
  issue: r.issue,
  publisher: r.publisher,
  published: r.published,
  language: r.language,
  isbn: r.isbn,
  identifiers: J<Record<string, string>>(r.identifiers, {}),
  description: r.description,
  subjects: J<string[]>(r.subjects, []),
  pages: r.pages,
  rating: r.rating,
  files: J<BookFile[]>(r.files, []),
  cover: r.cover,
  added: r.added,
  modified: r.modified,
});

// formats we keep; anything else is refused so the folder stays a library
export const FORMATS: Record<string, string> = {
  epub: "application/epub+zip",
  kepub: "application/kepub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/x-mobi8-ebook",
  kfx: "application/vnd.amazon.ebook",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook-rar",
  cb7: "application/x-cb7",
  cbt: "application/x-cbt",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-zip-compressed-fb2",
  djvu: "image/vnd.djvu",
  txt: "text/plain; charset=utf-8",
  rtf: "application/rtf",
  html: "text/html; charset=utf-8",
  htmlz: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  doc: "application/msword",
  chm: "application/vnd.ms-htmlhelp",
  lit: "application/x-ms-reader",
  pdb: "application/vnd.palm",
  lrf: "application/x-sony-bbeb",
  m4b: "audio/mp4",
  mp3: "audio/mpeg",
};
/** "Dune.kepub.epub" → kepub, "x.FB2.zip" → fbz, "Dune.epub" → epub */
export function formatOf(name: string): string | null {
  const n = name.toLowerCase();
  if (n.endsWith(".kepub.epub")) return "kepub";
  if (n.endsWith(".fb2.zip")) return "fbz";
  const ext = n.split(".").pop() || "";
  return FORMATS[ext] ? ext : null;
}
const mimeOf = (fmt: string) => FORMATS[fmt] || "application/octet-stream";

export function sortTitleOf(t: string): string {
  return t
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\s*(the|a|an|der|die|das|le|la|les|el|los|las|il|lo)\s+/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .toLowerCase();
}
/** "Ursula K. Le Guin" → "le guin, ursula k." for sorting authors by family name */
export function authorSort(a: string): string {
  const s = a.trim();
  if (s.includes(",")) return s.toLowerCase();
  const parts = s.split(/\s+/);
  if (parts.length < 2) return s.toLowerCase();
  let i = parts.length - 1;
  if (/^(jr\.?|sr\.?|ii|iii|iv|phd|md)$/i.test(parts[i]) && i > 1) i--;
  while (i > 1 && /^(van|von|de|der|den|del|della|di|da|le|la|du|st\.?|mac|bin|ibn)$/i.test(parts[i - 1])) i--;
  return `${parts.slice(i).join(" ")}, ${parts.slice(0, i).join(" ")}`.toLowerCase();
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function secret(): Buffer {
  const row = db.prepare("SELECT v FROM meta WHERE k = 'library_secret'").get() as { v: string } | undefined;
  if (row) return Buffer.from(row.v, "hex");
  const v = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('library_secret', ?)").run(v);
  return Buffer.from((db.prepare("SELECT v FROM meta WHERE k = 'library_secret'").get() as { v: string }).v, "hex");
}
/** A key for signed links: <user>.<expires>.<sig>. Lasts a week; a new one every day so URLs stay cacheable. */
function linkKey(userId: string): string {
  const exp = (Math.floor(Date.now() / 86_400_000) + 8) * 86_400_000;
  const sig = crypto.createHmac("sha256", secret()).update(`${userId}.${exp}`).digest("base64url").slice(0, 32);
  return `${userId}.${exp}.${sig}`;
}
function keyUser(key: string): string | null {
  const [uid, exp, sig] = key.split(".");
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  const want = crypto.createHmac("sha256", secret()).update(`${uid}.${exp}`).digest("base64url").slice(0, 32);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return uid;
}

/** Is a plug-in with the "library" permission switched on? */
function pluginOn(): boolean {
  try {
    return listPlugins().some((p) => p.enabled && !p.error && p.permissions.includes("library"));
  } catch {
    return false;
  }
}

const idOk = (id: string) => /^[a-f0-9]{16,32}$/.test(id);
const userDir = (uid: string) => path.join(LIB_DIR, uid);
const bookDir = (uid: string, id: string) => {
  if (!idOk(id) || !/^[\w-]+$/.test(uid)) throw new Error("Bad id");
  return path.join(userDir(uid), id);
};

let bookSearch: { removeUser(uid: string): void } | null = null;

export function removeUserLibrary(u: User) {
  bookSearch?.removeUser(u.id);
  try {
    fs.rmSync(userDir(u.id), { recursive: true, force: true });
    db.prepare("DELETE FROM library_books WHERE user_id = ?").run(u.id);
    db.prepare("DELETE FROM library_tokens WHERE user_id = ?").run(u.id);
  } catch (e) {
    console.error("[library] remove user", e);
  }
}

const getRow = (uid: string, id: string) => db.prepare("SELECT * FROM library_books WHERE id = ? AND user_id = ?").get(id, uid) as Row | undefined;

/** Stream the request body to a temporary file, with its SHA-1, refusing anything over the limit. */
async function receive(req: Request, HttpError: new (s: number, m: string) => Error): Promise<{ tmp: string; size: number; sha1: string }> {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const tmp = path.join(TMP_DIR, crypto.randomBytes(12).toString("hex"));
  const h = crypto.createHash("sha1");
  let size = 0;
  const max = MAX_MB * 1024 * 1024;
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > max) throw new HttpError(413, `That file is bigger than this server's limit of ${MAX_MB} MB (SCUTE_LIBRARY_MAX_MB)`);
  const meter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      size += chunk.length;
      if (size > max) return cb(new HttpError(413, `That file is bigger than this server's limit of ${MAX_MB} MB (SCUTE_LIBRARY_MAX_MB)`));
      h.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, fs.createWriteStream(tmp, { mode: 0o644 }));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  if (!size) {
    await fsp.rm(tmp, { force: true });
    throw new HttpError(400, "The file is empty");
  }
  return { tmp, size, sha1: h.digest("hex") };
}

const cleanName = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

/** "Author - Title.epub" for downloads */
function downloadName(b: Book, f: BookFile): string {
  const ext = f.format === "kepub" ? "kepub.epub" : f.format === "fbz" ? "fb2.zip" : f.format;
  const who = b.authors[0] ? `${b.authors[0]} - ` : "";
  const what = b.kind !== "book" && b.issue && !b.title.includes(b.issue) ? `${b.title} ${b.issue}` : b.title;
  return `${cleanName(who + what) || "book"}.${ext}`;
}

type Wrap = (fn: (req: any, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;

const str = (v: unknown, max: number): string | null => {
  if (v == null || v === "") return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\u0000/g, "").trim();
  return s ? s.slice(0, max) : null;
};
const strList = (v: unknown, n: number, max: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const s = str(x, max);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
    if (out.length >= n) break;
  }
  return out;
};

/** Apply metadata from the plug-in (only the fields it sends). */
function applyMeta(r: Row, m: Record<string, unknown>) {
  if ("title" in m) {
    r.title = str(m.title, 500) || r.title || "Untitled";
    r.sort_title = sortTitleOf(r.title);
  }
  if ("sortTitle" in m && str(m.sortTitle, 500)) r.sort_title = sortTitleOf(String(m.sortTitle));
  if ("kind" in m && ["book", "magazine", "comic"].includes(String(m.kind))) r.kind = String(m.kind);
  if ("authors" in m) r.authors = JSON.stringify(strList(m.authors, 30, 200));
  if ("series" in m) r.series = str(m.series, 300);
  if ("seriesIndex" in m) {
    const n = Number(m.seriesIndex);
    r.series_index = m.seriesIndex == null || m.seriesIndex === "" || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
  }
  if ("issue" in m) r.issue = str(m.issue, 100);
  if ("publisher" in m) r.publisher = str(m.publisher, 300);
  if ("published" in m) r.published = str(m.published, 40);
  if ("language" in m) r.language = str(m.language, 20)?.toLowerCase() || null;
  if ("isbn" in m) r.isbn = str(m.isbn, 20)?.replace(/[^0-9Xx]/g, "").toUpperCase() || null;
  if ("identifiers" in m && m.identifiers && typeof m.identifiers === "object") {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.identifiers as Record<string, unknown>).slice(0, 20)) {
      const kk = k.replace(/[^\w:-]/g, "").slice(0, 40);
      const vv = str(v, 200);
      if (kk && vv) o[kk] = vv;
    }
    r.identifiers = JSON.stringify(o);
  }
  if ("description" in m) r.description = str(m.description, 20000);
  if ("subjects" in m) r.subjects = JSON.stringify(strList(m.subjects, 40, 120));
  if ("pages" in m) {
    const n = Number(m.pages);
    r.pages = Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n) : null;
  }
  if ("rating" in m) {
    const n = Number(m.rating);
    r.rating = Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null;
  }
}

function saveRow(r: Row) {
  db.prepare(
    `INSERT INTO library_books (id, user_id, kind, title, sort_title, authors, series, series_index, issue, publisher, published, language, isbn, identifiers, description, subjects, pages, rating, files, cover, added, modified)
     VALUES (@id, @user_id, @kind, @title, @sort_title, @authors, @series, @series_index, @issue, @publisher, @published, @language, @isbn, @identifiers, @description, @subjects, @pages, @rating, @files, @cover, @added, @modified)
     ON CONFLICT(id) DO UPDATE SET kind=@kind, title=@title, sort_title=@sort_title, authors=@authors, series=@series, series_index=@series_index, issue=@issue, publisher=@publisher, published=@published,
       language=@language, isbn=@isbn, identifiers=@identifiers, description=@description, subjects=@subjects, pages=@pages, rating=@rating, files=@files, cover=@cover, modified=@modified`,
  ).run(r);
}

/** Which of this user's books already has a file with this SHA-1? */
function findBySha(uid: string, sha1: string): { id: string; format: string } | null {
  const rows = db.prepare("SELECT id, files FROM library_books WHERE user_id = ? AND files LIKE ?").all(uid, `%${sha1}%`) as { id: string; files: string }[];
  for (const r of rows) {
    const f = J<BookFile[]>(r.files, []).find((x) => x.sha1 === sha1);
    if (f) return { id: r.id, format: f.format };
  }
  return null;
}

/** Image type from the first bytes (covers are the plug-in's JPEGs, but be safe). */
function imageType(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  return null;
}

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
const prefixOf = (req: Request) => {
  const fwd = String(req.headers["x-forwarded-prefix"] || "").trim().replace(/\/+$/, "");
  return /^\/[\w./~-]*$/.test(fwd) ? fwd : BASE_PATH;
};

export function registerLibraryRoutes(
  app: Express,
  deps: { auth: (req: Request, res: Response, next: NextFunction) => void; sessionUser: (token: string) => User | null; wrap: Wrap; HttpError: new (status: number, message: string) => Error },
) {
  const { auth, wrap, HttpError, sessionUser } = deps;
  const need = () => {
    if (!LIBRARY_ON) throw new HttpError(403, "The library is turned off on this server (SCUTE_LIBRARY=off)");
    if (!pluginOn()) throw new HttpError(403, "The Library plug-in isn't installed on this server");
  };
  bookSearch = registerBookSearchRoutes(app, { auth, wrap, HttpError, need, libDir: LIB_DIR, maxBytes: MAX_MB * 1024 * 1024 });
  // leftovers from uploads cut off half-way
  fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});

  // ---------------------------------------------------------------- JSON API for the plug-in
  app.get(
    "/api/library",
    auth,
    wrap((req, res) => {
      const on = LIBRARY_ON && pluginOn();
      const st = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(json_array_length(files)), 0) f FROM library_books WHERE user_id = ?").get(req.user.id) as { n: number; f: number };
      let bytes = 0;
      if (on) for (const r of db.prepare("SELECT files FROM library_books WHERE user_id = ?").all(req.user.id) as { files: string }[]) for (const f of J<BookFile[]>(r.files, [])) bytes += f.size;
      res.json({ enabled: on, username: req.user.username, opds: "/opds/", key: linkKey(req.user.id), books: st.n, files: st.f, bytes, maxFile: MAX_MB * 1024 * 1024, formats: Object.keys(FORMATS) });
    }),
  );

  app.get(
    "/api/library/books",
    auth,
    wrap((req, res) => {
      need();
      const rows = db.prepare("SELECT * FROM library_books WHERE user_id = ? ORDER BY sort_title").all(req.user.id) as Row[];
      res.json({ books: rows.map(toBook) });
    }),
  );
  app.get(
    "/api/library/books/:id",
    auth,
    wrap((req, res) => {
      need();
      const r = getRow(req.user.id, String(req.params.id));
      if (!r) throw new HttpError(404, "No such book");
      res.json(toBook(r));
    }),
  );

  // New book from one file: POST raw bytes, ?name=<file name>. Details come after with PUT.
  // A file that's already in the library isn't stored twice: { duplicate: { id, format } }.
  app.post(
    "/api/library/books",
    auth,
    wrap(async (req, res) => {
      need();
      const name = cleanName(String(req.query.name || ""));
      const fmt = formatOf(name);
      if (!fmt) throw new HttpError(415, `Scute's library doesn't keep ${name.split(".").pop() ? "." + name.split(".").pop() : "files like that"} files`);
      const up = await receive(req, HttpError);
      const dup = findBySha(req.user.id, up.sha1);
      if (dup) {
        await fsp.rm(up.tmp, { force: true });
        return res.json({ duplicate: dup, book: toBook(getRow(req.user.id, dup.id)!) });
      }
      const id = crypto.randomBytes(12).toString("hex");
      const dir = bookDir(req.user.id, id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.rename(up.tmp, path.join(dir, `book.${fmt}`));
      const now = Date.now();
      const title = name.replace(/\.(kepub\.epub|fb2\.zip|[a-z0-9]+)$/i, "").trim() || "Untitled";
      const r: Row = {
        id,
        user_id: req.user.id,
        kind: /^cb[zr7t]$/.test(fmt) ? "comic" : "book",
        title,
        sort_title: sortTitleOf(title),
        authors: "[]",
        series: null,
        series_index: null,
        issue: null,
        publisher: null,
        published: null,
        language: null,
        isbn: null,
        identifiers: "{}",
        description: null,
        subjects: "[]",
        pages: null,
        rating: null,
        files: JSON.stringify([{ format: fmt, name, size: up.size, sha1: up.sha1, added: now }]),
        cover: 0,
        added: now,
        modified: now,
      };
      const meta = String(req.headers["x-library-meta"] || "");
      if (meta) {
        try {
          applyMeta(r, JSON.parse(decodeURIComponent(meta)));
        } catch {
          /* details can be sent with PUT instead */
        }
      }
      saveRow(r);
      res.json({ book: toBook(r) });
    }),
  );

  // another format of the same book (replaces that format if it's there)
  app.post(
    "/api/library/books/:id/files",
    auth,
    wrap(async (req, res) => {
      need();
      const r = getRow(req.user.id, String(req.params.id));
      if (!r) throw new HttpError(404, "No such book");
      const name = cleanName(String(req.query.name || ""));
      const fmt = formatOf(name);
      if (!fmt) throw new HttpError(415, "Scute's library doesn't keep files like that");
      const up = await receive(req, HttpError);
      const dup = findBySha(req.user.id, up.sha1);
      if (dup && dup.id !== r.id) {
        await fsp.rm(up.tmp, { force: true });
        return res.json({ duplicate: dup, book: toBook(getRow(req.user.id, dup.id)!) });
      }
      await fsp.rename(up.tmp, path.join(bookDir(req.user.id, r.id), `book.${fmt}`));
      const files = J<BookFile[]>(r.files, []).filter((f) => f.format !== fmt);
      files.push({ format: fmt, name, size: up.size, sha1: up.sha1, added: Date.now() });
      r.files = JSON.stringify(files);
      r.modified = Date.now();
      saveRow(r);
      res.json({ book: toBook(r) });
    }),
  );
  app.delete(
    "/api/library/books/:id/files/:format",
    auth,
    wrap(async (req, res) => {
      need();
      const r = getRow(req.user.id, String(req.params.id));
      if (!r) throw new HttpError(404, "No such book");
      const fmt = String(req.params.format);
      const files = J<BookFile[]>(r.files, []);
      if (!files.some((f) => f.format === fmt)) throw new HttpError(404, "That book has no such format");
      if (files.length === 1) throw new HttpError(400, "That's the book's only file; delete the book instead");
      await fsp.rm(path.join(bookDir(req.user.id, r.id), `book.${fmt}`), { force: true });
      r.files = JSON.stringify(files.filter((f) => f.format !== fmt));
      r.modified = Date.now();
      saveRow(r);
      res.json({ book: toBook(r) });
    }),
  );

  app.put(
    "/api/library/books/:id",
    auth,
    express.json({ limit: "2mb" }),
    wrap((req, res) => {
      need();
      const r = getRow(req.user.id, String(req.params.id));
      if (!r) throw new HttpError(404, "No such book");
      if (!req.body || typeof req.body !== "object") throw new HttpError(400, "Send the details as JSON");
      applyMeta(r, req.body);
      r.modified = Date.now();
      saveRow(r);
      res.json({ book: toBook(r) });
    }),
  );

  app.put(
    "/api/library/books/:id/cover",
    auth,
    express.raw({ type: () => true, limit: "15mb" }),
    wrap(async (req, res) => {
      need();
      const r = getRow(req.user.id, String(req.params.id));
      if (!r) throw new HttpError(404, "No such book");
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!imageType(buf)) throw new HttpError(415, "A cover must be a JPEG, PNG, WebP or GIF picture");
      await fsp.writeFile(path.join(bookDir(req.user.id, r.id), "cover.jpg"), buf, { mode: 0o644 });
      r.cover = Date.now();
      r.modified = r.cover;
      saveRow(r);
      res.json({ book: toBook(r) });
    }),
  );
  app.delete(
    "/api/library/books/:id/cover",
    auth,
    wrap(async (req, res) => {
      need();
      const r = getRow(req.user.id, String(req.params.id));
      if (!r) throw new HttpError(404, "No such book");
      await fsp.rm(path.join(bookDir(req.user.id, r.id), "cover.jpg"), { force: true });
      r.cover = 0;
      r.modified = Date.now();
      saveRow(r);
      res.json({ book: toBook(r) });
    }),
  );

  app.delete(
    "/api/library/books/:id",
    auth,
    wrap(async (req, res) => {
      need();
      const id = String(req.params.id);
      const r = getRow(req.user.id, id);
      if (!r) return res.json({ ok: true });
      await fsp.rm(bookDir(req.user.id, id), { recursive: true, force: true });
      db.prepare("DELETE FROM library_books WHERE id = ? AND user_id = ?").run(id, req.user.id);
      res.json({ ok: true });
    }),
  );

  // signed links: covers for <img> and downloads, without the session token in the address
  const sendFile = (res: Response, abs: string, type: string, disposition: string | null, cache: string) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", cache);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    res.type(type).sendFile(abs, { dotfiles: "allow", acceptRanges: true, lastModified: true, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).type("text").send("Not found");
    });
  };
  const attach = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  app.get(
    "/api/library/k/:key/cover/:id.jpg",
    wrap((req, res) => {
      const uid = keyUser(String(req.params.key));
      const r = uid && LIBRARY_ON ? getRow(uid, String(req.params.id)) : undefined;
      if (!r || !r.cover) throw new HttpError(404, "No cover");
      const abs = path.join(bookDir(uid!, r.id), "cover.jpg");
      const head = Buffer.alloc(12);
      try {
        const fd = fs.openSync(abs, "r");
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
      } catch {
        throw new HttpError(404, "No cover");
      }
      sendFile(res, abs, imageType(head) || "image/jpeg", null, "private, max-age=604800, immutable");
    }),
  );
  app.get(
    "/api/library/k/:key/file/:id/:format{/:name}",
    wrap((req, res) => {
      const uid = keyUser(String(req.params.key));
      const r = uid && LIBRARY_ON ? getRow(uid, String(req.params.id)) : undefined;
      const b = r ? toBook(r) : null;
      const f = b?.files.find((x) => x.format === req.params.format);
      if (!b || !f) throw new HttpError(404, "No such book");
      const inline = req.query.view === "1" && f.format === "pdf";
      if (inline) res.setHeader("Content-Security-Policy", "default-src 'none'; object-src 'self'; plugin-types application/pdf");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("Content-Disposition", inline ? `inline; filename*=UTF-8''${encodeURIComponent(downloadName(b, f))}` : attach(downloadName(b, f)));
      if (!inline) res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.type(mimeOf(f.format)).sendFile(path.join(bookDir(uid!, b.id), `book.${f.format}`), { dotfiles: "allow", acceptRanges: true, lastModified: true, cacheControl: false }, (err) => {
        if (err && !res.headersSent) res.status(404).type("text").send("Not found");
      });
    }),
  );

  // app passwords for e-reader apps
  app.get(
    "/api/library/tokens",
    auth,
    wrap((req, res) => {
      const rows = db.prepare("SELECT id, label, created, last_used FROM library_tokens WHERE user_id = ? ORDER BY created DESC").all(req.user.id);
      res.json({ tokens: rows });
    }),
  );
  app.post(
    "/api/library/tokens",
    auth,
    express.json(),
    wrap((req, res) => {
      need();
      const label = String(req.body?.label || "").trim().slice(0, 60) || "E-reader";
      const n = (db.prepare("SELECT COUNT(*) c FROM library_tokens WHERE user_id = ?").get(req.user.id) as { c: number }).c;
      if (n >= 50) throw new HttpError(400, "That's 50 app passwords already; remove some first");
      const A = "abcdefghjkmnpqrstuvwxyz23456789";
      const bytes = crypto.randomBytes(20);
      let token = "";
      for (let i = 0; i < 20; i++) token += (i && i % 5 === 0 ? "-" : "") + A[bytes[i] % A.length];
      const id = crypto.randomBytes(8).toString("hex");
      db.prepare("INSERT INTO library_tokens (id, user_id, label, token_hash, created) VALUES (?,?,?,?,?)").run(id, req.user.id, label, sha256(token), Date.now());
      res.json({ id, label, token });
    }),
  );
  app.delete(
    "/api/library/tokens/:id",
    auth,
    wrap((req, res) => {
      db.prepare("DELETE FROM library_tokens WHERE id = ? AND user_id = ?").run(String(req.params.id), req.user.id);
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- OPDS 1.2
  const failures = new Map<string, { n: number; t: number }>();
  class Denied extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  function opdsUser(req: Request): User | null {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) return sessionUser(h.slice(7));
    if (!h.startsWith("Basic ")) return null;
    const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i < 0) return null;
    const name = raw.slice(0, i).trim();
    const pass = raw.slice(i + 1).trim().toLowerCase();
    const key = `${req.ip || "?"}|${name.toLowerCase()}`;
    const f = failures.get(key);
    const recent = f && Date.now() - f.t < 15 * 60_000;
    const u = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(name) as User | undefined;
    const t = u ? (db.prepare("SELECT id FROM library_tokens WHERE user_id = ? AND token_hash = ?").get(u.id, sha256(pass)) as { id: string } | undefined) : undefined;
    if (!u || !t) {
      if (recent && f.n >= 20) throw new Denied(429, "Too many wrong passwords. Try again in a few minutes.");
      failures.set(key, { n: (recent ? f.n : 0) + 1, t: Date.now() });
      if (failures.size > 5000) failures.clear();
      return null;
    }
    db.prepare("UPDATE library_tokens SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)").run(Date.now(), t.id, Date.now() - 60_000);
    return u;
  }

  const NAV = "application/atom+xml;profile=opds-catalog;kind=navigation";
  const ACQ = "application/atom+xml;profile=opds-catalog;kind=acquisition";
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

  interface Ctx {
    user: User;
    base: string; // "/scute/opds"
    root: string; // "/scute"
    key: string;
    req: Request;
  }
  const href = (c: Ctx, p: string, q: Record<string, string | number | undefined> = {}) => {
    const qs = Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    return `${c.base}${p}${qs ? `?${qs}` : ""}`;
  };
  function feed(c: Ctx, o: { id: string; title: string; self: string; kind: "nav" | "acq"; entries: string[]; updated?: number; links?: string[]; total?: number; page?: number; perPage?: number }) {
    const type = o.kind === "nav" ? NAV : ACQ;
    const head = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata">`,
      `  <id>urn:scute:library:${xmlEsc(c.user.id)}:${xmlEsc(o.id)}</id>`,
      `  <title>${xmlEsc(o.title)}</title>`,
      `  <updated>${iso(o.updated || Date.now())}</updated>`,
      `  <author><name>Scute</name></author>`,
      `  <icon>${xmlEsc(c.root)}/icon-192.png</icon>`,
      `  <link rel="self" href="${xmlEsc(o.self)}" type="${type}"/>`,
      `  <link rel="start" href="${xmlEsc(href(c, "/"))}" type="${NAV}" title="Library"/>`,
      `  <link rel="up" href="${xmlEsc(href(c, "/"))}" type="${NAV}"/>`,
      `  <link rel="search" href="${xmlEsc(href(c, "/opensearch.xml"))}" type="application/opensearchdescription+xml" title="Search"/>`,
      ...(o.links || []).map((l) => `  ${l}`),
    ];
    if (o.total !== undefined) head.push(`  <opensearch:totalResults>${o.total}</opensearch:totalResults>`, `  <opensearch:itemsPerPage>${o.perPage || PAGE}</opensearch:itemsPerPage>`, `  <opensearch:startIndex>${((o.page || 1) - 1) * (o.perPage || PAGE) + 1}</opensearch:startIndex>`);
    return `${head.join("\n")}\n${o.entries.join("\n")}\n</feed>\n`;
  }
  const navEntry = (c: Ctx, id: string, title: string, to: string, content: string, kind: "nav" | "acq" = "acq", updated = Date.now()) =>
    [
      `  <entry>`,
      `    <title>${xmlEsc(title)}</title>`,
      `    <id>urn:scute:library:${xmlEsc(c.user.id)}:${xmlEsc(id)}</id>`,
      `    <updated>${iso(updated)}</updated>`,
      `    <link rel="subsection" href="${xmlEsc(to)}" type="${kind === "nav" ? NAV : ACQ}"/>`,
      `    <content type="text">${xmlEsc(content)}</content>`,
      `  </entry>`,
    ].join("\n");
  function bookEntry(c: Ctx, b: Book) {
    const out = [`  <entry>`, `    <title>${xmlEsc(b.kind !== "book" && b.issue && !b.title.includes(b.issue) ? `${b.title} ${b.issue}` : b.title)}</title>`, `    <id>urn:scute:book:${b.id}</id>`, `    <updated>${iso(b.modified)}</updated>`, `    <published>${iso(b.added)}</published>`];
    for (const a of b.authors) out.push(`    <author><name>${xmlEsc(a)}</name><uri>${xmlEsc(href(c, "/author", { name: a }))}</uri></author>`);
    if (b.language) out.push(`    <dc:language>${xmlEsc(b.language)}</dc:language>`);
    if (b.publisher) out.push(`    <dc:publisher>${xmlEsc(b.publisher)}</dc:publisher>`);
    if (b.published) out.push(`    <dc:issued>${xmlEsc(b.published)}</dc:issued>`);
    if (b.isbn) out.push(`    <dc:identifier>urn:isbn:${xmlEsc(b.isbn)}</dc:identifier>`);
    out.push(`    <dc:identifier>urn:uuid:${b.id.slice(0, 8)}-${b.id.slice(8, 12)}-${b.id.slice(12, 16)}-${b.id.slice(16, 20)}-${b.id.slice(20).padEnd(12, "0")}</dc:identifier>`);
    if (b.series) out.push(`    <calibre:series>${xmlEsc(b.series)}</calibre:series>`, ...(b.seriesIndex != null ? [`    <calibre:series_index>${b.seriesIndex}</calibre:series_index>`] : []));
    for (const s of b.subjects) out.push(`    <category term="${xmlEsc(s)}" label="${xmlEsc(s)}"/>`);
    const bits: string[] = [];
    if (b.series) bits.push(`${b.series}${b.seriesIndex != null ? ` #${b.seriesIndex}` : ""}`);
    if (b.published) bits.push(b.published.slice(0, 10));
    if (b.publisher) bits.push(b.publisher);
    const summary = [bits.join(" · "), b.description || ""].filter(Boolean).join("\n\n");
    if (summary) out.push(`    <summary type="text">${xmlEsc(summary.slice(0, 4000))}</summary>`, `    <content type="text">${xmlEsc(summary.slice(0, 20000))}</content>`);
    if (b.cover) {
      const img = `${c.root}/api/library/k/${c.key}/cover/${b.id}.jpg?v=${b.cover}`;
      out.push(`    <link rel="http://opds-spec.org/image" href="${xmlEsc(img)}" type="image/jpeg"/>`, `    <link rel="http://opds-spec.org/image/thumbnail" href="${xmlEsc(img)}" type="image/jpeg"/>`);
    }
    // best first: what most readers open
    const order = ["epub", "kepub", "pdf", "azw3", "mobi", "cbz", "cbr", "fb2"];
    const files = [...b.files].sort((x, y) => (order.indexOf(x.format) + 1 || 99) - (order.indexOf(y.format) + 1 || 99));
    for (const f of files) {
      const name = downloadName(b, f);
      out.push(`    <link rel="http://opds-spec.org/acquisition" href="${xmlEsc(`${c.base}/book/${b.id}/${f.format}/${encodeURIComponent(name)}`)}" type="${mimeOf(f.format).split(";")[0]}" length="${f.size}" title="${xmlEsc(f.format.toUpperCase())}"/>`);
    }
    if (b.series) out.push(`    <link rel="related" href="${xmlEsc(href(c, "/series", { name: b.series }))}" type="${ACQ}" title="${xmlEsc(`More in ${b.series}`)}"/>`);
    out.push(`  </entry>`);
    return out.join("\n");
  }
  const allBooks = (uid: string) => (db.prepare("SELECT * FROM library_books WHERE user_id = ?").all(uid) as Row[]).map(toBook);
  const byTitle = (a: Book, b: Book) => a.sortTitle.localeCompare(b.sortTitle) || (a.issue || "").localeCompare(b.issue || "", undefined, { numeric: true });
  const bySeries = (a: Book, b: Book) => (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9) || (a.published || "").localeCompare(b.published || "") || byTitle(a, b);
  const byIssue = (a: Book, b: Book) => (b.published || "").localeCompare(a.published || "") || (b.issue || "").localeCompare(a.issue || "", undefined, { numeric: true }) || byTitle(a, b);

  function acqPage(c: Ctx, id: string, title: string, p: string, q: Record<string, string>, books: Book[]) {
    const page = Math.max(1, Number(c.req.query.page || 1) | 0);
    const pages = Math.max(1, Math.ceil(books.length / PAGE));
    const slice = books.slice((page - 1) * PAGE, page * PAGE);
    const links: string[] = [];
    if (pages > 1) {
      links.push(`<link rel="first" href="${xmlEsc(href(c, p, q))}" type="${ACQ}"/>`, `<link rel="last" href="${xmlEsc(href(c, p, { ...q, page: pages }))}" type="${ACQ}"/>`);
      if (page > 1) links.push(`<link rel="previous" href="${xmlEsc(href(c, p, { ...q, page: page > 2 ? page - 1 : undefined }))}" type="${ACQ}"/>`);
      if (page < pages) links.push(`<link rel="next" href="${xmlEsc(href(c, p, { ...q, page: page + 1 }))}" type="${ACQ}"/>`);
    }
    return feed(c, {
      id: page > 1 ? `${id}:${page}` : id,
      title: pages > 1 ? `${title} (${page} of ${pages})` : title,
      self: href(c, p, page > 1 ? { ...q, page: String(page) } : q),
      kind: "acq",
      entries: slice.map((b) => bookEntry(c, b)),
      updated: books.reduce((m, b) => Math.max(m, b.modified), 0) || Date.now(),
      links,
      total: books.length,
      page,
    });
  }
  /** Navigation list of names (authors, series, subjects) with how many books each. */
  function groupPage(c: Ctx, id: string, title: string, p: string, to: string, groups: Map<string, { label: string; n: number; t: number }>, sort: (a: string, b: string) => number, noun: [string, string]) {
    const keys = [...groups.keys()].sort(sort);
    const page = Math.max(1, Number(c.req.query.page || 1) | 0);
    const per = 100;
    const pages = Math.max(1, Math.ceil(keys.length / per));
    const links: string[] = [];
    if (page < pages) links.push(`<link rel="next" href="${xmlEsc(href(c, p, { page: page + 1 }))}" type="${NAV}"/>`);
    if (page > 1) links.push(`<link rel="previous" href="${xmlEsc(href(c, p, { page: page > 2 ? page - 1 : undefined }))}" type="${NAV}"/>`);
    return feed(c, {
      id,
      title: pages > 1 ? `${title} (${page} of ${pages})` : title,
      self: href(c, p, { page: page > 1 ? page : undefined }),
      kind: "nav",
      entries: keys.slice((page - 1) * per, page * per).map((k) => {
        const g = groups.get(k)!;
        return navEntry(c, `${id}:${k}`, g.label, href(c, to, { name: g.label }), `${g.n} ${g.n === 1 ? noun[0] : noun[1]}`, "acq", g.t);
      }),
      links,
    });
  }
  const tally = (books: Book[], names: (b: Book) => string[]) => {
    const m = new Map<string, { label: string; n: number; t: number }>();
    for (const b of books)
      for (const n of names(b)) {
        const k = n.toLowerCase();
        const g = m.get(k) || { label: n, n: 0, t: 0 };
        g.n++;
        g.t = Math.max(g.t, b.modified);
        m.set(k, g);
      }
    return m;
  };
  const matches = (b: Book, q: string) => {
    const hay = [b.title, b.issue, ...b.authors, b.series, b.publisher, b.isbn, ...b.subjects, b.published?.slice(0, 4)].filter(Boolean).join(" \u0001 ").toLowerCase();
    return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  };

  async function opds(req: Request, res: Response) {
    if (!LIBRARY_ON || !pluginOn()) return res.status(503).type("text").send("The library isn't installed or is turned off on this server");
    const user = opdsUser(req);
    if (!user) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Scute Library", charset="UTF-8"');
      return res.status(401).type("text").send("Sign in with your Scute username and a Library app password");
    }
    const root = prefixOf(req);
    const c: Ctx = { user, base: `${root}/opds`, root, key: linkKey(user.id), req };
    const sub = req.path.replace(/^\/opds/, "") || "/";
    const name = String(req.query.name || "").trim();
    res.setHeader("Cache-Control", "private, no-cache");
    const xml = (body: string, type = ACQ) => res.type(`${type};charset=utf-8`).send(body);

    // downloads
    const dl = /^\/book\/([a-f0-9]{16,32})\/([a-z0-9]+)(?:\/[^/]*)?$/.exec(sub);
    if (dl) {
      const r = getRow(user.id, dl[1]);
      const b = r ? toBook(r) : null;
      const f = b?.files.find((x) => x.format === dl[2]);
      if (!b || !f) return res.status(404).type("text").send("No such book");
      res.setHeader("Content-Disposition", attach(downloadName(b, f)));
      return sendFile(res, path.join(bookDir(user.id, b.id), `book.${f.format}`), mimeOf(f.format), attach(downloadName(b, f)), "private, no-cache");
    }
    const cov = /^\/cover\/([a-f0-9]{16,32})\.jpg$/.exec(sub);
    if (cov) {
      const r = getRow(user.id, cov[1]);
      if (!r?.cover) return res.status(404).type("text").send("No cover");
      return sendFile(res, path.join(bookDir(user.id, r.id), "cover.jpg"), "image/jpeg", null, "private, max-age=86400");
    }
    if (sub === "/opensearch.xml") {
      return res.type("application/opensearchdescription+xml;charset=utf-8").send(
        [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">`,
          `  <ShortName>Scute Library</ShortName>`,
          `  <Description>Search your Scute library</Description>`,
          `  <InputEncoding>UTF-8</InputEncoding>`,
          `  <OutputEncoding>UTF-8</OutputEncoding>`,
          `  <Url type="${ACQ}" template="${xmlEsc(`${c.base}/search`)}?q={searchTerms}"/>`,
          `  <Url type="application/atom+xml" template="${xmlEsc(`${c.base}/search`)}?q={searchTerms}"/>`,
          `</OpenSearchDescription>`,
          ``,
        ].join("\n"),
      );
    }

    const books = allBooks(user.id);
    const last = books.reduce((m, b) => Math.max(m, b.modified), 0) || Date.now();
    switch (sub) {
      case "/": {
        const kinds = new Set(books.map((b) => b.kind));
        const e = [
          navEntry(c, "new", "Recently added", href(c, "/new"), `The newest ${Math.min(PAGE, books.length)} of ${books.length} items`, "acq", last),
          navEntry(c, "all", "All by title", href(c, "/all"), `${books.length} ${books.length === 1 ? "item" : "items"}`, "acq", last),
          navEntry(c, "authors", "Authors", href(c, "/authors"), `${tally(books, (b) => b.authors).size} authors`, "nav", last),
          navEntry(c, "series", "Series", href(c, "/series"), `${tally(books, (b) => (b.series ? [b.series] : [])).size} series`, "nav", last),
          navEntry(c, "subjects", "Subjects", href(c, "/subjects"), `${tally(books, (b) => b.subjects).size} subjects`, "nav", last),
        ];
        if (kinds.has("book") && kinds.size > 1) e.push(navEntry(c, "books", "Books", href(c, "/kind/book"), `${books.filter((b) => b.kind === "book").length} books`, "acq", last));
        if (kinds.has("magazine")) e.push(navEntry(c, "magazines", "Magazines", href(c, "/kind/magazine"), `${tally(books.filter((b) => b.kind === "magazine"), (b) => [b.series || b.title]).size} magazines, ${books.filter((b) => b.kind === "magazine").length} issues`, "nav", last));
        if (kinds.has("comic")) e.push(navEntry(c, "comics", "Comics", href(c, "/kind/comic"), `${books.filter((b) => b.kind === "comic").length} comics`, "acq", last));
        e.push(navEntry(c, "languages", "Languages", href(c, "/languages"), `${tally(books, (b) => (b.language ? [b.language] : [])).size} languages`, "nav", last));
        return xml(feed(c, { id: "root", title: `${user.username}'s library`, self: href(c, "/"), kind: "nav", entries: e, updated: last }), NAV);
      }
      case "/new":
        return xml(acqPage(c, "new", "Recently added", "/new", {}, [...books].sort((a, b) => b.added - a.added)));
      case "/all":
        return xml(acqPage(c, "all", "All by title", "/all", {}, [...books].sort(byTitle)));
      case "/search": {
        const q = String(req.query.q || "").trim().slice(0, 200);
        return xml(acqPage(c, `search:${q}`, q ? `Search: ${q}` : "Search", "/search", { q }, q ? books.filter((b) => matches(b, q)).sort(byTitle) : []));
      }
      case "/authors":
        return xml(groupPage(c, "authors", "Authors", "/authors", "/author", tally(books, (b) => b.authors), (a, b) => authorSort(a).localeCompare(authorSort(b)), ["book", "books"]), NAV);
      case "/author":
        return xml(acqPage(c, `author:${name}`, name || "Author", "/author", { name }, books.filter((b) => b.authors.some((a) => a.toLowerCase() === name.toLowerCase())).sort((a, b) => (a.series || "").localeCompare(b.series || "") || bySeries(a, b))));
      case "/series":
        if (name) return xml(acqPage(c, `series:${name}`, name, "/series", { name }, books.filter((b) => (b.series || "").toLowerCase() === name.toLowerCase()).sort((a, b) => (a.kind === "magazine" ? byIssue(a, b) : bySeries(a, b)))));
        return xml(groupPage(c, "series", "Series", "/series", "/series", tally(books, (b) => (b.series ? [b.series] : [])), (a, b) => sortTitleOf(a).localeCompare(sortTitleOf(b)), ["item", "items"]), NAV);
      case "/subjects":
        return xml(groupPage(c, "subjects", "Subjects", "/subjects", "/subject", tally(books, (b) => b.subjects), (a, b) => a.localeCompare(b), ["item", "items"]), NAV);
      case "/subject":
        return xml(acqPage(c, `subject:${name}`, name || "Subject", "/subject", { name }, books.filter((b) => b.subjects.some((s) => s.toLowerCase() === name.toLowerCase())).sort(byTitle)));
      case "/languages":
        return xml(groupPage(c, "languages", "Languages", "/languages", "/language", tally(books, (b) => (b.language ? [b.language] : [])), (a, b) => a.localeCompare(b), ["item", "items"]), NAV);
      case "/language":
        return xml(acqPage(c, `language:${name}`, name || "Language", "/language", { name }, books.filter((b) => (b.language || "") === name.toLowerCase()).sort(byTitle)));
      case "/magazine":
        return xml(acqPage(c, `magazine:${name}`, name || "Magazine", "/magazine", { name }, books.filter((b) => b.kind === "magazine" && (b.series || b.title).toLowerCase() === name.toLowerCase()).sort(byIssue)));
      case "/kind/book":
        return xml(acqPage(c, "kind:book", "Books", "/kind/book", {}, books.filter((b) => b.kind === "book").sort(byTitle)));
      case "/kind/comic":
        return xml(acqPage(c, "kind:comic", "Comics", "/kind/comic", {}, books.filter((b) => b.kind === "comic").sort((a, b) => (a.series || a.sortTitle).localeCompare(b.series || b.sortTitle) || bySeries(a, b))));
      case "/kind/magazine": {
        // one entry per magazine title, newest issue first inside
        const mags = books.filter((b) => b.kind === "magazine");
        return xml(groupPage(c, "magazines", "Magazines", "/kind/magazine", "/magazine", tally(mags, (b) => [b.series || b.title]), (a, b) => sortTitleOf(a).localeCompare(sortTitleOf(b)), ["issue", "issues"]), NAV);
      }
    }
    return res.status(404).type("text").send("Not found");
  }

  app.use((req, res, next) => {
    if (req.path !== "/opds" && !req.path.startsWith("/opds/")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
    if (req.path === "/opds") return res.redirect(301, `${prefixOf(req)}/opds/`);
    opds(req, res).catch((e) => {
      const status = e instanceof Denied ? e.status : 500;
      if (status === 500) console.error("Scute library (OPDS):", e);
      if (!res.headersSent) res.status(status).type("text").send(status === 500 ? "Server error" : e.message);
    });
  });
}
