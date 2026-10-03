/**
 * Plug-ins: client-side extensions served by the Scute server.
 *
 * A plug-in is a folder with a plugin.json manifest and an ES module (main.js)
 * that runs in the browser after sign-in. The server never runs plug-in code;
 * it only stores the files, tracks which plug-ins the admin has enabled, and
 * serves enabled plug-ins at /plugins/<id>/<file>.
 *
 * Two sources:
 *   bundled   examples shipped with Scute (dist/plugins), read-only, off by default
 *   installed folders in SCUTE_PLUGINS_DIR (default <data>/plugins), added by
 *             copying a folder there or uploading a .zip in Settings → Plug-ins
 */
import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync } from "fflate";
import { DATA_DIR } from "./storage";

export const PLUGINS_MODE = (process.env.SCUTE_PLUGINS || "on").toLowerCase(); // on | off
export const PLUGINS_ON = !["off", "0", "false", "no"].includes(PLUGINS_MODE);
const INSTALL_DIR = path.resolve(process.env.SCUTE_PLUGINS_DIR || path.join(DATA_DIR, "plugins"));
const BUNDLED_DIR = [path.resolve(__dirname, "plugins"), path.resolve(process.cwd(), "plugins")].find((d) => fs.existsSync(path.join(d, "daily-note")));
const STATE_FILE = path.join(INSTALL_DIR, ".state.json");
const MAX_ZIP = 20 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const PLUGIN_API_VERSION = 8; // 8: drive (Scute Drive WebDAV folder); 2: space kinds, note types, menus, spaces.create, notes.createMany; 3: services, net relay; 4: net.get (public web); 5: files (thumb, url, blob, add); 6: shares (publish at /shared/<name>/); 7: media files in shares, shareAllow
/** What a share viewer may load besides its own files (plugin.json "shareAllow", API 7). */
export const SHARE_ALLOW = ["web-images", "web-media", "video-embeds"] as const;
/**
 * Network relay for plug-ins (API 3). Browsers can't reach most self-hosted
 * services directly (no CORS, or plain http:// from an https:// page), so the
 * server forwards requests, but only to URL prefixes the admin lists in
 * SCUTE_PLUGIN_NET (comma separated; "*" allows any http(s) URL). Empty = off.
 */
export const NET_ALLOW = (process.env.SCUTE_PLUGIN_NET || "")
  .split(/[\s,]+/)
  .map((x) => x.trim().replace(/\/+$/, ""))
  .filter(Boolean);
export const NET_ON = PLUGINS_ON && NET_ALLOW.length > 0;
const NET_TIMEOUT_MS = Number(process.env.SCUTE_PLUGIN_NET_TIMEOUT || 600) * 1000;
export function netAllowed(url: string) {
  if (NET_ALLOW.includes("*")) return true;
  return NET_ALLOW.some((p) => url === p || url.startsWith(p.endsWith("/") ? p : p + "/") || url.startsWith(p + "?"));
}
const PERMS = ["notes:read", "notes:write", "storage", "network", "publish", "drive"];

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  main: string;
  styles?: string;
  /** API 6: the page served at /shared/<name>/ for this plug-in's shares (an .html file in the plug-in). */
  shareViewer?: string;
  shareAllow?: string[];
  permissions: string[];
  apiVersion: number;
}

export interface PluginInfo extends PluginManifest {
  source: "bundled" | "installed";
  enabled: boolean;
  hash: string; // changes whenever the files change; used to bust caches
  error?: string;
}

type State = { enabled: Record<string, boolean> };

function readState(): State {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { enabled: s && typeof s.enabled === "object" ? s.enabled : {} };
  } catch {
    return { enabled: {} };
  }
}
function writeState(s: State) {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const safeRel = (p: string) => typeof p === "string" && p.length < 200 && !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && /^[\w./-]+$/.test(p);

export function validateManifest(raw: unknown): PluginManifest {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== "object") throw new Error("plugin.json must be a JSON object");
  const id = String(m.id || "");
  if (!ID_RE.test(id)) throw new Error("plugin.json: \"id\" must be 2-64 lowercase letters, digits, dot, dash or underscore");
  const name = String(m.name || "").trim();
  if (!name) throw new Error("plugin.json: \"name\" is required");
  const main = String(m.main || "main.js");
  if (!safeRel(main) || !/\.m?js$/.test(main)) throw new Error("plugin.json: \"main\" must be a relative .js file");
  const styles = m.styles == null ? undefined : String(m.styles);
  if (styles !== undefined && (!safeRel(styles) || !styles.endsWith(".css"))) throw new Error("plugin.json: \"styles\" must be a relative .css file");
  const shareViewer = m.shareViewer == null ? undefined : String(m.shareViewer);
  if (shareViewer !== undefined && (!safeRel(shareViewer) || !shareViewer.endsWith(".html"))) throw new Error("plugin.json: \"shareViewer\" must be a relative .html file");
  const shareAllow = Array.isArray(m.shareAllow) ? m.shareAllow.map(String) : undefined;
  const badAllow = (shareAllow || []).filter((x) => !(SHARE_ALLOW as readonly string[]).includes(x));
  if (badAllow.length) throw new Error(`plugin.json: unknown shareAllow ${badAllow.join(", ")} (allowed: ${SHARE_ALLOW.join(", ")})`);
  const permissions = Array.isArray(m.permissions) ? m.permissions.map(String) : [];
  const bad = permissions.filter((p) => !PERMS.includes(p));
  if (bad.length) throw new Error(`plugin.json: unknown permission ${bad.join(", ")} (allowed: ${PERMS.join(", ")})`);
  const apiVersion = Number(m.apiVersion ?? 1);
  if (apiVersion > PLUGIN_API_VERSION) throw new Error(`Needs plug-in API ${apiVersion}; this Scute has ${PLUGIN_API_VERSION}`);
  return {
    id,
    name: name.slice(0, 80),
    version: String(m.version || "0.0.0").slice(0, 32),
    description: m.description ? String(m.description).slice(0, 500) : undefined,
    author: m.author ? String(m.author).slice(0, 120) : undefined,
    homepage: typeof m.homepage === "string" && /^https?:\/\//.test(m.homepage) ? m.homepage.slice(0, 300) : undefined,
    main,
    styles,
    shareViewer,
    ...(shareAllow?.length ? { shareAllow } : {}),
    permissions,
    apiVersion,
  };
}

