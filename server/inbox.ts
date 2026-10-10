/**
 * Inbox (Scute 1.19.0, plug-in API 9): web addresses that other apps can send
 * data to, such as OwnTracks, Overland, GPSLogger or Traccar Client sending
 * your location. Scute can't read your notes, so it can't add incoming data
 * to them either. Instead each request is sealed to the user's public key the
 * moment it arrives (the same ECDH P-256 sealed box that shares space keys)
 * and kept until the plug-in that owns the address picks it up in the
 * browser, decrypts it and stores it in encrypted notes. Nothing readable is
 * written to disk.
 *
 *   POST|PUT|GET /in/<id>/<secret>      the secret in the address, or
 *   POST|PUT|GET /in/<id>               with HTTP Basic auth (any user name, the secret as password),
 *                                       "Authorization: Bearer <secret>" or ?token=<secret>
 *
 *   SCUTE_INBOX=off             turn it off
 *   SCUTE_INBOX_MAX_KB=1024     largest request body
 *   SCUTE_INBOX_MAX_ITEMS=200000 most waiting requests per address (then 429 until picked up)
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";
import crypto from "node:crypto";
import { db } from "./storage";
import { PLUGINS_ON, listPlugins } from "./plugins";

const off = (v: string | undefined) => ["off", "0", "false", "no"].includes((v || "").toLowerCase());
export const INBOX_ON = PLUGINS_ON && !off(process.env.SCUTE_INBOX);
const MAX_KB = Math.max(4, Number(process.env.SCUTE_INBOX_MAX_KB || 1024));
const MAX_ITEMS = Math.max(100, Number(process.env.SCUTE_INBOX_MAX_ITEMS || 200_000));
const PER_MINUTE = 600;

db.exec(`
CREATE TABLE IF NOT EXISTS inbox_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin TEXT NOT NULL,
  label TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER,
  received INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inbox_endpoints_user ON inbox_endpoints(user_id, plugin);
CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL REFERENCES inbox_endpoints(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin TEXT NOT NULL,
  received INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_items_user ON inbox_items(user_id, plugin, id);
CREATE INDEX IF NOT EXISTS inbox_items_endpoint ON inbox_items(endpoint_id);
`);

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const ID_RE = /^[a-z0-9]{12,40}$/;

/** Plug-ins that may own inbox addresses: enabled and with the "inbox" permission. */
let pluginCache: { t: number; ids: Set<string> } | null = null;
function inboxPlugin(id: string) {
  // listPlugins() reads every plug-in folder; apps may post every few seconds
  if (!pluginCache || Date.now() - pluginCache.t > 15_000)
    pluginCache = { t: Date.now(), ids: new Set(listPlugins().filter((p: any) => p.enabled && !p.error && (p.permissions || []).includes("inbox")).map((p) => p.id)) };
  return pluginCache.ids.has(id);
}
export const forgetInboxPlugins = () => void (pluginCache = null);

// ---------------------------------------------------------------- sealing
const keyCache = new Map<string, CryptoKey>();
async function publicKey(userId: string): Promise<CryptoKey | null> {
  const row = db.prepare("SELECT public_key FROM users WHERE id = ?").get(userId) as { public_key: string } | undefined;
  if (!row) return null;
  let k = keyCache.get(row.public_key);
  if (!k) {
    k = await crypto.webcrypto.subtle.importKey("spki", Buffer.from(row.public_key, "base64"), { name: "ECDH", namedCurve: "P-256" }, false, []);
    if (keyCache.size > 500) keyCache.clear();
    keyCache.set(row.public_key, k);
  }
  return k;
}
/**
 * Sealed box for bytes: [3][ephemeral public key, 65 bytes][1][iv, 12][AES-GCM ciphertext].
 * The AES key is ECDH(ephemeral private, user public), as in the client's sealKey().
 */
async function seal(pub: CryptoKey, data: Uint8Array): Promise<string> {
  const s = crypto.webcrypto.subtle;
  const eph = (await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])) as CryptoKeyPair;
  const k = await s.deriveKey({ name: "ECDH", public: pub }, eph.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.randomBytes(12);
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv }, k, data));
  const epk = new Uint8Array(await s.exportKey("raw", eph.publicKey));
  return Buffer.concat([Buffer.from([3]), epk, Buffer.from([1]), iv, ct]).toString("base64");
}

// ---------------------------------------------------------------- receiving
const rate = new Map<string, { t: number; n: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rate) if (now - v.t > 120_000) rate.delete(k);
}, 60_000).unref();

