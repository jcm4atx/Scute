/**
 * Fediverse (Scute 1.20.0): configuration, tables and shared helpers.
 *
 * Scute can be a small ActivityPub server, like Mastodon: each Scute user may
 * have one account (@name@SCUTE_FEDI_DOMAIN), follow and be followed by people
 * on any Fediverse server, and use Mastodon apps through Mastodon's client API.
 * Unlike notes, Fediverse posts are not end-to-end encrypted: they are meant
 * for other servers, so the server keeps them readable, as Mastodon does.
 *
 *   SCUTE_FEDI_DOMAIN=jcm.social     the handle domain; turns the Fediverse on
 *   SCUTE_FEDI_URL=https://jcm.social where these addresses are served (default https://<domain>)
 *   SCUTE_FEDI=off                    turn it off
 *   SCUTE_FEDI_MAX_MB=100             largest attachment
 *   SCUTE_FEDI_USERS=john,alice       Scute users who may make an account (default: everyone)
 *   SCUTE_FEDI_PRIVATE=on             also talk to private/LAN addresses (for testing)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import zlib from "node:zlib";
import { db, DATA_DIR } from "../storage";
import { PLUGINS_ON } from "../plugins";
import { privateIp } from "../web";
import { APP_VERSION } from "../../shared/version";

const off = (v: string | undefined) => ["off", "0", "false", "no"].includes((v || "").toLowerCase());
const on = (v: string | undefined) => ["on", "1", "true", "yes"].includes((v || "").toLowerCase());

export const FEDI_DOMAIN = (process.env.SCUTE_FEDI_DOMAIN || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
export const FEDI_URL = (process.env.SCUTE_FEDI_URL || (FEDI_DOMAIN ? `https://${FEDI_DOMAIN}` : "")).trim().replace(/\/+$/, "");
export const FEDI_HOST = FEDI_URL ? new URL(FEDI_URL).host.toLowerCase() : "";
export const FEDI_ON = !!FEDI_DOMAIN && !!FEDI_URL && PLUGINS_ON && !off(process.env.SCUTE_FEDI);
export const FEDI_MAX_MB = Math.max(1, Number(process.env.SCUTE_FEDI_MAX_MB || 100));
export const FEDI_USERS = (process.env.SCUTE_FEDI_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const FEDI_PRIVATE = on(process.env.SCUTE_FEDI_PRIVATE);
export const MASTO_VERSION = `4.3.0 (compatible; Scute ${APP_VERSION})`;
export const MAX_CHARS = 5000;
export const MAX_MEDIA = 4;
export const MEDIA_DIR = path.join(DATA_DIR, "fedi", "media");
export const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
export const AS_CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  {
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    sensitive: "as:sensitive",
    Hashtag: "as:Hashtag",
    movedTo: { "@id": "as:movedTo", "@type": "@id" },
    toot: "http://joinmastodon.org/ns#",
    featured: { "@id": "toot:featured", "@type": "@id" },
    discoverable: "toot:discoverable",
    indexable: "toot:indexable",
    blurhash: "toot:blurhash",
    focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
    Emoji: "toot:Emoji",
    schema: "http://schema.org#",
    PropertyValue: "schema:PropertyValue",
    value: "schema:value",
  },
];
export const bus = new EventEmitter();
bus.setMaxListeners(0);

if (FEDI_ON) fs.mkdirSync(MEDIA_DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS fedi_actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uri TEXT NOT NULL UNIQUE,
  local INTEGER,
  type TEXT NOT NULL DEFAULT 'Person',
  username TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  url TEXT,
  avatar TEXT,
  header TEXT,
  inbox TEXT,
  shared_inbox TEXT,
  outbox TEXT,
  followers_url TEXT,
  following_url TEXT,
  featured_url TEXT,
  key_id TEXT,
  public_key TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  bot INTEGER NOT NULL DEFAULT 0,
  discoverable INTEGER NOT NULL DEFAULT 1,
  fields TEXT NOT NULL DEFAULT '[]',
  emojis TEXT NOT NULL DEFAULT '[]',
  moved_to TEXT,
  followers_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  statuses_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fedi_actors_acct ON fedi_actors(username COLLATE NOCASE, domain COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS fedi_actors_key ON fedi_actors(key_id);
CREATE TABLE IF NOT EXISTS fedi_accounts (
  id INTEGER PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  private_key TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fedi_statuses (
  id INTEGER PRIMARY KEY,
  uri TEXT NOT NULL UNIQUE,
  url TEXT,
  actor_id INTEGER NOT NULL,
  local INTEGER NOT NULL DEFAULT 0,
  in_reply_to_uri TEXT,
  in_reply_to_id INTEGER,
  in_reply_to_actor_id INTEGER,
  reblog_of INTEGER,
  content TEXT NOT NULL DEFAULT '',
  source TEXT,
  spoiler TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  sensitive INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  emojis TEXT NOT NULL DEFAULT '[]',
  poll TEXT,
  history TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  app TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS fedi_statuses_actor ON fedi_statuses(actor_id, id);
CREATE INDEX IF NOT EXISTS fedi_statuses_reply ON fedi_statuses(in_reply_to_id);
CREATE INDEX IF NOT EXISTS fedi_statuses_reply_uri ON fedi_statuses(in_reply_to_uri);
CREATE INDEX IF NOT EXISTS fedi_statuses_reblog ON fedi_statuses(reblog_of);
CREATE INDEX IF NOT EXISTS fedi_statuses_local ON fedi_statuses(local, id);
CREATE TABLE IF NOT EXISTS fedi_media (
  id INTEGER PRIMARY KEY,
  account_id INTEGER,
  status_id INTEGER,
  pos INTEGER NOT NULL DEFAULT 0,
  remote_url TEXT,
  file TEXT,
  thumb TEXT,
  type TEXT NOT NULL DEFAULT 'unknown',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  name TEXT,
  description TEXT,
  blurhash TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fedi_media_status ON fedi_media(status_id);
CREATE TABLE IF NOT EXISTS fedi_follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  uri TEXT,
  reblogs INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS fedi_follows_followee ON fedi_follows(followee_id, state);
CREATE TABLE IF NOT EXISTS fedi_likes (
  actor_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  uri TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (actor_id, status_id)
);
CREATE INDEX IF NOT EXISTS fedi_likes_status ON fedi_likes(status_id);
CREATE TABLE IF NOT EXISTS fedi_bookmarks (
  account_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (account_id, status_id)
);
CREATE TABLE IF NOT EXISTS fedi_blocks (
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (account_id, target_id, kind)
);
CREATE TABLE IF NOT EXISTS fedi_domain_blocks (
  account_id INTEGER NOT NULL,
  domain TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (account_id, domain)
);
CREATE TABLE IF NOT EXISTS fedi_home (
  account_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  PRIMARY KEY (account_id, status_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fedi_notifications (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  from_id INTEGER NOT NULL,
  status_id INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fedi_notifications_account ON fedi_notifications(account_id, id);
CREATE TABLE IF NOT EXISTS fedi_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fedi_tokens (
  token_hash TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL,
  account_id INTEGER,
  scopes TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS fedi_codes (
  code_hash TEXT PRIMARY KEY,
  app_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  challenge TEXT,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fedi_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  inbox TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  error TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fedi_deliveries_next ON fedi_deliveries(next_at);
CREATE TABLE IF NOT EXISTS fedi_markers (
  account_id INTEGER NOT NULL,
  timeline TEXT NOT NULL,
  last_read_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated INTEGER NOT NULL,
  PRIMARY KEY (account_id, timeline)
);
CREATE TABLE IF NOT EXISTS fedi_push (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  access_token TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  alerts TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'all',
  standard INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fedi_votes (
  account_id INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  choices TEXT NOT NULL,
  PRIMARY KEY (account_id, status_id)
);
CREATE TABLE IF NOT EXISTS fedi_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

export class FediError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- small helpers ----------
export const now = () => Date.now();
export const sha256hex = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (n = 32) => crypto.randomBytes(n).toString("base64url");
export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000Z");
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const json = (s: string | null | undefined, d: any = null) => {
  if (!s) return d;
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
export const idOf = (x: any): string | null => (typeof x === "string" ? x : x && typeof x === "object" && typeof x.id === "string" ? x.id : null);
export const arr = <T = any>(x: any): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
export const firstUrl = (x: any): string | null => {
  for (const v of arr(x)) {
    if (typeof v === "string") return v;
    if (v && typeof v.href === "string" && (!v.mediaType || /html/.test(v.mediaType))) return v.href;
    if (v && typeof v.url === "string") return v.url;
  }
  for (const v of arr(x)) if (v && typeof v.href === "string") return v.href;
  return null;
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Time-ordered ids, like Mastodon's: milliseconds × 1000 + a counter (safe JavaScript integers until 2255). */
let lastId = 0;
export function newId(at = Date.now(), table = "fedi_statuses") {
  let id = Math.max(Math.floor(at) * 1000, 1000);
  if (at >= Date.now() - 1000) id = Math.max(id, lastId + 1);
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  while (exists.get(id)) id++;
  if (id > lastId) lastId = id;
  return id;
}