function hashDir(dir: string): string {
  const h = crypto.createHash("sha1");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        h.update(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* ignore */
  }
  return h.digest("hex").slice(0, 12);
}

function scan(dir: string | undefined, source: PluginInfo["source"], state: State, out: Map<string, PluginInfo & { dir: string }>) {
  if (!dir || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const pdir = path.join(dir, e.name);
    const mf = path.join(pdir, "plugin.json");
    if (!fs.existsSync(mf)) continue;
    let info: PluginInfo & { dir: string };
    try {
      const m = validateManifest(JSON.parse(fs.readFileSync(mf, "utf8")));
      if (m.id !== e.name) throw new Error(`Folder name "${e.name}" must match the id "${m.id}"`);
      if (!fs.existsSync(path.join(pdir, m.main))) throw new Error(`Missing ${m.main}`);
      info = { ...m, source, enabled: !!state.enabled[m.id], hash: hashDir(pdir), dir: pdir };
    } catch (err) {
      info = { id: e.name, name: e.name, version: "?", main: "main.js", permissions: [], apiVersion: 1, source, enabled: false, hash: "", error: (err as Error).message, dir: pdir };
    }
    // an installed copy overrides a bundled one with the same id
    if (source === "installed" || !out.has(info.id)) out.set(info.id, info);
  }
}