function secretFrom(req: Request): string | null {
  if (req.params.secret) return String(req.params.secret);
  const a = req.header("authorization") || "";
  if (/^basic /i.test(a)) {
    const dec = Buffer.from(a.slice(6).trim(), "base64").toString("utf8");
    const i = dec.indexOf(":");
    return i >= 0 ? dec.slice(i + 1) : dec;
  }
  if (/^bearer /i.test(a)) return a.slice(7).trim();
  const q = req.query.token ?? req.query.secret;
  if (typeof q === "string") return q;
  return req.header("x-scute-token") || null;
}

/** What the sending app expects back: OwnTracks a JSON array, Overland {"result":"ok"}. */
function reply(res: Response, body: Buffer, ct: string) {
  if (/json/i.test(ct) || /^\s*[[{]/.test(body.subarray(0, 64).toString("utf8"))) {
    try {
      const j = JSON.parse(body.toString("utf8"));
      if (j && !Array.isArray(j) && Array.isArray(j.locations)) return res.json({ result: "ok" });
    } catch {
      /* not JSON after all */
    }
    return res.json([]);
  }
  res.type("text/plain").send("OK");
}

type Wrap = (fn: (req: any, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;

export function registerInboxRoutes(app: Express, { auth, wrap, HttpError }: { auth: RequestHandler; wrap: Wrap; HttpError: new (s: number, m: string) => Error }) {
  const receive = wrap(async (req: Request, res: Response) => {
    if (!INBOX_ON) throw new HttpError(404, "Not found");
    const id = String(req.params.id || "");
    if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
    const ep = db.prepare("SELECT * FROM inbox_endpoints WHERE id = ?").get(id) as any;
    const secret = secretFrom(req);
    if (!ep || !secret || sha256(secret) !== ep.secret_hash) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Scute inbox", charset="UTF-8"');
      throw new HttpError(401, "Wrong address or password");
    }
    if (!inboxPlugin(ep.plugin)) throw new HttpError(404, "The plug-in this address belongs to is turned off");
    const now = Date.now();
    const r = rate.get(id);
    if (r && now - r.t < 60_000) {
      if (++r.n > PER_MINUTE) {
        res.setHeader("Retry-After", "60");
        throw new HttpError(429, "Too many requests; try again in a minute");
      }
    } else rate.set(id, { t: now, n: 1 });
    const waiting = (db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE endpoint_id = ?").get(id) as { n: number }).n;
    if (waiting >= MAX_ITEMS) {
      res.setHeader("Retry-After", "3600");
      throw new HttpError(429, "The inbox is full; open Scute so it can pick up what's waiting");
    }
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ct = String(req.headers["content-type"] || "");
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (k !== "token" && k !== "secret" && typeof v === "string") query[k] = v.slice(0, 2000);
    if (!body.length && !Object.keys(query).length) {
      // a test from the app (or a browser): nothing to keep
      return reply(res, body, ct);
    }
    const headers: Record<string, string> = {};
    for (const h of ["user-agent", "x-limit-u", "x-limit-d", "x-limit-name", "x-device", "x-device-id"]) {
      const v = req.header(h);
      if (v) headers[h] = v.slice(0, 300);
    }
    const text = body.toString("utf8");
    const binary = body.length > 0 && !Buffer.from(text, "utf8").equals(body);
    const item = { v: 1, method: req.method, contentType: ct.slice(0, 200), query, headers, body: binary ? body.toString("base64") : text, base64: binary || undefined, received: now };
    const pub = await publicKey(ep.user_id);
    if (!pub) throw new HttpError(404, "Not found");
    const sealed = await seal(pub, new TextEncoder().encode(JSON.stringify(item)));
    db.prepare("INSERT INTO inbox_items (endpoint_id, user_id, plugin, received, data) VALUES (?, ?, ?, ?, ?)").run(id, ep.user_id, ep.plugin, now, sealed);
    db.prepare("UPDATE inbox_endpoints SET last_used = ?, received = received + 1 WHERE id = ?").run(now, id);
    reply(res, body, ct);
  });
  const raw = express.raw({ type: () => true, limit: `${MAX_KB}kb` });
  app.all("/in/:id/:secret", raw, receive);
  app.all("/in/:id", raw, receive);

  // ---------------------------------------------------------------- the plug-in's side
  const plug = (req: any): string => {
    const p = String(req.query.plugin || req.body?.plugin || "");
    if (!INBOX_ON) throw new HttpError(403, "The inbox is turned off on this server (SCUTE_INBOX)");
    if (!inboxPlugin(p)) throw new HttpError(403, `"${p}" isn't an enabled plug-in with the "inbox" permission`);
    return p;
  };
  const view = (e: any) => ({
    id: e.id,
    label: e.label,
    created: e.created,
    lastUsed: e.last_used,
    received: e.received,
    waiting: (db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE endpoint_id = ?").get(e.id) as { n: number }).n,
    path: `/in/${e.id}`,
  });

  app.get(
    "/api/inbox",
    auth,
    wrap((req, res) => {
      if (!INBOX_ON) return res.json({ enabled: false, endpoints: [], maxKb: MAX_KB });
      const p = plug(req);
      const rows = db.prepare("SELECT * FROM inbox_endpoints WHERE user_id = ? AND plugin = ? ORDER BY created").all(req.user.id, p);
      res.json({ enabled: true, maxKb: MAX_KB, endpoints: rows.map(view) });
    }),
  );
  app.post(
    "/api/inbox",
    auth,
    express.json({ limit: "8kb" }),
    wrap((req, res) => {
      const p = plug(req);
      const label = String(req.body?.label || "").trim().slice(0, 80) || "Inbox";
      const n = (db.prepare("SELECT COUNT(*) AS n FROM inbox_endpoints WHERE user_id = ?").get(req.user.id) as { n: number }).n;
      if (n >= 50) throw new HttpError(400, "You have 50 inbox addresses already; remove some first");
      const id = crypto.randomBytes(10).toString("hex");
      const secret = crypto.randomBytes(18).toString("base64url");
      db.prepare("INSERT INTO inbox_endpoints (id, user_id, plugin, label, secret_hash, created) VALUES (?, ?, ?, ?, ?, ?)").run(id, req.user.id, p, label, sha256(secret), Date.now());
      res.json({ ...view(db.prepare("SELECT * FROM inbox_endpoints WHERE id = ?").get(id)), secret });
    }),
  );
  const mine = (req: any) => {
    const p = plug(req);
    const e = db.prepare("SELECT * FROM inbox_endpoints WHERE id = ? AND user_id = ? AND plugin = ?").get(String(req.params.id), req.user.id, p) as any;
    if (!e) throw new HttpError(404, "No such inbox address");
    return e;
  };
  app.patch(
    "/api/inbox/:id",
    auth,
    express.json({ limit: "8kb" }),
    wrap((req, res) => {
      const e = mine(req);
      const out: Record<string, unknown> = {};
      if (typeof req.body?.label === "string") db.prepare("UPDATE inbox_endpoints SET label = ? WHERE id = ?").run(req.body.label.trim().slice(0, 80) || e.label, e.id);
      if (req.body?.newSecret) {
        const secret = crypto.randomBytes(18).toString("base64url");
        db.prepare("UPDATE inbox_endpoints SET secret_hash = ? WHERE id = ?").run(sha256(secret), e.id);
        out.secret = secret;
      }
      res.json({ ...view(db.prepare("SELECT * FROM inbox_endpoints WHERE id = ?").get(e.id)), ...out });
    }),
  );
  app.delete(
    "/api/inbox/:id",
    auth,
    wrap((req, res) => {
      const e = mine(req);
      db.prepare("DELETE FROM inbox_items WHERE endpoint_id = ?").run(e.id);
      db.prepare("DELETE FROM inbox_endpoints WHERE id = ?").run(e.id);
      res.json({ ok: true });
    }),
  );
  /** Waiting requests, oldest first, still sealed: the browser opens them. */
  app.get(
    "/api/inbox-items",
    auth,
    wrap((req, res) => {
      const p = plug(req);
      const after = Math.max(0, Number(req.query.after || 0) || 0);
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 500) || 500));
      const rows = db.prepare("SELECT id, endpoint_id, received, data FROM inbox_items WHERE user_id = ? AND plugin = ? AND id > ? ORDER BY id LIMIT ?").all(req.user.id, p, after, limit + 1) as any[];
      res.json({ items: rows.slice(0, limit).map((r) => ({ id: r.id, endpoint: r.endpoint_id, received: r.received, sealed: r.data })), more: rows.length > limit });
    }),
  );
  /** Forget requests the plug-in has stored. Body: { plugin, ids: number[] }. */
  app.post(
    "/api/inbox-items/delete",
    auth,
    express.json({ limit: "2mb" }),
    wrap((req, res) => {
      const p = plug(req);
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 20_000);
      const del = db.prepare("DELETE FROM inbox_items WHERE id = ? AND user_id = ? AND plugin = ?");
      let n = 0;
      db.transaction(() => {
        for (const id of ids) n += del.run(id, req.user.id, p).changes;
      })();
      res.json({ deleted: n });
    }),
  );
}
