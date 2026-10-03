import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./storage";
import { PLUGINS_ON, listPlugins } from "./plugins";

/**
 * Published shares (plug-in API 6, "publish" permission).
 *
 * A plug-in uploads a set of files under a name ("slug") and the server serves
 * them to anyone at /shared/<slug>/. The server only ever stores what the
 * browser sends: plug-ins encrypt the content before uploading, so the server
 * (and any reverse proxy in front of it) sees opaque .bin files and a small
 * public share.json. The page at /shared/<slug>/ is the plug-in's own viewer
 * file (shipped in the plug-in, installed by the admin), never uploaded data.
 */

const off = (v: string | undefined, d: string) => ["off", "0", "false", "no"].includes((v || d).toLowerCase());
export const SHARES_ON = PLUGINS_ON && !off(process.env.SCUTE_SHARES, "on");
const MAX_MB = Number(process.env.SCUTE_SHARE_MAX_MB || 4096); // per share
const MAX_FILE_MB = Number(process.env.SCUTE_MAX_UPLOAD_MB || 200);
const SHARES_DIR = path.join(DATA_DIR, "shares");

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Media a viewer can point <img>/<video>/<audio> at directly (API 7); never HTML, SVG or scripts. */
const MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  mp3: "audio/mpeg", m4a: "audio/mp4", oga: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
  pdf: "application/pdf",
};
const FILE_RE = new RegExp(`^(?:[a-z0-9_-]{1,32}\\/)?[a-z0-9_-]{1,64}\\.(?:bin|json|${Object.keys(MEDIA_TYPES).join("|")})$`);
const VER_RE = /^[a-f0-9]{16}$/;

db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  slug TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  expires INTEGER
);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id);
`);

interface ShareRow {
  slug: string;
  owner_id: string;
  plugin: string;
  version: string;
  bytes: number;
  files: number;
  created: number;
  updated: number;
  expires: number | null;
}

const row = (slug: string) => db.prepare("SELECT * FROM shares WHERE slug = ?").get(slug) as ShareRow | undefined;
const shareDir = (slug: string) => path.join(SHARES_DIR, slug);
const verDir = (slug: string, v: string) => path.join(SHARES_DIR, slug, v);
const pub = (r: ShareRow) => ({
  slug: r.slug,
  plugin: r.plugin,
  published: !!r.version,
  bytes: r.bytes,
  files: r.files,
  created: r.created,
  updated: r.updated,
  expires: r.expires,
  path: `/shared/${r.slug}/`,
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) out.push(e.name);
    else if (e.isDirectory()) for (const f of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) if (f.isFile()) out.push(`${e.name}/${f.name}`);
  }
  return out.filter((n) => FILE_RE.test(n));
}

/** Plug-ins that may publish: enabled, "publish" permission, and a viewer page. */
function viewerOf(pluginId: string): string | null {
  return viewerInfo(pluginId)?.file || null;
}
function viewerInfo(pluginId: string): { file: string; allow: string[] } | null {
  const p = listPlugins().find((x) => x.id === pluginId && x.enabled && !x.error);
  if (!p || !p.permissions.includes("publish") || !p.shareViewer) return null;
  const f = path.join(p.dir, p.shareViewer);
  return f.startsWith(p.dir + path.sep) && fs.existsSync(f) ? { file: f, allow: p.shareAllow || [] } : null;
}
/** The viewer page's CSP: its own files, OpenStreetMap tiles, and whatever the plug-in's shareAllow adds. */
function viewerCsp(allow: string[]) {
  const img = ["'self'", "blob:", "data:", "https://tile.openstreetmap.org", "https://*.tile.opentopomap.org", "https://server.arcgisonline.com"];
  const media = ["'self'", "blob:"];
  const frame: string[] = [];
  if (allow.includes("web-images")) img.push("https:");
  if (allow.includes("web-media")) media.push("https:");
  if (allow.includes("video-embeds")) frame.push("https://www.youtube-nocookie.com", "https://player.vimeo.com");
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${img.join(" ")}; media-src ${media.join(" ")}; connect-src 'self'; font-src data:;${frame.length ? ` frame-src ${frame.join(" ")};` : ""} base-uri 'none'; form-action 'none'`;
}

/** Remove a user's shares from disk (their rows go with the user). */
export function removeUserShares(userId: string) {
  const rows = db.prepare("SELECT slug FROM shares WHERE owner_id = ?").all(userId) as { slug: string }[];
  for (const r of rows) fs.rmSync(shareDir(r.slug), { recursive: true, force: true });
  db.prepare("DELETE FROM shares WHERE owner_id = ?").run(userId);
}