export function listPlugins(): (PluginInfo & { dir: string })[] {
  if (!PLUGINS_ON) return [];
  const state = readState();
  const out = new Map<string, PluginInfo & { dir: string }>();
  scan(BUNDLED_DIR, "bundled", state, out);
  scan(INSTALL_DIR, "installed", state, out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const publicInfo = ({ dir: _d, ...p }: PluginInfo & { dir: string }) => p;

/** Unpack an uploaded .zip into the install dir. Accepts files at the root or inside one top folder. */
export function installZip(buf: Buffer): PluginInfo {
  if (buf.length > MAX_ZIP) throw new Error("Plug-in zip is larger than 20 MB");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error("That file isn't a valid .zip");
  }
  let names = Object.keys(files).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(n));
  if (!names.length) throw new Error("The zip is empty");
  if (!names.includes("plugin.json")) {
    const tops = new Set(names.map((n) => n.split("/")[0]));
    const top = [...tops][0];
    if (tops.size !== 1 || !names.includes(`${top}/plugin.json`)) throw new Error("The zip needs a plugin.json at its root (or inside a single top-level folder)");
    names = names.map((n) => n.slice(top.length + 1));
    files = Object.fromEntries(Object.entries(files).filter(([k]) => !k.endsWith("/") && k.startsWith(top + "/")).map(([k, v]) => [k.slice(top.length + 1), v]));
  }
  let total = 0;
  for (const n of names) {
    if (!safeRel(n)) throw new Error(`Unsafe file name in zip: ${n}`);
    total += files[n].length;
  }
  if (total > 50 * 1024 * 1024) throw new Error("Plug-in files add up to more than 50 MB");
  const m = validateManifest(JSON.parse(Buffer.from(files["plugin.json"]).toString("utf8")));
  if (!files[m.main]) throw new Error(`The zip is missing ${m.main}`);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const tmp = path.join(INSTALL_DIR, `.tmp-${m.id}-${Date.now()}`);
  for (const n of names) {
    const dest = path.join(tmp, n);
    if (!dest.startsWith(tmp + path.sep)) throw new Error(`Unsafe file name in zip: ${n}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[n]);
  }
  const final = path.join(INSTALL_DIR, m.id);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(tmp, final);
  const p = listPlugins().find((x) => x.id === m.id)!;
  return publicInfo(p);
}

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;

export function registerPluginRoutes(
  app: Express,
  deps: { auth: (req: Request, res: Response, next: NextFunction) => void; wrap: Wrap; HttpError: new (status: number, message: string) => Error },
) {
  const { auth, wrap, HttpError } = deps;
  const requireAdmin = (req: Request) => {
    if (!(req as any).user?.is_admin) throw new HttpError(403, "Only the server admin can manage plug-ins");
    if (!PLUGINS_ON) throw new HttpError(404, "Plug-ins are turned off on this server (SCUTE_PLUGINS=off)");
  };

  app.get(
    "/api/plugins",
    auth,
    wrap((req, res) => {
      const admin = !!(req as any).user?.is_admin;
      const list = listPlugins().filter((p) => admin || (p.enabled && !p.error));
      res.json({ enabled: PLUGINS_ON, apiVersion: PLUGIN_API_VERSION, net: NET_ON ? (NET_ALLOW.includes("*") ? ["*"] : NET_ALLOW) : [], plugins: list.map(publicInfo) });
    }),
  );

  app.put(
    "/api/plugins/:id",
    auth,
    express.json(),
    wrap((req, res) => {
      requireAdmin(req);
      const id = String(req.params.id);
      const p = listPlugins().find((x) => x.id === id);
      if (!p) throw new HttpError(404, "No such plug-in");
      if (p.error && req.body?.enabled) throw new HttpError(400, `Can't enable a broken plug-in: ${p.error}`);
      const s = readState();
      s.enabled[id] = !!req.body?.enabled;
      writeState(s);
      res.json(publicInfo({ ...p, enabled: s.enabled[id] }));
    }),
  );

  app.post(
    "/api/plugins",
    auth,
    express.raw({ type: () => true, limit: MAX_ZIP }),
    wrap((req, res) => {
      requireAdmin(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "Upload a plug-in .zip");
      try {
        res.json(installZip(req.body));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }),
  );

  app.delete(
    "/api/plugins/:id",
    auth,
    wrap((req, res) => {
      requireAdmin(req);
      const id = String(req.params.id);
      const p = listPlugins().find((x) => x.id === id);
      if (!p) throw new HttpError(404, "No such plug-in");
      if (p.source !== "installed") throw new HttpError(400, "Bundled plug-ins can't be removed; turn them off instead");
      fs.rmSync(p.dir, { recursive: true, force: true });
      const s = readState();
      delete s.enabled[id];
      writeState(s);
      res.json({ ok: true });
    }),
  );

  // Relay for scute.net.fetch. The request describes the target; the response
  // streams back as it arrives (so token-by-token LLM output works).
  const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "cookie", "origin", "referer"]);
  app.post(
    "/api/plugins-net",
    auth,
    express.json({ limit: "25mb" }),
    wrap(async (req, res) => {
      if (!NET_ON) throw new HttpError(403, "The plug-in network relay is off on this server (set SCUTE_PLUGIN_NET)");
      const b = req.body || {};
      let u: URL;
      try {
        u = new URL(String(b.url || ""));
      } catch {
        throw new HttpError(400, "Invalid URL");
      }
      if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only http:// and https:// URLs can be relayed");
      if (!netAllowed(u.href)) throw new HttpError(403, `${u.origin} isn't on this server's allow list (SCUTE_PLUGIN_NET)`);
      const method = String(b.method || "GET").toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new HttpError(400, "Unsupported method");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.headers || {})) if (typeof v === "string" && !HOP.has(k.toLowerCase())) headers[k] = v;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
      res.on("close", () => ctl.abort());
      let r: globalThis.Response;
      try {
        r = await fetch(u.href, { method, headers, body: ["GET", "HEAD"].includes(method) || b.body == null ? undefined : String(b.body), signal: ctl.signal, redirect: "follow" });
      } catch (e) {
        clearTimeout(timer);
        throw new HttpError(502, `Couldn't reach ${u.origin}: ${(e as Error).message}`);
      }
      res.status(200);
      res.setHeader("X-Upstream-Status", String(r.status));
      res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      try {
        if (r.body) {
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
      } catch {
        /* client went away or upstream broke; just end */
      } finally {
        clearTimeout(timer);
        res.end();
      }
    }),
  );

  // Files of enabled plug-ins. Public (a <script type=module> import can't send a
  // bearer token) but plug-in code isn't secret and nothing here is user data.
  app.get(/^\/plugins\/([a-z0-9][a-z0-9._-]{1,63})\/(.+)$/, (req, res, next) => {
    const id = (req.params as any)[0] as string;
    const rel = decodeURIComponent((req.params as any)[1] as string);
    const p = listPlugins().find((x) => x.id === id && x.enabled && !x.error);
    if (!p || !safeRel(rel)) return res.status(404).type("text/plain").send("Not found");
    const file = path.join(p.dir, rel);
    if (!file.startsWith(p.dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).type("text/plain").send("Not found");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (/\.m?js$/.test(file)) res.type("text/javascript");
    res.sendFile(file, (err) => err && next(err));
  });
}