export function kv(k: string): string | undefined;
export function kv(k: string, v: string): string;
export function kv(k: string, v?: string) {
  if (v !== undefined) {
    db.prepare("INSERT INTO fedi_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    return v;
  }
  return (db.prepare("SELECT v FROM fedi_kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
}
export const SECRET = kv("secret") || kv("secret", crypto.randomBytes(32).toString("hex"));
export const hmac = (s: string) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url").slice(0, 22);

// ---------- rows ----------
export interface ActorRow {
  id: number;
  uri: string;
  local: number | null;
  type: string;
  username: string;
  domain: string;
  display_name: string;
  note: string;
  url: string | null;
  avatar: string | null;
  header: string | null;
  inbox: string | null;
  shared_inbox: string | null;
  outbox: string | null;
  followers_url: string | null;
  following_url: string | null;
  featured_url: string | null;
  key_id: string | null;
  public_key: string | null;
  locked: number;
  bot: number;
  discoverable: number;
  fields: string;
  emojis: string;
  moved_to: string | null;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  created_at: number;
  fetched: number;
}
export interface AccountRow {
  id: number;
  user_id: string;
  username: string;
  private_key: string;
  settings: string;
  created: number;
}
export interface StatusRow {
  id: number;
  uri: string;
  url: string | null;
  actor_id: number;
  local: number;
  in_reply_to_uri: string | null;
  in_reply_to_id: number | null;
  in_reply_to_actor_id: number | null;
  reblog_of: number | null;
  content: string;
  source: string | null;
  spoiler: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  sensitive: number;
  language: string | null;
  mentions: string;
  tags: string;
  emojis: string;
  poll: string | null;
  history: string | null;
  pinned: number;
  app: string | null;
  created_at: number;
  edited_at: number | null;
}
export interface MediaRow {
  id: number;
  account_id: number | null;
  status_id: number | null;
  pos: number;
  remote_url: string | null;
  file: string | null;
  thumb: string | null;
  type: string;
  mime: string;
  name: string | null;
  description: string | null;
  blurhash: string | null;
  meta: string;
  size: number;
  created: number;
}

export const actorById = (id: number) => db.prepare("SELECT * FROM fedi_actors WHERE id = ?").get(id) as ActorRow | undefined;
export const actorByUri = (uri: string) => db.prepare("SELECT * FROM fedi_actors WHERE uri = ?").get(uri) as ActorRow | undefined;
export const statusById = (id: number) => db.prepare("SELECT * FROM fedi_statuses WHERE id = ?").get(id) as StatusRow | undefined;
export const statusByUri = (uri: string) => db.prepare("SELECT * FROM fedi_statuses WHERE uri = ?").get(uri) as StatusRow | undefined;
export const accountById = (id: number) => db.prepare("SELECT * FROM fedi_accounts WHERE id = ?").get(id) as AccountRow | undefined;
export const accountByName = (name: string) => db.prepare("SELECT * FROM fedi_accounts WHERE username = ?").get(name) as AccountRow | undefined;
export const accountByUser = (userId: string) => db.prepare("SELECT * FROM fedi_accounts WHERE user_id = ?").get(userId) as AccountRow | undefined;

export const actorUri = (name: string) => `${FEDI_URL}/users/${name}`;
export const profileUrl = (name: string) => `${FEDI_URL}/@${name}`;
export const acctOf = (a: ActorRow) => (a.local ? a.username : `${a.username}@${a.domain}`);
export const fullAcct = (a: ActorRow) => `${a.username}@${a.local ? FEDI_DOMAIN : a.domain}`;

// ---------- instance actor (signs fetches) ----------
export function instanceKeys() {
  let priv = kv("instance_private");
  let pub = kv("instance_public");
  if (!priv || !pub) {
    const k = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    priv = kv("instance_private", k.privateKey);
    pub = kv("instance_public", k.publicKey);
  }
  return { priv, pub, keyId: `${INSTANCE_ACTOR}#main-key` };
}
/**
 * The server's own actor, which signs fetches. It lived at /actor until
 * 1.20.2; servers that still hold a record from another program that used
 * that address before (mastodon.social did for jcm.social) can't refresh it
 * and refuse every signed fetch, so it has a fresh address now. /actor still
 * answers, for servers that cached it.
 */
export const INSTANCE_ACTOR = `${FEDI_URL}/instance-actor`;
export const LEGACY_INSTANCE_ACTOR = `${FEDI_URL}/actor`;

/** A local account's key, for retrying a fetch the server key was refused for. */
function accountSigner(): { keyId: string; priv: string } | null {
  const r = db.prepare("SELECT a.private_key priv, f.key_id keyId FROM fedi_accounts a JOIN fedi_actors f ON f.local = a.id WHERE f.key_id IS NOT NULL ORDER BY a.id LIMIT 1").get() as { priv: string; keyId: string } | undefined;
  return r?.priv && r.keyId ? r : null;
}
export function newKeyPair() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
}

// ---------- HTTP signatures (draft-cavage, as Mastodon uses) ----------
export function signHeaders(method: string, url: string, body: string | null, keyId: string, privateKey: string, accept?: string) {
  const u = new URL(url);
  const headers: Record<string, string> = {
    host: u.host,
    date: new Date().toUTCString(),
  };
  const names = ["(request-target)", "host", "date"];
  if (body != null) {
    headers.digest = "SHA-256=" + crypto.createHash("sha256").update(body).digest("base64");
    headers["content-type"] = "application/activity+json";
    names.push("digest", "content-type");
  }
  if (accept) headers.accept = accept;
  const lines = names.map((n) => (n === "(request-target)" ? `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}` : `${n}: ${headers[n]}`));
  const sig = crypto.sign("sha256", Buffer.from(lines.join("\n")), privateKey).toString("base64");
  headers.signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(" ")}",signature="${sig}"`;
  return headers;
}

export function parseSignature(h: string) {
  const out: Record<string, string> = {};
  for (const m of h.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// ---------- outgoing HTTP ----------
export const UA = `Scute/${APP_VERSION} (+${FEDI_URL || "https://github.com"})`;
export const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export async function checkRemote(u: URL) {
  if (u.protocol !== "https:" && !(FEDI_PRIVATE && u.protocol === "http:")) throw new FediError(400, "Only https:// addresses");
  if (u.username || u.password) throw new FediError(400, "Bad address");
  if (FEDI_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) throw new FediError(403, "Local address");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a: any) => a.address);
  if (!addrs.length) throw new FediError(502, `Couldn't find ${host}`);
  if (addrs.some(privateIp)) throw new FediError(403, "Private address");
}

/** GET with an HTTP signature (many servers require one), following up to 3 redirects. */
export async function fetchRemote(url: string, opts: { accept?: string; signed?: boolean; signer?: { keyId: string; priv: string }; maxBytes?: number; timeout?: number } = {}): Promise<{ status: number; url: string; type: string; body: Buffer }> {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(cur);
    await checkRemote(u);
    const accept = opts.accept || AP_ACCEPT;
    const k = opts.signer || instanceKeys();
    const headers: Record<string, string> = opts.signed === false ? { accept, date: new Date().toUTCString() } : signHeaders("GET", cur, null, k.keyId, k.priv, accept);
    delete (headers as any).host;
    headers["user-agent"] = UA;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeout || 15_000);
    try {
      const r = await fetch(cur, { headers, redirect: "manual", signal: ctl.signal });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        cur = new URL(r.headers.get("location")!, cur).toString();
        continue;
      }
      const max = opts.maxBytes || 4 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let size = 0;
      if (r.body) {
        for await (const c of r.body as any) {
          size += c.length;
          if (size > max) throw new FediError(413, "Too big");
          chunks.push(Buffer.from(c));
        }
      }
      return { status: r.status, url: cur, type: r.headers.get("content-type") || "", body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(t);
    }
  }
  throw new FediError(508, "Too many redirects");
}