function cleanStale(slug: string, keep: string[]) {
  const d = shareDir(slug);
  if (!fs.existsSync(d)) return;
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory() || keep.includes(e.name)) continue;
    const full = path.join(d, e.name);
    try {
      if (fs.statSync(full).mtimeMs < dayAgo) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

type Wrap = (fn: (req: any, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;

export function registerShareRoutes(
  app: Express,
  deps: { auth: (req: Request, res: Response, next: NextFunction) => void; wrap: Wrap; HttpError: new (status: number, message: string) => Error },
) {
  const { auth, wrap, HttpError } = deps;
  const need = () => {
    if (!SHARES_ON) throw new HttpError(403, "Publishing is turned off on this server (SCUTE_SHARES=off)");
  };
  const mine = (req: any, slug: string) => {
    if (!SLUG_RE.test(slug)) throw new HttpError(400, "Addresses use lowercase letters, digits and dashes (up to 64)");
    const r = row(slug);
    if (!r) throw new HttpError(404, "No such share");
    if (r.owner_id !== req.user.id) throw new HttpError(403, "That address belongs to someone else");
    return r;
  };

  app.get(
    "/api/shares",
    auth,
    wrap((req, res) => {
      const plugin = typeof req.query.plugin === "string" ? req.query.plugin : null;
      const rows = (db.prepare("SELECT * FROM shares WHERE owner_id = ? ORDER BY updated DESC").all(req.user.id) as ShareRow[]).filter((r) => !plugin || r.plugin === plugin);
      res.json({ enabled: SHARES_ON, maxMb: MAX_MB, maxFileMb: MAX_FILE_MB, shares: rows.map(pub) });
    }),
  );

  app.get(
    "/api/shares/:slug",
    auth,
    wrap((req, res) => {
      const slug = String(req.params.slug);
      if (!SLUG_RE.test(slug)) return res.json({ slug, valid: false, available: false, mine: false });
      const r = row(slug);
      res.json({ slug, valid: true, available: !r || r.owner_id === req.user.id, mine: r?.owner_id === req.user.id, share: r && r.owner_id === req.user.id ? pub(r) : null });
    }),
  );

  // Start a new version. Files already in the current version can be kept
  // without uploading them again (listed in "have").
  app.post(
    "/api/shares/:slug/begin",
    auth,
    express.json(),
    wrap((req, res) => {
      need();
      const slug = String(req.params.slug);
      if (!SLUG_RE.test(slug)) throw new HttpError(400, "Addresses use lowercase letters, digits and dashes (up to 64)");
      const plugin = String(req.body?.plugin || "");
      if (!viewerOf(plugin)) throw new HttpError(400, `The "${plugin}" plug-in can't publish (it needs to be enabled, with the "publish" permission and a viewer page)`);
      let r = row(slug);
      if (r && r.owner_id !== req.user.id) throw new HttpError(409, "That address is already taken on this server");
      if (r && r.plugin !== plugin) throw new HttpError(409, "That address is used by another plug-in");
      const now = Date.now();
      if (!r) {
        db.prepare("INSERT INTO shares (slug, owner_id, plugin, created, updated) VALUES (?,?,?,?,?)").run(slug, req.user.id, plugin, now, now);
        r = row(slug)!;
      }
      const version = crypto.randomBytes(8).toString("hex");
      fs.mkdirSync(verDir(slug, version), { recursive: true });
      cleanStale(slug, [r.version, version]);
      res.json({ version, have: r.version ? listFiles(verDir(slug, r.version)) : [] });
    }),
  );

  app.put(
    /^\/api\/shares\/([a-z0-9-]{1,64})\/([a-f0-9]{16})\/(.+)$/,
    auth,
    express.raw({ type: () => true, limit: MAX_FILE_MB * 1024 * 1024 }),
    wrap((req, res) => {
      need();
      const slug = (req.params as any)[0] as string;
      const version = (req.params as any)[1] as string;
      const name = decodeURIComponent((req.params as any)[2] as string);
      mine(req, slug);
      if (!FILE_RE.test(name)) throw new HttpError(400, "File names are like name.bin, dir/name.bin or name.json");
      const dir = verDir(slug, version);
      if (!VER_RE.test(version) || !fs.existsSync(dir)) throw new HttpError(404, "That upload has expired; publish again");
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (name === "share.json") {
        if (body.length > 64 * 1024) throw new HttpError(400, "share.json is limited to 64 KB");
        try {
          JSON.parse(body.toString("utf8"));
        } catch {
          throw new HttpError(400, "share.json isn't valid JSON");
        }
      }
      const dest = path.join(dir, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + ".part", body);
      fs.renameSync(dest + ".part", dest);
      res.json({ ok: true, bytes: body.length });
    }),
  );

  app.post(
    /^\/api\/shares\/([a-z0-9-]{1,64})\/([a-f0-9]{16})\/commit$/,
    auth,
    express.json({ limit: "4mb" }),
    wrap((req, res) => {
      need();
      const slug = (req.params as any)[0] as string;
      const version = (req.params as any)[1] as string;
      const r = mine(req, slug);
      const dir = verDir(slug, version);
      if (!fs.existsSync(dir)) throw new HttpError(404, "That upload has expired; publish again");
      const files: string[] = Array.isArray(req.body?.files) ? req.body.files.map(String) : [];
      if (!files.includes("share.json")) throw new HttpError(400, "A share needs a share.json");
      if (files.length > 50_000) throw new HttpError(400, "Too many files");
      const prev = r.version ? verDir(slug, r.version) : null;
      let bytes = 0;
      for (const n of files) {
        if (!FILE_RE.test(n)) throw new HttpError(400, `Bad file name: ${n}`);
        const dest = path.join(dir, n);
        if (!fs.existsSync(dest)) {
          const src = prev && path.join(prev, n);
          if (!src || !fs.existsSync(src)) throw new HttpError(400, `Missing file: ${n}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try {
            fs.linkSync(src, dest);
          } catch {
            fs.copyFileSync(src, dest);
          }
        }
        bytes += fs.statSync(dest).size;
      }
      if (bytes > MAX_MB * 1024 * 1024) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new HttpError(413, `This share would be ${Math.round(bytes / 1048576)} MB; the server allows ${MAX_MB} MB (SCUTE_SHARE_MAX_MB)`);
      }
      const keep = new Set(files);
      for (const n of listFiles(dir)) if (!keep.has(n)) fs.rmSync(path.join(dir, n), { force: true });
      let expires: number | null = r.expires;
      if (req.body && "expires" in req.body) {
        const e = req.body.expires;
        expires = e == null ? null : Number(e);
        if (expires !== null && !(expires > Date.now())) throw new HttpError(400, "The expiry date has to be in the future");
      }
      const now = Date.now();
      db.prepare("UPDATE shares SET version = ?, bytes = ?, files = ?, updated = ?, expires = ? WHERE slug = ?").run(version, bytes, files.length, now, expires, slug);
      if (prev) fs.rmSync(prev, { recursive: true, force: true });
      res.json(pub(row(slug)!));
    }),
  );

  app.patch(
    "/api/shares/:slug",
    auth,
    express.json(),
    wrap((req, res) => {
      const slug = String(req.params.slug);
      mine(req, slug);
      const e = req.body?.expires;
      const expires = e == null ? null : Number(e);
      if (expires !== null && !(expires > Date.now())) throw new HttpError(400, "The expiry date has to be in the future");
      db.prepare("UPDATE shares SET expires = ? WHERE slug = ?").run(expires, slug);
      res.json(pub(row(slug)!));
    }),
  );

  app.delete(
    "/api/shares/:slug",
    auth,
    wrap((req, res) => {
      const slug = String(req.params.slug);
      mine(req, slug);
      fs.rmSync(shareDir(slug), { recursive: true, force: true });
      db.prepare("DELETE FROM shares WHERE slug = ?").run(slug);
      res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------------- public
  const gone = (res: Response, status: number, msg: string) =>
    res
      .status(status)
      .set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" })
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${msg}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#444;background:#f6f3ee}@media(prefers-color-scheme:dark){body{background:#171513;color:#bbb}}</style><p>${msg}</p>`,
      );
  const live = (slug: string) => {
    if (!SHARES_ON) return { err: [404, "Nothing is shared here."] as const };
    const r = row(slug);
    if (!r || !r.version) return { err: [404, "Nothing is shared here."] as const };
    if (r.expires && r.expires < Date.now()) return { err: [410, "This share has expired."] as const };
    const v = viewerInfo(r.plugin);
    if (!v) return { err: [404, "Nothing is shared here."] as const };
    return { r, viewer: v.file, allow: v.allow };
  };

  app.get(/^\/shared\/([a-z0-9-]{1,64})(?:\/|\/index\.html)?$/, (req, res, next) => {
    const slug = (req.params as any)[0] as string;
    const s = live(slug);
    if ("err" in s) return gone(res, s.err![0], s.err![1]);
    res.set({
      "Cache-Control": "no-cache",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Content-Security-Policy": viewerCsp(s.allow!),
    });
    res.type("html").sendFile(s.viewer, (err) => err && next(err));
  });

  app.get(/^\/shared\/([a-z0-9-]{1,64})\/(.+)$/, (req, res, next) => {
    const slug = (req.params as any)[0] as string;
    const name = decodeURIComponent((req.params as any)[1] as string);
    const s = live(slug);
    if ("err" in s) return res.status(s.err![0]).type("text/plain").send(s.err![1]);
    if (!FILE_RE.test(name)) return res.status(404).type("text/plain").send("Not found");
    const file = path.join(verDir(slug, s.r!.version), name);
    if (!fs.existsSync(file)) return res.status(404).type("text/plain").send("Not found");
    res.set({
      "Cache-Control": name.includes("/") ? "public, max-age=86400" : "no-cache",
      "X-Robots-Tag": "noindex, nofollow",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    });
    const ext = name.slice(name.lastIndexOf(".") + 1);
    if (ext !== "pdf") res.set("Content-Security-Policy", "default-src 'none'; sandbox"); // browsers' PDF viewers don't run sandboxed
    res.type(ext === "json" ? "application/json" : MEDIA_TYPES[ext] || "application/octet-stream").sendFile(file, (err) => err && next(err));
  });
}