export async function fetchJson(url: string, opts: { accept?: string; signed?: boolean } = {}): Promise<any> {
  let r = await fetchRemote(url, opts);
  const refused = (x: { status: number }) => x.status === 401 || x.status === 403;
  if (refused(r) && opts.signed !== false) {
    if (process.env.SCUTE_FEDI_DEBUG) console.warn("[fedi] refused", url, r.status, r.body.toString("utf8").slice(0, 300));
    // the server key may be refused (a stale record of it on their side); the
    // account's own key usually isn't
    const acc = accountSigner();
    if (acc) {
      const r2 = await fetchRemote(url, { ...opts, signer: acc });
      if (!refused(r2)) r = r2;
    }
  }
  // a few servers refuse signed fetches from strangers but answer unsigned ones
  if (refused(r) && opts.signed !== false) r = await fetchRemote(url, { ...opts, signed: false });
  if (r.status === 404 || r.status === 410) throw new FediError(r.status, "Gone");
  if (r.status < 200 || r.status >= 300) throw new FediError(502, `${new URL(url).host} answered ${r.status}`);
  try {
    return JSON.parse(r.body.toString("utf8"));
  } catch {
    throw new FediError(502, "Not JSON");
  }
}

// ---------- HTML ----------
const ALLOWED = new Set(["p", "br", "a", "span", "strong", "b", "em", "i", "u", "s", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "sup", "sub"]);
const CLASS_OK = /^(h-card|u-url|mention|hashtag|invisible|ellipsis|quote-inline)$/;

/** Allow-list HTML sanitiser for remote content (what Mastodon keeps). */
export function sanitize(html: string): string {
  if (!html) return "";
  let out = "";
  const stack: string[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  let skip = 0;
  let skipTag = "";
  for (const m of html.matchAll(re)) {
    const [, close, tagRaw, attrs, , text, lt] = m;
    if (text !== undefined || lt !== undefined) {
      if (!skip) out += lt ? "&lt;" : text.replace(/[<>"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!).replace(/&(?!#?\w+;)/g, "&amp;");
      continue;
    }
    if (!tagRaw) continue;
    const tag = tagRaw.toLowerCase();
    if (["script", "style", "iframe", "object", "template", "svg", "math", "title", "noscript"].includes(tag)) {
      if (!close) {
        skip++;
        skipTag = tag;
      } else if (tag === skipTag && skip) skip--;
      continue;
    }
    if (skip) continue;
    const t = /^h[1-6]$/.test(tag) ? "strong" : tag;
    if (!ALLOWED.has(tag)) {
      if (["div", "section", "article", "header", "footer", "figure", "figcaption", "aside", "details", "summary", "table", "tr"].includes(tag) && close) out += "<br>";
      continue;
    }
    if (close) {
      const i = stack.lastIndexOf(t);
      if (i >= 0) {
        for (let j = stack.length - 1; j >= i; j--) out += `</${stack[j]}>`;
        stack.length = i;
      }
      continue;
    }
    if (t === "br") {
      out += "<br>";
      continue;
    }
    let a = "";
    if (t === "a") {
      const href = (attrs || "").match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const h = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
      const hd = h.replace(/&amp;/g, "&");
      if (/^(https?:|mailto:|xmpp:|gopher:|gemini:|magnet:|dat:|ipfs:|matrix:)/i.test(hd.trim())) a += ` href="${escapeHtml(hd.trim())}"`;
      a += ' rel="nofollow noopener noreferrer" target="_blank"';
    }
    const cls = (attrs || "").match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (cls && (t === "a" || t === "span")) {
      const ok = (cls[1] ?? cls[2] ?? "").split(/\s+/).filter((c) => CLASS_OK.test(c));
      if (ok.length) a += ` class="${ok.join(" ")}"`;
    }
    out += `<${t}${a}>`;
    stack.push(t);
  }
  for (let j = stack.length - 1; j >= 0; j--) out += `</${stack[j]}>`;
  return out;
}

export function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

// ---------- media helpers ----------
export function mediaKind(mime: string): "image" | "video" | "gifv" | "audio" | "unknown" {
  if (/^image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp)$/.test(mime)) return "image";
  if (/^video\//.test(mime)) return "video";
  if (/^audio\//.test(mime)) return "audio";
  return "unknown";
}

/** Width and height from the first bytes of PNG, JPEG, GIF and WebP files. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const f = buf.toString("ascii", 12, 16);
      if (f === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (f === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (f === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const m = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* unknown */
  }
  return null;
}

/** A plain PNG of one colour (default avatars and headers). */
export function solidPng(w: number, h: number, rgb: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
