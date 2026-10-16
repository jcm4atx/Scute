/**
 * Bitwarden-compatible server (1.22.0).
 *
 * Bitwarden's own apps (browser extension, desktop, mobile, CLI) can use Scute as a
 * self-hosted server at <scute>/bw. It speaks the same API as Bitwarden's server
 * (modelled on Vaultwarden), so the apps work unchanged: they encrypt everything with
 * the account's key before sending it, and this server only ever stores ciphertext.
 *
 * Accounts aren't opened from the apps: the Bitwarden plug-in creates one for the
 * signed-in Scute user (keys made in the browser), and keeps the vault in sync with
 * that user's Scute password notes, again in the browser. The plug-in uses the
 * routes under /api/bitwarden with the Scute session; the apps use /bw/... with
 * Bitwarden tokens.
 *
 *   SCUTE_BITWARDEN=off        turn it off
 *   SCUTE_BITWARDEN_ICONS=off  don't fetch website icons for the apps
 */
import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { db, DATA_DIR } from "./storage";
import { userEvent } from "./events";
import { WEB_ON, checkHost } from "./web";
import { parseMultipart, cleanupUploads } from "./fedi/multipart";

const isOff = (v: string | undefined) => ["off", "0", "false", "no"].includes((v || "").toLowerCase());
export const BW_ON = !isOff(process.env.SCUTE_BITWARDEN);
const ICONS_ON = BW_ON && WEB_ON && !isOff(process.env.SCUTE_BITWARDEN_ICONS);
const BASE_PATH = (process.env.SCUTE_BASE_PATH || "").replace(/\/+$/, "");
const BW_DIR = path.join(DATA_DIR, "bitwarden");
const ATT_DIR = path.join(BW_DIR, "attachments");
const ICON_DIR = path.join(BW_DIR, "icons");
/** The version the apps see; they switch features on by it (2024.2.0 cipher keys, 2025.8.0 unlock data). */
const SERVER_VERSION = "2026.6.0";
const ACCESS_SECONDS = 2 * 3600;
const PW_ITER = 600_000; // server-side PBKDF2 over the client's password hash
const MAX_ATTACHMENT = 500 * 1024 * 1024;
const TRASH_DAYS = 30;

// ======================================================================
// Database
// ======================================================================

db.exec(`
CREATE TABLE IF NOT EXISTS bw_users (
  id TEXT PRIMARY KEY,
  scute_user TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  akey TEXT NOT NULL,
  public_key TEXT,
  private_key TEXT,
  kdf INTEGER NOT NULL,
  kdf_iter INTEGER NOT NULL,
  kdf_mem INTEGER,
  kdf_par INTEGER,
  stamp TEXT NOT NULL,
  api_key TEXT,
  avatar_color TEXT,
  equiv_domains TEXT NOT NULL DEFAULT '[]',
  excluded_globals TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  lock_holder TEXT,
  lock_until INTEGER
);
CREATE TABLE IF NOT EXISTS bw_devices (
  user_id TEXT NOT NULL REFERENCES bw_users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type INTEGER NOT NULL,
  refresh_hash TEXT,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS bw_devices_refresh ON bw_devices(refresh_hash);
CREATE TABLE IF NOT EXISTS bw_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bw_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mirror TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bw_folders_user ON bw_folders(user_id);
CREATE TABLE IF NOT EXISTS bw_ciphers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES bw_users(id) ON DELETE CASCADE,
  type INTEGER NOT NULL,
  folder_id TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  reprompt INTEGER NOT NULL DEFAULT 0,
  key TEXT,
  name TEXT NOT NULL,
  notes TEXT,
  fields TEXT,
  data TEXT NOT NULL,
  password_history TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  deleted INTEGER,
  archived INTEGER,
  mirror TEXT
);
CREATE INDEX IF NOT EXISTS bw_ciphers_user ON bw_ciphers(user_id);
CREATE TABLE IF NOT EXISTS bw_attachments (
  id TEXT PRIMARY KEY,
  cipher_id TEXT NOT NULL REFERENCES bw_ciphers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  akey TEXT,
  uploaded INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bw_attachments_cipher ON bw_attachments(cipher_id);
`);
for (const [col, type] of [["key_id", "TEXT"]] as const)
  if (!(db.prepare("PRAGMA table_info(bw_users)").all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE bw_users ADD COLUMN ${col} ${type}`);

interface BwUser {
  id: string;
  scute_user: string;
  email: string;
  name: string;
  pw_hash: string;
  pw_salt: string;
  pw_iter: number;
  akey: string;
  public_key: string | null;
  private_key: string | null;
  kdf: number;
  kdf_iter: number;
  kdf_mem: number | null;
  kdf_par: number | null;
  stamp: string;
  api_key: string | null;
  avatar_color: string | null;
  equiv_domains: string;
  excluded_globals: string;
  created: number;
  revision: number;
  lock_holder: string | null;
  lock_until: number | null;
  key_id: string | null;
}
interface DeviceRow {
  user_id: string;
  id: string;
  name: string;
  type: number;
  refresh_hash: string | null;
  created: number;
  last_seen: number;
}
interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  mirror: string | null;
  created: number;
  updated: number;
}
interface CipherRow {
  id: string;
  user_id: string;
  type: number;
  folder_id: string | null;
  favorite: number;
  reprompt: number;
  key: string | null;
  name: string;
  notes: string | null;
  fields: string | null;
  data: string;
  password_history: string | null;
  created: number;
  updated: number;
  deleted: number | null;
  archived: number | null;
  mirror: string | null;
}
interface AttRow {
  id: string;
  cipher_id: string;
  user_id: string;
  file_name: string;
  size: number;
  akey: string | null;
  uploaded: number;
  created: number;
}

const userById = (id: string) => db.prepare("SELECT * FROM bw_users WHERE id = ?").get(id) as BwUser | undefined;
const userByEmail = (email: string) => db.prepare("SELECT * FROM bw_users WHERE email = ?").get(normEmail(email)) as BwUser | undefined;
const userByScute = (id: string) => db.prepare("SELECT * FROM bw_users WHERE scute_user = ?").get(id) as BwUser | undefined;
const cipherOf = (u: BwUser, id: string) => db.prepare("SELECT * FROM bw_ciphers WHERE id = ? AND user_id = ?").get(String(id).toLowerCase(), u.id) as CipherRow | undefined;
const folderOf = (u: BwUser, id: string) => db.prepare("SELECT * FROM bw_folders WHERE id = ? AND user_id = ?").get(String(id).toLowerCase(), u.id) as FolderRow | undefined;
const attsOf = (cipherId: string) => db.prepare("SELECT * FROM bw_attachments WHERE cipher_id = ? AND uploaded = 1 ORDER BY created").all(cipherId) as AttRow[];

function normEmail(e: string) {
  return String(e || "").trim().toLowerCase();
}

/** Strictly increasing timestamps per account, so every change has its own revision. */
const lastStamp = new Map<string, number>();
function stampFor(userId: string, prev = 0) {
  const t = Math.max(Date.now(), (lastStamp.get(userId) || 0) + 1, prev + 1);
  lastStamp.set(userId, t);
  return t;
}
function bumpUser(u: BwUser, t = stampFor(u.id, u.revision)) {
  db.prepare("UPDATE bw_users SET revision = ? WHERE id = ?").run(t, u.id);
  u.revision = t;
  return t;
}

function metaSecret(k: string) {
  const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
  if (row) return Buffer.from(row.v, "hex");
  const s = crypto.randomBytes(32);
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)").run(k, s.toString("hex"));
  return s;
}
const JWT_KEY = metaSecret("bw_jwt");

// ======================================================================
// Helpers
// ======================================================================

class BwError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}
const fail = (message: string, status = 400): never => {
  throw new BwError(status, message);
};

/**
 * Bitwarden's error body (what Vaultwarden sends). `plain` leaves out
 * validationErrors, as Bitwarden's own server does for errors that aren't
 * about one field: the apps' importer reads those keys as "Ciphers[3]..." and
 * fails on anything else, hiding the message.
 */
function errorBody(message: string, plain = false) {
  return {
    message,
    validationErrors: plain ? null : { "": [message] },
    errorModel: { message, object: "error" },
    error: "",
    error_description: "",
    exceptionMessage: null,
    exceptionStackTrace: null,
    innerExceptionMessage: null,
    object: "error",
  };
}

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString().replace(/Z$/, "000Z"));
const parseDate = (s: unknown): number | null => {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && uuidRe.test(s);

/** Request bodies: older apps send PascalCase, newer camelCase. Store camelCase. */
function lc(v: any): any {
  if (Array.isArray(v)) return v.map(lc);
  if (v && typeof v === "object") {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k ? k[0].toLowerCase() + k.slice(1) : k] = lc(x);
    return o;
  }
  return v;
}
const str = (v: unknown, max = 100_000): string | null => (typeof v === "string" ? (v.length > max ? fail(`A field is too long (${v.length} characters)`) : v) : null);

/** Where the apps reach this server: https://host/prefix/bw */
function baseUrl(req: Request) {
  const fwd = String(req.headers["x-forwarded-prefix"] || "").trim().replace(/\/+$/, "");
  const prefix = /^\/[\w./~-]*$/.test(fwd) ? fwd : BASE_PATH;
  return `${req.protocol}://${req.get("host")}${prefix}/bw`;
}

// ---------- tokens ----------

function signJwt(claims: Record<string, unknown>) {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", JWT_KEY).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token: string): Record<string, any> | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac("sha256", JWT_KEY).update(`${parts[0]}.${parts[1]}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (given.length !== sig.length || !crypto.timingSafeEqual(given, sig)) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof c.exp !== "number" || c.exp * 1000 < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

const DEVICE_NAMES: Record<number, string> = {
  0: "Android", 1: "iOS", 2: "ChromeExtension", 3: "FirefoxExtension", 4: "OperaExtension", 5: "EdgeExtension", 6: "WindowsDesktop", 7: "MacOsDesktop",
  8: "LinuxDesktop", 9: "ChromeBrowser", 10: "FirefoxBrowser", 11: "OperaBrowser", 12: "EdgeBrowser", 13: "IEBrowser", 14: "UnknownBrowser", 15: "AndroidAmazon",
  16: "UWP", 17: "SafariBrowser", 18: "VivaldiBrowser", 19: "VivaldiExtension", 20: "SafariExtension", 21: "SDK", 22: "Server", 23: "WindowsCLI", 24: "MacOsCLI", 25: "LinuxCLI",
};
function deviceType(v: unknown) {
  if (typeof v === "number") return v;
  const s = String(v ?? "");
  if (/^\d+$/.test(s)) return Number(s);
  if (/ios/i.test(s)) return 1;
  if (/android/i.test(s)) return 0;
  return 14;
}

function accessToken(u: BwUser, d: DeviceRow, clientId: string, req: Request, amr = "Application") {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    nbf: now,
    exp: now + ACCESS_SECONDS,
    iss: `${baseUrl(req)}|login`,
    sub: u.id,
    premium: true,
    name: u.name,
    email: u.email,
    email_verified: true,
    sstamp: u.stamp,
    device: d.id,
    devicetype: DEVICE_NAMES[d.type] || "UnknownBrowser",
    client_id: clientId || "web",
    scope: ["api", "offline_access"],
    amr: [amr],
  });
}

// ---------- password hashes ----------

function pbkdf2(pw: string, salt: string, iter: number) {
  return new Promise<string>((resolve, reject) =>
    crypto.pbkdf2(pw, Buffer.from(salt, "hex"), iter, 32, "sha256", (e, k) => (e ? reject(e) : resolve(k.toString("hex")))),
  );
}
async function checkPassword(u: BwUser, masterPasswordHash: unknown) {
  if (typeof masterPasswordHash !== "string" || !masterPasswordHash) return false;
  const h = Buffer.from(await pbkdf2(masterPasswordHash, u.pw_salt, u.pw_iter), "hex");
  const want = Buffer.from(u.pw_hash, "hex");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
async function hashPassword(masterPasswordHash: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { pw_salt: salt, pw_iter: PW_ITER, pw_hash: await pbkdf2(masterPasswordHash, salt, PW_ITER) };
}

// naive in-memory login throttle (per address and account)
const attempts = new Map<string, { n: number; t: number }>();
function throttle(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && now - a.t < 15 * 60_000) {
    if (a.n >= 10) fail("Too many attempts. Try again in a few minutes.", 429);
    a.n++;
  } else attempts.set(key, { n: 1, t: now });
  if (attempts.size > 10_000) attempts.clear();
}

// ---------- JSON shapes ----------

function kdfJson(u: BwUser, keys: "pascal" | "camel") {
  return keys === "pascal"
    ? { KdfType: u.kdf, Iterations: u.kdf_iter, Memory: u.kdf_mem, Parallelism: u.kdf_par }
    : { kdfType: u.kdf, iterations: u.kdf_iter, memory: u.kdf_mem, parallelism: u.kdf_par };
}
function accountKeys(u: BwUser, pascal = false) {
  if (!u.private_key) return null;
  return pascal
    ? { publicKeyEncryptionKeyPair: { wrappedPrivateKey: u.private_key, publicKey: u.public_key, Object: "publicKeyEncryptionKeyPair" }, Object: "privateKeys" }
    : {
        publicKeyEncryptionKeyPair: { wrappedPrivateKey: u.private_key, publicKey: u.public_key, signedPublicKey: null, object: "publicKeyEncryptionKeyPair" },
        securityState: null,
        signatureKeyPair: null,
        object: "privateKeys",
      };
}
function profileJson(u: BwUser) {
  return {
    _status: 0,
    accountKeys: accountKeys(u),
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: true,
    premium: true,
    premiumFromOrganization: false,
    culture: "en-US",
    twoFactorEnabled: false,
    key: u.akey,
    privateKey: u.private_key,
    securityStamp: u.stamp,
    organizations: [],
    organizationsNew: [],
    providers: [],
    providerOrganizations: [],
    forcePasswordReset: false,
    avatarColor: u.avatar_color,
    usesKeyConnector: false,
    creationDate: iso(u.created),
    object: "profile",
  };
}
function folderJson(f: FolderRow) {
  return { id: f.id, revisionDate: iso(f.updated), name: f.name, object: "folder" };
}
const TYPE_KEYS: Record<number, string> = { 1: "login", 2: "secureNote", 3: "card", 4: "identity", 5: "sshKey", 6: "bankAccount", 7: "driversLicense", 8: "passport" };
function sizeName(n: number) {
  const u = ["Bytes", "KB", "MB", "GB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i++;
  }
  return `${i ? x.toFixed(2).replace(/\.?0+$/, "") : x} ${u[i]}`;
}
function attJson(a: AttRow, base: string) {
  const token = signJwt({ exp: Math.floor(Date.now() / 1000) + 300, sub: `${a.cipher_id}/${a.id}`, iss: "bw|file" });
  return { id: a.id, url: `${base}/attachments/${a.cipher_id}/${a.id}?token=${token}`, fileName: a.file_name, size: String(a.size), sizeName: sizeName(a.size), key: a.akey, object: "attachment" };
}
function parseJson(s: string | null, dflt: any) {
  if (!s) return dflt;
  try {
    return JSON.parse(s);
  } catch {
    return dflt;
  }
}
function cipherJson(c: CipherRow, base: string) {
  const atts = attsOf(c.id);
  let data = parseJson(c.data, {});
  if (c.type === 1) {
    data = { ...data, uri: null };
    if (Array.isArray(data.uris) && data.uris.length) {
      for (const u of data.uris) if (typeof u?.match === "string") u.match = /^\d+$/.test(u.match) ? Number(u.match) : null;
      data.uri = data.uris[0]?.uri ?? null;
    }
  }
  if (c.type === 2 && !(data && typeof data.type === "number")) data = { type: 0 };
  const fields = (parseJson(c.fields, []) as any[]).filter((f) => f && typeof f === "object").map((f) => ({ ...f, type: typeof f.type === "number" ? f.type : Number(f.type) || 0 }));
  const history = (parseJson(c.password_history, []) as any[]).filter((h) => h && typeof h.password === "string");
  const out: Record<string, unknown> = {
    object: "cipherDetails",
    id: c.id,
    type: c.type,
    creationDate: iso(c.created),
    revisionDate: iso(c.updated),
    deletedDate: iso(c.deleted),
    reprompt: c.reprompt === 1 ? 1 : 0,
    organizationId: null,
    key: c.key,
    attachments: atts.length ? atts.map((a) => attJson(a, base)) : null,
    organizationUseTotp: true,
    collectionIds: [],
    name: c.name,
    notes: c.notes,
    fields,
    passwordHistory: history,
    login: null,
    secureNote: null,
    card: null,
    identity: null,
    sshKey: null,
    bankAccount: null,
    driversLicense: null,
    passport: null,
    folderId: c.folder_id,
    favorite: !!c.favorite,
    archivedDate: iso(c.archived),
    edit: true,
    viewPassword: true,
    permissions: { delete: true, restore: true },
  };
  out[TYPE_KEYS[c.type] || "login"] = data;
  return out;
}

/** Apply a cipher request body (as the apps send it) to a row. */
function applyCipher(u: BwUser, row: CipherRow, body: any, opts: { checkRevision: boolean }) {
  const d = lc(body || {});
  const type = Number(d.type);
  const key = TYPE_KEYS[type];
  if (!key) fail("Invalid type");
  if (opts.checkRevision && d.lastKnownRevisionDate) {
    const t = parseDate(d.lastKnownRevisionDate);
    if (t != null && row.updated - t > 1000) fail("The client copy of this cipher is out of date. Resync the client and try again.");
  }
  if (d.organizationId) fail("Organizations aren't available on this server");
  if (d.encryptedFor && d.encryptedFor !== u.id) fail("Invalid user cipher", 422);
  if (d.encryptedByKeyId && u.key_id && d.encryptedByKeyId !== u.key_id) fail("The client encrypted this item with an old key. Sync the app and try again.", 422);
  const typeData = d[key];
  if (!typeData || typeof typeData !== "object") fail("Data missing");
  delete typeData.response;
  if (Array.isArray(typeData.uris)) for (const x of typeData.uris) if (x && typeof x === "object") delete x.response;
  const name = str(d.name, 20_000);
  if (!name) fail("The Name field is required.");
  const notes = d.notes == null ? null : str(d.notes, 50_000);
  let folder: string | null = d.folderId ? String(d.folderId).toLowerCase() : null;
  if (folder && !folderOf(u, folder)) fail("Invalid folder");
  row.type = type;
  row.key = d.key ? str(d.key, 2000) : null;
  row.name = name!;
  row.notes = notes;
  row.fields = Array.isArray(d.fields) ? JSON.stringify(d.fields.map((f: any) => (f && typeof f === "object" ? (delete f.response, f) : f))) : null;
  row.data = JSON.stringify(typeData);
  row.password_history = Array.isArray(d.passwordHistory) ? JSON.stringify(d.passwordHistory) : null;
  row.reprompt = d.reprompt === 1 ? 1 : 0;
  row.folder_id = folder;
  if (typeof d.favorite === "boolean") row.favorite = d.favorite ? 1 : 0;
  row.archived = d.archivedDate ? parseDate(d.archivedDate) : null;
  if (row.data.length + (row.notes?.length || 0) + (row.fields?.length || 0) + (row.password_history?.length || 0) > 1_000_000) fail("This item is too large");
}

function saveCipherRow(c: CipherRow, isNew: boolean) {
  if (isNew)
    db.prepare(
      `INSERT INTO bw_ciphers (id, user_id, type, folder_id, favorite, reprompt, key, name, notes, fields, data, password_history, created, updated, deleted, archived, mirror)
       VALUES (@id, @user_id, @type, @folder_id, @favorite, @reprompt, @key, @name, @notes, @fields, @data, @password_history, @created, @updated, @deleted, @archived, @mirror)`,
    ).run(c);
  else
    db.prepare(
      `UPDATE bw_ciphers SET type=@type, folder_id=@folder_id, favorite=@favorite, reprompt=@reprompt, key=@key, name=@name, notes=@notes, fields=@fields, data=@data,
       password_history=@password_history, updated=@updated, deleted=@deleted, archived=@archived, mirror=@mirror WHERE id=@id AND user_id=@user_id`,
    ).run(c);
}
function newCipherRow(u: BwUser, id: string = crypto.randomUUID()): CipherRow {
  const t = Date.now();
  return { id, user_id: u.id, type: 1, folder_id: null, favorite: 0, reprompt: 0, key: null, name: "", notes: null, fields: null, data: "{}", password_history: null, created: t, updated: t, deleted: null, archived: null, mirror: null };
}
function removeCipherFiles(cipherId: string) {
  fs.rmSync(path.join(ATT_DIR, cipherId), { recursive: true, force: true });
}

// ======================================================================
// Live notifications to the apps (SignalR over WebSocket, MessagePack)
// ======================================================================

const hubClients = new Map<string, Set<WebSocket>>(); // bitwarden user id -> sockets

function mpEncode(v: any, out: number[] = []): number[] {
  const u8 = (n: number) => out.push(n & 0xff);
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  if (v === null || v === undefined) u8(0xc0);
  else if (v === true) u8(0xc3);
  else if (v === false) u8(0xc2);
  else if (typeof v === "number") {
    if (Number.isInteger(v) && v >= 0 && v < 128) u8(v);
    else if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) (u8(0xce), u32(v));
    else if (Number.isInteger(v) && v < 0 && v >= -32) u8(0xe0 | (v + 32));
    else if (Number.isInteger(v) && v >= -0x80000000 && v < 0) (u8(0xd2), u32(v >>> 0));
    else {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(v);
      u8(0xcb);
      out.push(...b);
    }
  } else if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    if (b.length < 32) u8(0xa0 | b.length);
    else if (b.length < 256) (u8(0xd9), u8(b.length));
    else if (b.length < 65536) (u8(0xda), u16(b.length));
    else (u8(0xdb), u32(b.length));
    out.push(...b);
  } else if (v instanceof Date) {
    // timestamp extension (-1), 64-bit form: nanoseconds << 34 | seconds
    const ms = v.getTime();
    const sec = BigInt(Math.floor(ms / 1000));
    const ns = BigInt((ms % 1000) * 1_000_000);
    const ts = (ns << 34n) | sec;
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(ts);
    out.push(0xd7, 0xff, ...b);
  } else if (Array.isArray(v)) {
    if (v.length < 16) u8(0x90 | v.length);
    else (u8(0xdc), u16(v.length));
    for (const x of v) mpEncode(x, out);
  } else if (typeof v === "object") {
    const e = Object.entries(v);
    if (e.length < 16) u8(0x80 | e.length);
    else (u8(0xde), u16(e.length));
    for (const [k, x] of e) (mpEncode(k, out), mpEncode(x, out));
  }
  return out;
}
function frame(v: any) {
  const body = mpEncode(v);
  const len: number[] = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    len.push(b);
  } while (n > 0);
  return Buffer.from([...len, ...body]);
}
const UT = { CipherUpdate: 0, CipherCreate: 1, LoginDelete: 2, FolderDelete: 3, Ciphers: 4, Vault: 5, FolderCreate: 7, FolderUpdate: 8, Settings: 10, LogOut: 11 } as const;

function notifyApps(u: BwUser, type: number, payload: Record<string, unknown>, device: string | null) {
  const set = hubClients.get(u.id);
  if (!set?.size) return;
  const msg = frame([1, {}, null, "ReceiveMessage", [{ ContextId: device, Type: type, Payload: payload }]]);
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
}
function notifyCipher(u: BwUser, c: CipherRow, type: number, device: string | null) {
  notifyApps(u, type, { Id: c.id, UserId: u.id, OrganizationId: null, CollectionIds: null, RevisionDate: new Date(c.updated) }, device);
}
function notifyFolder(u: BwUser, f: { id: string; updated: number }, type: number, device: string | null) {
  notifyApps(u, type, { Id: f.id, UserId: u.id, RevisionDate: new Date(f.updated) }, device);
}
function notifyVault(u: BwUser, device: string | null) {
  notifyApps(u, UT.Vault, { UserId: u.id, Date: new Date(u.revision) }, device);
}
/** A change from an app: tell the owner's open Scute pages, so the plug-in mirrors it. */
function tellScute(u: BwUser) {
  userEvent(u.scute_user, "bitwarden");
}

function setupHub(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://x");
    const m = url.pathname.match(/^\/bw\/notifications\/(hub|anonymous-hub)\/?$/);
    if (!m) return;
    let uid: string | null = null;
    if (m[1] === "hub") {
      const h = String(req.headers.authorization || "");
      const tok = url.searchParams.get("access_token") || (h.startsWith("Bearer ") ? h.slice(7) : "");
      const c = verifyJwt(tok);
      const u = c?.sub ? userById(c.sub) : undefined;
      if (!c || !u || c.sstamp !== u.stamp) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      uid = u.id;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let alive = true;
      if (uid) {
        let set = hubClients.get(uid);
        if (!set) hubClients.set(uid, (set = new Set()));
        set.add(ws);
      }
      ws.on("message", (data, isBinary) => {
        alive = true;
        if (isBinary) return;
        const text = String(data).replace(/\x1e$/, "");
        try {
          const j = JSON.parse(text);
          if (j && j.protocol === "messagepack") ws.send(Buffer.from([0x7b, 0x7d, 0x1e]));
          else if (j && j.protocol === "json") ws.send("{}\x1e");
        } catch {
          /* ignore */
        }
      });
      ws.on("pong", () => (alive = true));
      const ping = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        if (ws.readyState === 1) {
          ws.send(frame([6]));
          ws.ping();
        }
      }, 15_000);
      const close = () => {
        clearInterval(ping);
        if (uid) {
          const set = hubClients.get(uid);
          set?.delete(ws);
          if (set && !set.size) hubClients.delete(uid);
        }
      };
      ws.on("close", close);
      ws.on("error", close);
    });
  });
}

// ======================================================================
// The Bitwarden API (for the apps)
// ======================================================================

type BwReq = Omit<Request, "params"> & { params: Record<string, string>; bw: BwUser; device: DeviceRow };

function bwAuth(req: Request, _res: Response, next: NextFunction) {
  const h = String(req.headers.authorization || "");
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const c = tok ? verifyJwt(tok) : null;
  if (!c || c.iss === "bw|file") return next(new BwError(401, "Invalid token"));
  const u = userById(String(c.sub));
  if (!u || c.sstamp !== u.stamp) return next(new BwError(401, "Invalid token"));
  const d = db.prepare("SELECT * FROM bw_devices WHERE user_id = ? AND id = ?").get(u.id, String(c.device)) as DeviceRow | undefined;
  if (!d) return next(new BwError(401, "This device was signed out"));
  if (Date.now() - d.last_seen > 60_000) db.prepare("UPDATE bw_devices SET last_seen = ? WHERE user_id = ? AND id = ?").run(Date.now(), u.id, d.id);
  (req as BwReq).bw = u;
  (req as BwReq).device = d;
  next();
}
const w =
  (fn: (req: BwReq, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = fn(req as BwReq, res);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };
const list = (data: unknown[]) => ({ data, object: "list", continuationToken: null });

function tokenResponse(u: BwUser, d: DeviceRow, refresh: string | null, clientId: string, req: Request, withKeys = true) {
  const out: Record<string, unknown> = {
    access_token: accessToken(u, d, clientId, req),
    expires_in: ACCESS_SECONDS,
    token_type: "Bearer",
    scope: "api offline_access",
  };
  if (refresh) out.refresh_token = refresh;
  if (withKeys) {
    Object.assign(out, {
      Key: u.akey,
      PrivateKey: u.private_key,
      Kdf: u.kdf,
      KdfIterations: u.kdf_iter,
      KdfMemory: u.kdf_mem,
      KdfParallelism: u.kdf_par,
      ResetMasterPassword: false,
      ForcePasswordReset: false,
      MasterPasswordPolicy: { Object: "masterPasswordPolicy" },
      AccountKeys: accountKeys(u, true),
      UserDecryptionOptions: {
        HasMasterPassword: true,
        MasterPasswordUnlock: { Kdf: kdfJson(u, "pascal"), MasterKeyEncryptedUserKey: u.akey, MasterKeyWrappedUserKey: u.akey, Salt: u.email },
        Object: "userDecryptionOptions",
      },
      unofficialServer: true,
    });
  }
  return out;
}

function identityError(res: Response, message: string, status = 400, code = "invalid_grant") {
  res.status(status).json({ ...errorBody(message), error: code, error_description: message, ErrorModel: { Message: message, Object: "error" } });
}

function registerAppRoutes(app: Express) {
  const r = express.Router();

  // CORS: the browser extension calls from its own origin. Tokens, never cookies.
  r.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", String(req.headers["access-control-request-headers"] || "Authorization, Content-Type, Accept"));
      res.setHeader("Access-Control-Max-Age", "3600");
      return res.status(204).end();
    }
    next();
  });

  // ---------- identity ----------
  const prelogin = w((req, res) => {
    const email = normEmail(lc(req.body || {}).email);
    const u = email ? userByEmail(email) : undefined;
    const kdf = u ? { kdf: u.kdf, it: u.kdf_iter, mem: u.kdf_mem, par: u.kdf_par } : { kdf: 0, it: 600_000, mem: null, par: null };
    res.json({ kdf: kdf.kdf, kdfIterations: kdf.it, kdfMemory: kdf.mem, kdfParallelism: kdf.par, kdfSettings: { iterations: kdf.it, kdfType: kdf.kdf, memory: kdf.mem, parallelism: kdf.par }, salt: null });
  });
  r.post("/identity/accounts/prelogin", prelogin);
  r.post("/identity/accounts/prelogin/password", prelogin);
  r.post("/api/accounts/prelogin", prelogin);
  const noSignup = w(() => fail("Bitwarden accounts on this server are created in Scute: open the Bitwarden plug-in there."));
  r.post("/identity/accounts/register", noSignup);
  r.post("/identity/accounts/register/send-verification-email", noSignup);
  r.post("/identity/accounts/register/finish", noSignup);
  r.post("/api/accounts/register", noSignup);
  r.get("/identity/sso/prevalidate", w(() => fail("Single sign-on isn't available on this server")));

  r.post(
    "/identity/connect/token",
    w(async (req, res) => {
      const d = req.body || {};
      const grant = String(d.grant_type || "");
      const ip = req.ip || "";
      if (grant === "refresh_token") {
        const tok = String(d.refresh_token || "");
        const dev = tok ? (db.prepare("SELECT * FROM bw_devices WHERE refresh_hash = ?").get(sha256(tok)) as DeviceRow | undefined) : undefined;
        const u = dev ? userById(dev.user_id) : undefined;
        if (!dev || !u) return identityError(res, "Invalid refresh token");
        db.prepare("UPDATE bw_devices SET last_seen = ? WHERE user_id = ? AND id = ?").run(Date.now(), u.id, dev.id);
        return res.json({ ...tokenResponse(u, dev, tok, String(d.client_id || ""), req, false) });
      }
      if (grant === "password" || grant === "client_credentials") {
        let u: BwUser | undefined;
        if (grant === "password") {
          for (const k of ["client_id", "password", "scope", "username", "deviceIdentifier", "deviceName", "deviceType"])
            if (d[k] == null || d[k] === "") return identityError(res, `${k} cannot be blank`, 400, "invalid_request");
          const email = normEmail(d.username);
          try {
            throttle(`${ip}|${email}`);
          } catch (e) {
            return identityError(res, (e as Error).message, 429);
          }
          u = userByEmail(email);
          if (!u || !(await checkPassword(u, d.password))) return identityError(res, "Username or password is incorrect. Try again");
          attempts.delete(`${ip}|${email}`);
        } else {
          const cid = String(d.client_id || "");
          const m = cid.match(/^user\.([0-9a-f-]{36})$/i);
          try {
            throttle(`${ip}|${cid}`);
          } catch (e) {
            return identityError(res, (e as Error).message, 429);
          }
          u = m ? userById(m[1].toLowerCase()) : undefined;
          const sec = String(d.client_secret || "");
          if (!u || !u.api_key || sec.length !== u.api_key.length || !crypto.timingSafeEqual(Buffer.from(sec), Buffer.from(u.api_key)))
            return identityError(res, "Incorrect client_id or client_secret", 400, "invalid_client");
          if (!d.deviceIdentifier) return identityError(res, "deviceIdentifier cannot be blank", 400, "invalid_request");
        }
        const devId = String(d.deviceIdentifier).slice(0, 64);
        const refresh = crypto.randomBytes(64).toString("base64url");
        const now = Date.now();
        const existing = db.prepare("SELECT * FROM bw_devices WHERE user_id = ? AND id = ?").get(u.id, devId) as DeviceRow | undefined;
        const type = deviceType(d.deviceType);
        const name = String(d.deviceName || DEVICE_NAMES[type] || "Device").slice(0, 100);
        if (existing) db.prepare("UPDATE bw_devices SET name = ?, type = ?, refresh_hash = ?, last_seen = ? WHERE user_id = ? AND id = ?").run(name, type, sha256(refresh), now, u.id, devId);
        else db.prepare("INSERT INTO bw_devices (user_id, id, name, type, refresh_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)").run(u.id, devId, name, type, sha256(refresh), now, now);
        const dev = db.prepare("SELECT * FROM bw_devices WHERE user_id = ? AND id = ?").get(u.id, devId) as DeviceRow;
        tellScute(u); // the device list changed
        const out = tokenResponse(u, dev, refresh, String(d.client_id || ""), req);
        if (grant === "client_credentials") {
          out.scope = "api";
          delete out.refresh_token;
        }
        return res.json(out);
      }
      return identityError(res, "Invalid type", 400, "unsupported_grant_type");
    }),
  );

  // ---------- meta ----------
  r.get("/api/config", (req, res) => {
    const base = baseUrl(req);
    res.json({
      version: SERVER_VERSION,
      gitHash: null,
      server: { name: "Scute", url: base.replace(/\/bw$/, "") },
      settings: { disableUserRegistration: true, suppressOnboardingInterstitials: true },
      environment: { vault: base, api: `${base}/api`, identity: `${base}/identity`, notifications: `${base}/notifications`, sso: "", cloudRegion: null },
      push: { pushTechnology: 0, vapidPublicKey: null },
      featureStates: {},
      communication: null,
      object: "config",
    });
  });
  r.get(["/api/alive", "/api/now", "/alive"], (_req, res) => res.json(new Date().toISOString()));
  r.get("/api/version", (_req, res) => res.json(SERVER_VERSION));

  r.get(
    "/api/devices/knowndevice",
    w((req, res) => {
      let email = String(req.headers["x-request-email"] || "").replace(/=+$/, "");
      try {
        email = Buffer.from(email, "base64url").toString("utf8");
      } catch {
        email = "";
      }
      const id = String(req.headers["x-device-identifier"] || "");
      const u = email ? userByEmail(email) : undefined;
      res.json(!!(u && id && db.prepare("SELECT 1 FROM bw_devices WHERE user_id = ? AND id = ?").get(u.id, id)));
    }),
  );

  // ---------- website icons ----------
  r.get("/icons/:domain/icon.png", (req, res) => void icon(req, res));

  // ---------- attachment downloads (signed link) ----------
  r.get(
    "/attachments/:cipher/:att",
    w((req, res) => {
      const c = verifyJwt(String(req.query.token || ""));
      if (!c || c.iss !== "bw|file" || c.sub !== `${req.params.cipher}/${req.params.att}`) fail("Invalid token", 401);
      const a = db.prepare("SELECT * FROM bw_attachments WHERE id = ? AND cipher_id = ? AND uploaded = 1").get(req.params.att, req.params.cipher) as AttRow | undefined;
      const f = a && path.join(ATT_DIR, a.cipher_id, a.id);
      if (!a || !f || !fs.existsSync(f)) fail("Attachment not found", 404);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(fs.statSync(f!).size));
      fs.createReadStream(f!).pipe(res);
    }),
  );

  // Everything below needs a Bitwarden token.
  r.use("/api", bwAuth);

  // ---------- account ----------
  r.get("/api/accounts/profile", w((req, res) => res.json(profileJson(req.bw))));
  const setProfile = w((req, res) => {
    const name = String(lc(req.body || {}).name ?? "").slice(0, 50);
    db.prepare("UPDATE bw_users SET name = ? WHERE id = ?").run(name, req.bw.id);
    req.bw.name = name;
    bumpUser(req.bw);
    res.json(profileJson(req.bw));
  });
  r.put("/api/accounts/profile", setProfile);
  r.post("/api/accounts/profile", setProfile);
  r.put(
    "/api/accounts/avatar",
    w((req, res) => {
      const c = lc(req.body || {}).avatarColor;
      const color = typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
      db.prepare("UPDATE bw_users SET avatar_color = ? WHERE id = ?").run(color, req.bw.id);
      req.bw.avatar_color = color;
      res.json(profileJson(req.bw));
    }),
  );
  r.get("/api/accounts/revision-date", w((req, res) => res.json(req.bw.revision)));
  r.get(
    "/api/accounts/keys",
    w((req, res) => {
      const u = req.bw;
      if (!u.private_key) fail("User has no key pair", 404);
      res.json({ key: u.akey, publicKey: u.public_key, privateKey: u.private_key, accountKeys: accountKeys(u), object: "keys" });
    }),
  );
  r.post(
    "/api/accounts/keys",
    w((req, res) => {
      const u = req.bw;
      const d = lc(req.body || {});
      if (u.private_key || u.public_key) fail("User has existing keypair");
      const pub = str(d.publicKey, 5000);
      const priv = str(d.encryptedPrivateKey, 10_000);
      if (!pub || !priv) fail("Keys are missing");
      db.prepare("UPDATE bw_users SET public_key = ?, private_key = ? WHERE id = ?").run(pub, priv, u.id);
      res.json({ privateKey: priv, publicKey: pub, object: "keys" });
    }),
  );
  r.get("/api/users/:id/public-key", w((req, res) => {
    const u = userById(String(req.params.id).toLowerCase());
    if (!u || u.id !== req.bw.id) fail("User doesn't exist", 404);
    res.json({ userId: u!.id, publicKey: u!.public_key, object: "userKey" });
  }));
  r.post(
    "/api/accounts/verify-password",
    w(async (req, res) => {
      if (!(await checkPassword(req.bw, lc(req.body || {}).masterPasswordHash))) fail("Invalid password");
      res.json({ object: "masterPasswordPolicy" });
    }),
  );
  r.post(
    "/api/accounts/password",
    w(async (req, res) => {
      const u = req.bw;
      const d = lc(req.body || {});
      if (!(await checkPassword(u, d.masterPasswordHash))) fail("Invalid password");
      let hash: string | null = null;
      let key: string | null = null;
      if (d.authenticationData && d.unlockData) {
        if (normEmail(d.authenticationData.salt) !== u.email || normEmail(d.unlockData.salt) !== u.email) fail("Invalid master password salt");
        hash = str(d.authenticationData.masterPasswordAuthenticationHash, 500);
        key = str(d.unlockData.masterKeyWrappedUserKey, 2000);
      } else {
        hash = str(d.newMasterPasswordHash, 500);
        key = str(d.key, 2000);
      }
      if (!hash || !key) fail("Invalid request!");
      await setPassword(u, hash!, key!, req.device.id);
      res.status(200).end();
    }),
  );
  r.post(
    "/api/accounts/kdf",
    w(async (req, res) => {
      const u = req.bw;
      const d = lc(req.body || {});
      if (!(await checkPassword(u, d.masterPasswordHash))) fail("Invalid password");
      const a = d.authenticationData;
      const un = d.unlockData;
      let kdf: any;
      let hash: string | null;
      let key: string | null;
      if (a && un) {
        if (JSON.stringify(a.kdf) !== JSON.stringify(un.kdf)) fail("KDF settings must be equal for authentication and unlock");
        if (normEmail(a.salt) !== u.email || normEmail(un.salt) !== u.email) fail("Invalid master password salt");
        kdf = a.kdf;
        hash = str(a.masterPasswordAuthenticationHash, 500);
        key = str(un.masterKeyWrappedUserKey, 2000);
      } else {
        kdf = { kdfType: d.kdf, iterations: d.kdfIterations, memory: d.kdfMemory, parallelism: d.kdfParallelism };
        hash = str(d.newMasterPasswordHash, 500);
        key = str(d.key, 2000);
      }
      const k = checkKdf(kdf);
      if (!hash || !key) fail("Invalid request!");
      db.prepare("UPDATE bw_users SET kdf = ?, kdf_iter = ?, kdf_mem = ?, kdf_par = ? WHERE id = ?").run(k.kdf, k.iter, k.mem, k.par, u.id);
      Object.assign(u, { kdf: k.kdf, kdf_iter: k.iter, kdf_mem: k.mem, kdf_par: k.par });
      await setPassword(u, hash!, key!, req.device.id);
      res.status(200).end();
    }),
  );
  r.post(
    "/api/accounts/security-stamp",
    w(async (req, res) => {
      const u = req.bw;
      if (!(await checkPassword(u, lc(req.body || {}).masterPasswordHash))) fail("Invalid password");
      signOutAll(u, null);
      res.status(200).end();
    }),
  );
  const apiKey = (rotate: boolean) =>
    w(async (req, res) => {
      const u = req.bw;
      if (!(await checkPassword(u, lc(req.body || {}).masterPasswordHash))) fail("Invalid password");
      if (rotate || !u.api_key) {
        u.api_key = crypto.randomBytes(22).toString("base64url").slice(0, 30);
        db.prepare("UPDATE bw_users SET api_key = ? WHERE id = ?").run(u.api_key, u.id);
      }
      res.json({ apiKey: u.api_key, revisionDate: iso(u.revision), object: "apiKey" });
    });
  r.post("/api/accounts/api-key", apiKey(false));
  r.post("/api/accounts/rotate-api-key", apiKey(true));
  const noDelete = w(() => fail("Delete this Bitwarden account in Scute, in the Bitwarden plug-in."));
  r.post("/api/accounts/delete", noDelete);
  r.delete("/api/accounts", noDelete);
  r.post("/api/accounts/key-management/rotate-user-account-keys", w(() => fail("Rotating the account's encryption key isn't supported on this server. Changing the master password works and keeps your data.")));
  r.post(
    "/api/accounts/key-management/user-key-id",
    w((req, res) => {
      const u = req.bw;
      if (u.key_id) fail("Unexpected data", 422);
      const id = str(lc(req.body || {}).userKeyId, 200);
      if (!id) fail("userKeyId is missing");
      db.prepare("UPDATE bw_users SET key_id = ? WHERE id = ?").run(id, u.id);
      u.key_id = id;
      res.status(200).end();
    }),
  );
  r.post("/api/accounts/password-hint", w(() => fail("Password hints aren't available on this server")));
  r.post("/api/accounts/email-token", w(() => fail("Change the email address in Scute, in the Bitwarden plug-in.")));
  r.post("/api/accounts/email", w(() => fail("Change the email address in Scute, in the Bitwarden plug-in.")));
  r.post("/api/accounts/verify-email", w((_req, res) => res.status(200).end()));

  // ---------- devices ----------
  const devJson = (d: DeviceRow, current?: string) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    identifier: d.id,
    creationDate: iso(d.created),
    revisionDate: iso(d.last_seen),
    lastActivityDate: iso(d.last_seen),
    isTrusted: false,
    encryptedUserKey: null,
    encryptedPublicKey: null,
    devicePendingAuthRequest: null,
    object: d.id === current ? "device" : "device",
  });
  r.get("/api/devices", w((req, res) => res.json(list((db.prepare("SELECT * FROM bw_devices WHERE user_id = ? ORDER BY last_seen DESC").all(req.bw.id) as DeviceRow[]).map((d) => devJson(d, req.device.id))))));
  r.get("/api/devices/identifier/:id", w((req, res) => {
    const d = db.prepare("SELECT * FROM bw_devices WHERE user_id = ? AND id = ?").get(req.bw.id, req.params.id) as DeviceRow | undefined;
    if (!d) fail("No device found", 404);
    res.json(devJson(d!));
  }));
  const ok = w((_req, res) => res.status(200).end());
  r.put("/api/devices/identifier/:id/token", ok);
  r.post("/api/devices/identifier/:id/token", ok);
  r.put("/api/devices/identifier/:id/clear-token", ok);
  r.post("/api/devices/identifier/:id/clear-token", ok);
  r.put("/api/devices/identifier/:id/web-push-auth", ok);
  r.post("/api/devices/identifier/:id/web-push-auth", ok);
  r.post("/api/devices/update-trust", ok);
  r.put("/api/devices/:id/keys", w(() => fail("Trusted devices aren't supported on this server")));
  r.post("/api/devices/:id/deactivate", w((req, res) => {
    db.prepare("DELETE FROM bw_devices WHERE user_id = ? AND id = ?").run(req.bw.id, req.params.id);
    tellScute(req.bw);
    res.status(200).end();
  }));

  // ---------- things this server doesn't have: answer empty ----------
  for (const p of [
    "/api/two-factor",
    "/api/auth-requests",
    "/api/auth-requests/pending",
    "/api/emergency-access/trusted",
    "/api/emergency-access/granted",
    "/api/collections",
    "/api/tasks",
    "/api/webauthn",
    "/api/sends",
    "/api/notifications",
    "/api/organizations",
    "/api/policies",
    "/api/security-tasks",
    "/api/providers",
  ])
    r.get(p, (_req, res) => res.json(list([])));
  r.get("/api/hibp/breach", (_req, res) => res.status(404).json(errorBody("No breaches found")));
  r.post(["/api/sends", "/api/sends/file/v2", "/api/sends/file"], w(() => fail("Bitwarden Send isn't available on this server")));
  r.post(["/api/two-factor/*rest", "/api/emergency-access/*rest", "/api/organizations", "/api/organizations/*rest"], w(() => fail("That feature isn't available on this server")));
  r.post("/api/events", ok);
  r.post("/api/collect", ok);

  // ---------- domains ----------
  const domains = (u: BwUser, excludedOnly = false) => ({ equivalentDomains: parseJson(u.equiv_domains, []), globalEquivalentDomains: excludedOnly ? [] : [], object: "domains" });
  r.get("/api/settings/domains", w((req, res) => res.json(domains(req.bw))));
  const setDomains = w((req, res) => {
    const d = lc(req.body || {});
    const eq = Array.isArray(d.equivalentDomains) ? d.equivalentDomains.filter((x: unknown) => Array.isArray(x)).map((x: unknown[]) => x.map(String).slice(0, 50)).slice(0, 200) : [];
    db.prepare("UPDATE bw_users SET equiv_domains = ? WHERE id = ?").run(JSON.stringify(eq), req.bw.id);
    req.bw.equiv_domains = JSON.stringify(eq);
    bumpUser(req.bw);
    notifyApps(req.bw, UT.Settings, { UserId: req.bw.id, Date: new Date(req.bw.revision) }, req.device.id);
    res.json({});
  });
  r.post("/api/settings/domains", setDomains);
  r.put("/api/settings/domains", setDomains);

  // ---------- sync ----------
  r.get(
    "/api/sync",
    w((req, res) => {
      const u = req.bw;
      const base = baseUrl(req);
      const ver = String(req.headers["bitwarden-client-version"] || "");
      const m = ver.match(/^(\d+)\.(\d+)/);
      const sshOk = !m || Number(m[1]) > 2024 || (Number(m[1]) === 2024 && Number(m[2]) >= 12);
      const ciphers = (db.prepare("SELECT * FROM bw_ciphers WHERE user_id = ?").all(u.id) as CipherRow[]).filter((c) => sshOk || c.type !== 5);
      const folders = db.prepare("SELECT * FROM bw_folders WHERE user_id = ?").all(u.id) as FolderRow[];
      res.json({
        profile: profileJson(u),
        folders: folders.map(folderJson),
        collections: [],
        policies: [],
        policiesNew: [],
        ciphers: ciphers.map((c) => cipherJson(c, base)),
        domains: String(req.query.excludeDomains) === "true" ? null : domains(u, true),
        sends: [],
        userDecryption: {
          masterPasswordUnlock: { kdf: kdfJson(u, "camel"), masterKeyEncryptedUserKey: u.akey, masterKeyWrappedUserKey: u.akey, salt: u.email },
          userKeyId: u.key_id,
        },
        object: "sync",
      });
    }),
  );

  // ---------- folders ----------
  r.get("/api/folders", w((req, res) => res.json(list((db.prepare("SELECT * FROM bw_folders WHERE user_id = ?").all(req.bw.id) as FolderRow[]).map(folderJson)))));
  r.get("/api/folders/:id", w((req, res) => {
    const f = folderOf(req.bw, req.params.id);
    if (!f) fail("Invalid folder", 404);
    res.json(folderJson(f!));
  }));
  r.post(
    "/api/folders",
    w((req, res) => {
      const name = str(lc(req.body || {}).name, 5000);
      if (!name) fail("The Name field is required.");
      const t = stampFor(req.bw.id);
      const f: FolderRow = { id: crypto.randomUUID(), user_id: req.bw.id, name: name!, mirror: null, created: t, updated: t };
      db.prepare("INSERT INTO bw_folders (id, user_id, name, mirror, created, updated) VALUES (@id, @user_id, @name, @mirror, @created, @updated)").run(f);
      bumpUser(req.bw, t);
      notifyFolder(req.bw, f, UT.FolderCreate, req.device.id);
      tellScute(req.bw);
      res.json(folderJson(f));
    }),
  );
  const putFolder = w((req, res) => {
    const f = folderOf(req.bw, req.params.id);
    if (!f) fail("Invalid folder", 404);
    const name = str(lc(req.body || {}).name, 5000);
    if (!name) fail("The Name field is required.");
    f!.name = name!;
    f!.updated = stampFor(req.bw.id, f!.updated);
    db.prepare("UPDATE bw_folders SET name = ?, updated = ? WHERE id = ?").run(f!.name, f!.updated, f!.id);
    bumpUser(req.bw, f!.updated);
    notifyFolder(req.bw, f!, UT.FolderUpdate, req.device.id);
    tellScute(req.bw);
    res.json(folderJson(f!));
  });
  r.put("/api/folders/:id", putFolder);
  r.post("/api/folders/:id", putFolder);
  const delFolder = w((req, res) => {
    const f = folderOf(req.bw, req.params.id);
    if (!f) fail("Invalid folder", 404);
    deleteFolderRow(req.bw, f!, req.device.id);
    tellScute(req.bw);
    res.status(200).end();
  });
  r.delete("/api/folders/:id", delFolder);
  r.post("/api/folders/:id/delete", delFolder);
  r.delete("/api/folders", w((req, res) => {
    for (const f of db.prepare("SELECT * FROM bw_folders WHERE user_id = ?").all(req.bw.id) as FolderRow[]) deleteFolderRow(req.bw, f, req.device.id);
    tellScute(req.bw);
    res.status(200).end();
  }));

  // ---------- ciphers ----------
  r.get("/api/ciphers", w((req, res) => res.json(list((db.prepare("SELECT * FROM bw_ciphers WHERE user_id = ?").all(req.bw.id) as CipherRow[]).map((c) => cipherJson(c, baseUrl(req)))))));
  const getCipher = w((req, res) => {
    const c = cipherOf(req.bw, req.params.id);
    if (!c) fail("Cipher doesn't exist", 404);
    res.json(cipherJson(c!, baseUrl(req)));
  });
  r.get("/api/ciphers/:id", getCipher);
  r.get("/api/ciphers/:id/details", getCipher);
  r.get("/api/ciphers/:id/admin", getCipher);

  const createCipher = (req: BwReq, body: any) => {
    const u = req.bw;
    const c = newCipherRow(u);
    applyCipher(u, c, body, { checkRevision: false });
    c.created = c.updated = stampFor(u.id);
    saveCipherRow(c, true);
    bumpUser(u, c.updated);
    notifyCipher(u, c, UT.CipherCreate, req.device.id);
    tellScute(u);
    return c;
  };
  r.post("/api/ciphers", w((req, res) => res.json(cipherJson(createCipher(req, req.body), baseUrl(req)))));
  r.post("/api/ciphers/create", w((req, res) => {
    const d = lc(req.body || {});
    if (Array.isArray(d.collectionIds) && d.collectionIds.length) fail("Collections aren't available on this server");
    res.json(cipherJson(createCipher(req, d.cipher), baseUrl(req)));
  }));
  const putCipher = w((req, res) => {
    const u = req.bw;
    const c = cipherOf(u, req.params.id);
    if (!c) fail("Cipher doesn't exist", 404);
    applyCipher(u, c!, req.body, { checkRevision: true });
    c!.updated = stampFor(u.id, c!.updated);
    saveCipherRow(c!, false);
    bumpUser(u, c!.updated);
    notifyCipher(u, c!, UT.CipherUpdate, req.device.id);
    tellScute(u);
    res.json(cipherJson(c!, baseUrl(req)));
  });
  // PUT/POST /api/ciphers/:id are registered after the fixed paths (import,
  // move, delete, restore, archive, purge, share), further down: Express
  // matches in order, and ":id" would otherwise swallow them.
  const partial = w((req, res) => {
    const u = req.bw;
    const c = cipherOf(u, req.params.id);
    if (!c) fail("Cipher doesn't exist", 404);
    const d = lc(req.body || {});
    const folder = d.folderId ? String(d.folderId).toLowerCase() : null;
    if (folder && !folderOf(u, folder)) fail("Invalid folder");
    c!.folder_id = folder;
    c!.favorite = d.favorite ? 1 : 0;
    c!.updated = stampFor(u.id, c!.updated);
    saveCipherRow(c!, false);
    bumpUser(u, c!.updated);
    notifyCipher(u, c!, UT.CipherUpdate, req.device.id);
    tellScute(u);
    res.json(cipherJson(c!, baseUrl(req)));
  });
  r.put("/api/ciphers/:id/partial", partial);
  r.post("/api/ciphers/:id/partial", partial);
  for (const p of ["/api/ciphers/:id/share", "/api/ciphers/share", "/api/ciphers/:id/collections", "/api/ciphers/:id/collections_v2"]) {
    r.post(p, w(() => fail("Organizations aren't available on this server")));
    r.put(p, w(() => fail("Organizations aren't available on this server")));
  }

  r.post(
    "/api/ciphers/import",
    w((req, res) => {
      const u = req.bw;
      const d = lc(req.body || {});
      const folders: any[] = Array.isArray(d.folders) ? d.folders : [];
      const ciphers: any[] = Array.isArray(d.ciphers) ? d.ciphers : [];
      const rel: any[] = Array.isArray(d.folderRelationships) ? d.folderRelationships : [];
      if (ciphers.length > 20_000) fail("Too many items in one import");
      const tx = db.transaction(() => {
        const fids: string[] = [];
        // A folder whose id is already one of this account's is reused (as
        // Bitwarden and Vaultwarden do), so re-importing an export from the
        // same account doesn't duplicate its folders.
        const mine = new Set((db.prepare("SELECT id FROM bw_folders WHERE user_id = ?").all(u.id) as { id: string }[]).map((x) => x.id));
        for (const f of folders) {
          if (typeof f?.id === "string" && mine.has(f.id)) {
            fids.push(f.id);
            continue;
          }
          const t = stampFor(u.id);
          const row: FolderRow = { id: crypto.randomUUID(), user_id: u.id, name: str(f?.name, 5000) || fail("A folder has no name"), mirror: null, created: t, updated: t };
          db.prepare("INSERT INTO bw_folders (id, user_id, name, mirror, created, updated) VALUES (@id, @user_id, @name, @mirror, @created, @updated)").run(row);
          fids.push(row.id);
        }
        const folderFor = new Map<number, string>();
        for (const x of rel) if (Number.isInteger(x?.key) && Number.isInteger(x?.value) && fids[x.value]) folderFor.set(x.key, fids[x.value]);
        ciphers.forEach((cd, i) => {
          const c = newCipherRow(u);
          applyCipher(u, c, { ...cd, folderId: null }, { checkRevision: false });
          c.folder_id = folderFor.get(i) || null;
          c.created = c.updated = stampFor(u.id);
          saveCipherRow(c, true);
        });
      });
      tx();
      bumpUser(u);
      notifyVault(u, req.device.id);
      tellScute(u);
      res.status(200).end();
    }),
  );

  const trash = (u: BwUser, ids: string[], device: string | null) => {
    for (const id of ids) {
      const c = cipherOf(u, id);
      if (!c || c.deleted) continue;
      c.deleted = c.updated = stampFor(u.id, c.updated);
      saveCipherRow(c, false);
      notifyCipher(u, c, UT.CipherUpdate, device);
    }
    bumpUser(u);
  };
  const purge = (u: BwUser, ids: string[], device: string | null) => {
    for (const id of ids) {
      const c = cipherOf(u, id);
      if (!c) continue;
      db.prepare("DELETE FROM bw_ciphers WHERE id = ?").run(c.id);
      removeCipherFiles(c.id);
      c.updated = stampFor(u.id, c.updated);
      notifyCipher(u, c, UT.LoginDelete, device);
    }
    bumpUser(u);
  };
  const restore = (u: BwUser, ids: string[], device: string | null) => {
    const out: CipherRow[] = [];
    for (const id of ids) {
      const c = cipherOf(u, id);
      if (!c) continue;
      if (c.deleted) {
        c.deleted = null;
        c.updated = stampFor(u.id, c.updated);
        saveCipherRow(c, false);
        notifyCipher(u, c, UT.CipherUpdate, device);
      }
      out.push(c);
    }
    bumpUser(u);
    return out;
  };
  const idsOf = (req: Request) => {
    const d = lc(req.body || {});
    return (Array.isArray(d.ids) ? d.ids : []).filter(isUuid).map((x: string) => x.toLowerCase()).slice(0, 20_000) as string[];
  };
  const one = (fn: (u: BwUser, ids: string[], device: string | null) => void) =>
    w((req, res) => {
      if (!cipherOf(req.bw, req.params.id)) fail("Cipher doesn't exist", 404);
      fn(req.bw, [req.params.id], req.device.id);
      tellScute(req.bw);
      res.status(200).end();
    });
  const many = (fn: (u: BwUser, ids: string[], device: string | null) => void) =>
    w((req, res) => {
      fn(req.bw, idsOf(req), req.device.id);
      tellScute(req.bw);
      res.status(200).end();
    });
  r.put("/api/ciphers/:id/delete", one(trash));
  r.put("/api/ciphers/delete", many(trash));
  r.delete("/api/ciphers/:id", one(purge));
  r.post("/api/ciphers/:id/delete", one(purge));
  r.delete("/api/ciphers", many(purge));
  r.post("/api/ciphers/delete", many(purge));
  r.put(
    "/api/ciphers/:id/restore",
    w((req, res) => {
      const [c] = restore(req.bw, [req.params.id], req.device.id);
      if (!c) fail("Cipher doesn't exist", 404);
      tellScute(req.bw);
      res.json(cipherJson(c, baseUrl(req)));
    }),
  );
  r.put(
    "/api/ciphers/restore",
    w((req, res) => {
      const out = restore(req.bw, idsOf(req), req.device.id);
      tellScute(req.bw);
      res.json(list(out.map((c) => cipherJson(c, baseUrl(req)))));
    }),
  );
  const move = w((req, res) => {
    const u = req.bw;
    const d = lc(req.body || {});
    const folder = d.folderId ? String(d.folderId).toLowerCase() : null;
    if (folder && !folderOf(u, folder)) fail("Invalid folder");
    for (const id of idsOf(req)) {
      const c = cipherOf(u, id);
      if (!c) continue;
      c.folder_id = folder;
      c.updated = stampFor(u.id, c.updated);
      saveCipherRow(c, false);
      notifyCipher(u, c, UT.CipherUpdate, req.device.id);
    }
    bumpUser(u);
    tellScute(u);
    res.status(200).end();
  });
  r.post("/api/ciphers/move", move);
  r.put("/api/ciphers/move", move);
  const archive = (on: boolean) =>
    w((req, res) => {
      const ids = req.params.id ? [req.params.id] : idsOf(req);
      const out: CipherRow[] = [];
      for (const id of ids) {
        const c = cipherOf(req.bw, id);
        if (!c) continue;
        c.archived = on ? Date.now() : null;
        c.updated = stampFor(req.bw.id, c.updated);
        saveCipherRow(c, false);
        notifyCipher(req.bw, c, UT.CipherUpdate, req.device.id);
        out.push(c);
      }
      bumpUser(req.bw);
      tellScute(req.bw);
      if (req.params.id) res.json(out[0] ? cipherJson(out[0], baseUrl(req)) : null);
      else res.json(list(out.map((c) => cipherJson(c, baseUrl(req)))));
    });
  r.put("/api/ciphers/:id/archive", archive(true));
  r.put("/api/ciphers/archive", archive(true));
  r.put("/api/ciphers/:id/unarchive", archive(false));
  r.put("/api/ciphers/unarchive", archive(false));
  r.post(
    "/api/ciphers/purge",
    w(async (req, res) => {
      const u = req.bw;
      if (req.query.organizationId) fail("Organizations aren't available on this server");
      if (!(await checkPassword(u, lc(req.body || {}).masterPasswordHash))) fail("Invalid password");
      for (const c of db.prepare("SELECT id FROM bw_ciphers WHERE user_id = ?").all(u.id) as { id: string }[]) removeCipherFiles(c.id);
      db.prepare("DELETE FROM bw_ciphers WHERE user_id = ?").run(u.id);
      db.prepare("DELETE FROM bw_folders WHERE user_id = ?").run(u.id);
      bumpUser(u);
      notifyVault(u, req.device.id);
      tellScute(u);
      res.status(200).end();
    }),
  );

  // ---------- attachments ----------
  r.post(
    "/api/ciphers/:id/attachment/v2",
    w((req, res) => {
      const u = req.bw;
      const c = cipherOf(u, req.params.id);
      if (!c) fail("Cipher doesn't exist", 404);
      const d = lc(req.body || {});
      const size = Number(d.fileSize);
      if (!Number.isFinite(size) || size < 0) fail("Attachment size can't be negative");
      if (size > MAX_ATTACHMENT) fail("Max file size is 500 MB.");
      const name = str(d.fileName, 5000);
      if (!name) fail("The file name is missing");
      const a: AttRow = { id: crypto.randomBytes(10).toString("hex"), cipher_id: c!.id, user_id: u.id, file_name: name!, size, akey: str(d.key, 2000), uploaded: 0, created: Date.now() };
      db.prepare("INSERT INTO bw_attachments (id, cipher_id, user_id, file_name, size, akey, uploaded, created) VALUES (@id, @cipher_id, @user_id, @file_name, @size, @akey, @uploaded, @created)").run(a);
      res.json({ object: "attachment-fileUpload", attachmentId: a.id, url: `/ciphers/${c!.id}/attachment/${a.id}`, fileUploadType: 0, [d.adminRequest ? "cipherMiniResponse" : "cipherResponse"]: cipherJson(c!, baseUrl(req)) });
    }),
  );
  const upload = (legacy: boolean) =>
    w(async (req, res) => {
      const u = req.bw;
      const c = cipherOf(u, req.params.id);
      if (!c) fail("Cipher doesn't exist", 404);
      let a: AttRow | undefined;
      if (!legacy) {
        a = db.prepare("SELECT * FROM bw_attachments WHERE id = ? AND cipher_id = ?").get(req.params.att, c!.id) as AttRow | undefined;
        if (!a) fail("Attachment doesn't exist");
      }
      const mp = await parseMultipart(req, { dir: path.join(BW_DIR, "uploads"), maxFileBytes: MAX_ATTACHMENT + 1024 * 1024 }).catch((e) => fail(e.message || "Upload failed"));
      try {
        const file = mp.files.data;
        if (!file) fail("No file in the upload");
        const key = typeof mp.fields.key === "string" ? mp.fields.key : null;
        if (!a) {
          a = { id: crypto.randomBytes(10).toString("hex"), cipher_id: c!.id, user_id: u.id, file_name: String(file!.filename || "file"), size: file!.size, akey: key, uploaded: 0, created: Date.now() };
          db.prepare("INSERT INTO bw_attachments (id, cipher_id, user_id, file_name, size, akey, uploaded, created) VALUES (@id, @cipher_id, @user_id, @file_name, @size, @akey, @uploaded, @created)").run(a);
        } else if (Math.abs(file!.size - a.size) > 1024 * 1024) {
          db.prepare("DELETE FROM bw_attachments WHERE id = ?").run(a.id);
          fail("Attachment size mismatch (expected within [" + a.size + "], got " + file!.size + ")");
        }
        const dir = path.join(ATT_DIR, c!.id);
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(file!.path, path.join(dir, a!.id));
        db.prepare("UPDATE bw_attachments SET uploaded = 1, size = ?, akey = COALESCE(?, akey) WHERE id = ?").run(file!.size, key, a!.id);
      } finally {
        cleanupUploads(mp);
      }
      c!.updated = stampFor(u.id, c!.updated);
      saveCipherRow(c!, false);
      bumpUser(u, c!.updated);
      notifyCipher(u, c!, UT.CipherUpdate, req.device.id);
      tellScute(u);
      if (legacy) res.json(cipherJson(c!, baseUrl(req)));
      else res.status(200).end();
    });
  r.post("/api/ciphers/:id/attachment/:att", (req, res, next) => (/^multipart/i.test(String(req.headers["content-type"] || "")) ? upload(false)(req, res, next) : next()));
  r.post("/api/ciphers/:id/attachment", upload(true));
  r.get(
    "/api/ciphers/:id/attachment/:att",
    w((req, res) => {
      const c = cipherOf(req.bw, req.params.id);
      if (!c) fail("Cipher doesn't exist", 404);
      const a = db.prepare("SELECT * FROM bw_attachments WHERE id = ? AND cipher_id = ? AND uploaded = 1").get(req.params.att, c!.id) as AttRow | undefined;
      if (!a) fail("Attachment doesn't exist");
      res.json(attJson(a!, baseUrl(req)));
    }),
  );
  const delAtt = w((req, res) => {
    const u = req.bw;
    const c = cipherOf(u, req.params.id);
    if (!c) fail("Cipher doesn't exist", 404);
    db.prepare("DELETE FROM bw_attachments WHERE id = ? AND cipher_id = ?").run(req.params.att, c!.id);
    fs.rmSync(path.join(ATT_DIR, c!.id, path.basename(req.params.att)), { force: true });
    c!.updated = stampFor(u.id, c!.updated);
    saveCipherRow(c!, false);
    bumpUser(u, c!.updated);
    notifyCipher(u, c!, UT.CipherUpdate, req.device.id);
    tellScute(u);
    res.json({ cipher: cipherJson(c!, baseUrl(req)) });
  });
  r.delete("/api/ciphers/:id/attachment/:att", delAtt);
  r.post("/api/ciphers/:id/attachment/:att/delete", delAtt);

  // Last, so the fixed /api/ciphers/<word> paths above win.
  r.put("/api/ciphers/:id", putCipher);
  r.post("/api/ciphers/:id", putCipher);

  // ---------- errors ----------
  r.use((req, res) => res.status(404).json(errorBody(`Not found: ${req.method} ${req.path}`)));
  r.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const plain = /^\/api\/ciphers\/import(\/|$)/.test(_req.path);
    if (err instanceof BwError) return res.status(err.status).json(errorBody(err.message, plain));
    const status = err?.status || err?.statusCode || 500;
    if (status >= 500) console.error("[bitwarden]", err);
    const msg = status === 413 ? "The import is too large for this server" : status >= 500 ? "Server error" : err.message || "Error";
    res.status(status).json(errorBody(msg, plain));
  });

  app.use("/bw", r);
}

async function setPassword(u: BwUser, hash: string, key: string, keepDevice: string | null) {
  const h = await hashPassword(hash);
  const stamp = crypto.randomUUID();
  db.prepare("UPDATE bw_users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, akey = ?, stamp = ? WHERE id = ?").run(h.pw_hash, h.pw_salt, h.pw_iter, key, stamp, u.id);
  Object.assign(u, h, { akey: key });
  signOutAll(u, keepDevice, stamp);
}
/** New security stamp: every app has to sign in again (except `keep`, which made the change). */
function signOutAll(u: BwUser, keep: string | null, stamp = crypto.randomUUID()) {
  notifyApps(u, UT.LogOut, { UserId: u.id, Date: new Date() }, keep);
  db.prepare("UPDATE bw_users SET stamp = ? WHERE id = ?").run(stamp, u.id);
  u.stamp = stamp;
  if (keep) db.prepare("DELETE FROM bw_devices WHERE user_id = ? AND id != ?").run(u.id, keep);
  else db.prepare("DELETE FROM bw_devices WHERE user_id = ?").run(u.id);
  bumpUser(u);
  tellScute(u);
}
function checkKdf(k: any) {
  const kdf = Number(k?.kdfType ?? k?.kdf);
  const iter = Number(k?.iterations);
  if (kdf === 0) {
    if (!Number.isInteger(iter) || iter < 600_000 || iter > 10_000_000) fail("PBKDF2 KDF iterations must be at least 600000.");
    return { kdf, iter, mem: null, par: null };
  }
  if (kdf === 1) {
    const mem = Number(k?.memory);
    const par = Number(k?.parallelism);
    if (!Number.isInteger(iter) || iter < 2 || iter > 10) fail("Argon2 KDF iterations must be between 2 and 10.");
    if (!Number.isInteger(mem) || mem < 16 || mem > 1024) fail("Argon2 memory must be between 16 MB and 1024 MB.");
    if (!Number.isInteger(par) || par < 1 || par > 16) fail("Argon2 parallelism must be between 1 and 16.");
    return { kdf, iter, mem, par };
  }
  return fail("Unknown KDF type");
}
function deleteFolderRow(u: BwUser, f: FolderRow, device: string | null) {
  const t = stampFor(u.id, f.updated);
  const affected = db.prepare("SELECT * FROM bw_ciphers WHERE user_id = ? AND folder_id = ?").all(u.id, f.id) as CipherRow[];
  db.prepare("UPDATE bw_ciphers SET folder_id = NULL, updated = ? WHERE user_id = ? AND folder_id = ?").run(t, u.id, f.id);
  db.prepare("DELETE FROM bw_folders WHERE id = ?").run(f.id);
  bumpUser(u, t);
  notifyFolder(u, { id: f.id, updated: t }, UT.FolderDelete, device);
  for (const c of affected) notifyCipher(u, { ...c, updated: t }, UT.CipherUpdate, device);
}

// ---------- icons ----------

const iconMisses = new Map<string, number>();
async function icon(req: Request, res: Response) {
  const domain = String(req.params.domain || "").toLowerCase();
  const send404 = () => res.status(404).setHeader("Cache-Control", "public, max-age=86400").end();
  if (!ICONS_ON || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return send404();
  const file = path.join(ICON_DIR, domain);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < 7 * 86400_000) {
      const buf = fs.readFileSync(file);
      res.setHeader("Content-Type", sniffImage(buf) || "image/x-icon");
      res.setHeader("Cache-Control", "public, max-age=604800");
      return res.end(buf);
    }
  } catch {
    /* not cached */
  }
  if ((iconMisses.get(domain) || 0) > Date.now() - 86400_000) return send404();
  for (const p of ["/favicon.ico", "/apple-touch-icon.png", "/favicon.png"]) {
    try {
      const buf = await fetchIcon(new URL(`https://${domain}${p}`));
      if (buf) {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        fs.writeFileSync(file, buf);
        res.setHeader("Content-Type", sniffImage(buf) || "image/x-icon");
        res.setHeader("Cache-Control", "public, max-age=604800");
        return res.end(buf);
      }
    } catch {
      /* try the next */
    }
  }
  iconMisses.set(domain, Date.now());
  if (iconMisses.size > 5000) iconMisses.clear();
  send404();
}
function sniffImage(b: Buffer) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2)) return "image/x-icon";
  if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}
async function fetchIcon(url: URL, hops = 0): Promise<Buffer | null> {
  await checkHost(url, BwError);
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 Scute icon fetcher", Accept: "image/*" } });
  if (r.status >= 300 && r.status < 400 && r.headers.get("location") && hops < 3) return fetchIcon(new URL(r.headers.get("location")!, url), hops + 1);
  if (!r.ok) return null;
  const len = Number(r.headers.get("content-length") || 0);
  if (len > 300_000) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 300_000 || buf.length < 20 || !sniffImage(buf)) return null;
  return buf;
}

// ======================================================================
// Routes for the Scute plug-in (Scute session)
// ======================================================================

interface Deps {
  auth: any;
  wrap: (fn: (req: any, res: Response) => unknown) => any;
  HttpError: any;
}

function registerPluginRoutes(app: Express, { auth, wrap, HttpError }: Deps) {
  const E = (status: number, msg: string): never => {
    throw new HttpError(status, msg);
  };
  const mine = (req: any) => userByScute(req.user.id) || E(404, "You don't have a Bitwarden account on this server yet");
  const devices = (u: BwUser) =>
    (db.prepare("SELECT * FROM bw_devices WHERE user_id = ? ORDER BY last_seen DESC").all(u.id) as DeviceRow[]).map((d) => ({ id: d.id, name: d.name, type: d.type, kind: DEVICE_NAMES[d.type] || "Unknown", created: d.created, lastSeen: d.last_seen }));
  const accountInfo = (u: BwUser) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    created: u.created,
    revision: u.revision,
    kdf: { type: u.kdf, iterations: u.kdf_iter, memory: u.kdf_mem, parallelism: u.kdf_par },
    key: u.akey,
    apiKey: !!u.api_key,
  });
  const cipherOut = (c: CipherRow, base: string) => ({ ...cipherJson(c, base), revision: c.updated, mirror: parseJson(c.mirror, null) });
  const folderOut = (f: FolderRow) => ({ id: f.id, name: f.name, revision: f.updated, mirror: parseJson(f.mirror, null) });
  const mirrorStr = (m: unknown) => {
    if (m == null) return null;
    const s = JSON.stringify(m);
    if (s.length > 2000) E(400, "mirror is too large");
    return s;
  };

  app.get(
    "/api/bitwarden",
    auth,
    wrap((req, res) => {
      const u = userByScute(req.user.id);
      res.json({ enabled: BW_ON, url: baseUrl(req), version: SERVER_VERSION, account: u ? accountInfo(u) : null, devices: u ? devices(u) : [] });
    }),
  );
  app.post(
    "/api/bitwarden/account",
    auth,
    wrap(async (req, res) => {
      if (!BW_ON) E(403, "Bitwarden access is turned off on this server");
      if (userByScute(req.user.id)) E(409, "You already have a Bitwarden account here");
      const d = req.body || {};
      const email = normEmail(d.email);
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 200) E(400, "That isn't an email address");
      if (userByEmail(email)) E(409, "That email address is already used by another account on this server");
      const k = (() => {
        try {
          return checkKdf(d.kdf);
        } catch (e) {
          return E(400, (e as Error).message);
        }
      })();
      for (const f of ["masterPasswordHash", "key", "publicKey", "privateKey"]) if (typeof d[f] !== "string" || !d[f] || d[f].length > 10_000) E(400, `${f} is missing`);
      if (!/^2\./.test(d.key) || !/^2\./.test(d.privateKey)) E(400, "Keys must be AES-256-CBC with HMAC (type 2)");
      const h = await hashPassword(d.masterPasswordHash);
      const now = Date.now();
      const u = {
        id: crypto.randomUUID(),
        scute_user: req.user.id,
        email,
        name: String(d.name || req.user.username || "").slice(0, 50),
        ...h,
        akey: d.key,
        public_key: d.publicKey,
        private_key: d.privateKey,
        kdf: k.kdf,
        kdf_iter: k.iter,
        kdf_mem: k.mem,
        kdf_par: k.par,
        stamp: crypto.randomUUID(),
        created: now,
        revision: now,
      };
      db.prepare(
        `INSERT INTO bw_users (id, scute_user, email, name, pw_hash, pw_salt, pw_iter, akey, public_key, private_key, kdf, kdf_iter, kdf_mem, kdf_par, stamp, created, revision)
         VALUES (@id, @scute_user, @email, @name, @pw_hash, @pw_salt, @pw_iter, @akey, @public_key, @private_key, @kdf, @kdf_iter, @kdf_mem, @kdf_par, @stamp, @created, @revision)`,
      ).run(u);
      res.json({ account: accountInfo(userById(u.id)!), url: baseUrl(req) });
    }),
  );
  app.patch(
    "/api/bitwarden/account",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const d = req.body || {};
      if (d.email !== undefined) {
        const email = normEmail(d.email);
        if (email !== u.email) E(400, "The email address is part of the encryption (the salt): it can't be changed. Delete the account and make a new one instead.");
      }
      if (typeof d.name === "string") {
        db.prepare("UPDATE bw_users SET name = ? WHERE id = ?").run(d.name.slice(0, 50), u.id);
        u.name = d.name.slice(0, 50);
        bumpUser(u);
        notifyApps(u, UT.Settings, { UserId: u.id, Date: new Date(u.revision) }, null);
      }
      res.json({ account: accountInfo(u) });
    }),
  );
  app.post(
    "/api/bitwarden/account/delete",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      if (normEmail(req.body?.confirm) !== u.email) E(400, "Type the account's email address to confirm");
      removeAccount(u);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/bitwarden/sign-out",
    auth,
    wrap((req, res) => {
      signOutAll(mine(req), null);
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/bitwarden/devices/:id",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      db.prepare("DELETE FROM bw_devices WHERE user_id = ? AND id = ?").run(u.id, req.params.id);
      notifyApps(u, UT.LogOut, { UserId: u.id, Date: new Date() }, null);
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/bitwarden/vault",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const base = baseUrl(req);
      res.json({
        accountId: u.id,
        revision: u.revision,
        ciphers: (db.prepare("SELECT * FROM bw_ciphers WHERE user_id = ?").all(u.id) as CipherRow[]).map((c) => cipherOut(c, base)),
        folders: (db.prepare("SELECT * FROM bw_folders WHERE user_id = ?").all(u.id) as FolderRow[]).map(folderOut),
      });
    }),
  );
  /** Create or update one cipher. `expect`: the revision the plug-in last saw (null for a new one); 409 if it moved on. */
  app.put(
    "/api/bitwarden/ciphers/:id",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const id = String(req.params.id).toLowerCase();
      if (!isUuid(id)) E(400, "Bad id");
      const d = req.body || {};
      const existing = db.prepare("SELECT * FROM bw_ciphers WHERE id = ?").get(id) as CipherRow | undefined;
      if (existing && existing.user_id !== u.id) E(404, "Not found");
      if ((existing ? existing.updated : null) !== (d.expect ?? null)) E(409, "This item changed in Bitwarden in the meantime");
      const c = existing || newCipherRow(u, id);
      try {
        applyCipher(u, c, d.cipher, { checkRevision: false });
      } catch (e) {
        E(400, (e as Error).message);
      }
      if (d.mirror !== undefined) c.mirror = mirrorStr(d.mirror);
      if (d.deleted !== undefined) c.deleted = d.deleted ? existing?.deleted || Date.now() : null;
      c.updated = stampFor(u.id, c.updated);
      if (!existing) c.created = c.updated;
      saveCipherRow(c, !existing);
      bumpUser(u, c.updated);
      notifyCipher(u, c, existing ? UT.CipherUpdate : UT.CipherCreate, null);
      res.json(cipherOut(c, baseUrl(req)));
    }),
  );
  /** Record what the plug-in mirrored, without changing the item for the apps. */
  app.post(
    "/api/bitwarden/ciphers/:id/mirror",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const c = cipherOf(u, req.params.id) || E(404, "Not found");
      if (req.body?.expect !== undefined && req.body.expect !== c.updated) E(409, "This item changed in Bitwarden in the meantime");
      db.prepare("UPDATE bw_ciphers SET mirror = ? WHERE id = ?").run(mirrorStr(req.body?.mirror), c.id);
      res.json({ ok: true, revision: c.updated });
    }),
  );
  app.post(
    "/api/bitwarden/ciphers/:id/trash",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const c = cipherOf(u, req.params.id) || E(404, "Not found");
      if (req.body?.expect !== undefined && req.body.expect !== c.updated) E(409, "This item changed in Bitwarden in the meantime");
      if (req.body?.mirror !== undefined) c.mirror = mirrorStr(req.body.mirror);
      if (!c.deleted) c.deleted = Date.now();
      c.updated = stampFor(u.id, c.updated);
      saveCipherRow(c, false);
      bumpUser(u, c.updated);
      notifyCipher(u, c, UT.CipherUpdate, null);
      res.json(cipherOut(c, baseUrl(req)));
    }),
  );
  app.delete(
    "/api/bitwarden/ciphers/:id",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const c = cipherOf(u, req.params.id) || E(404, "Not found");
      db.prepare("DELETE FROM bw_ciphers WHERE id = ?").run(c.id);
      removeCipherFiles(c.id);
      c.updated = stampFor(u.id, c.updated);
      bumpUser(u, c.updated);
      notifyCipher(u, c, UT.LoginDelete, null);
      res.json({ ok: true });
    }),
  );
  app.put(
    "/api/bitwarden/folders/:id",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const id = String(req.params.id).toLowerCase();
      if (!isUuid(id)) E(400, "Bad id");
      const name = typeof req.body?.name === "string" && req.body.name ? req.body.name : E(400, "name is required");
      if (name.length > 5000) E(400, "name is too long");
      const existing = db.prepare("SELECT * FROM bw_folders WHERE id = ?").get(id) as FolderRow | undefined;
      if (existing && existing.user_id !== u.id) E(404, "Not found");
      const t = stampFor(u.id, existing?.updated || 0);
      const mirror = req.body?.mirror !== undefined ? mirrorStr(req.body.mirror) : existing?.mirror ?? null;
      if (existing) db.prepare("UPDATE bw_folders SET name = ?, mirror = ?, updated = ? WHERE id = ?").run(name, mirror, t, id);
      else db.prepare("INSERT INTO bw_folders (id, user_id, name, mirror, created, updated) VALUES (?, ?, ?, ?, ?, ?)").run(id, u.id, name, mirror, t, t);
      bumpUser(u, t);
      notifyFolder(u, { id, updated: t }, existing ? UT.FolderUpdate : UT.FolderCreate, null);
      res.json(folderOut(db.prepare("SELECT * FROM bw_folders WHERE id = ?").get(id) as FolderRow));
    }),
  );
  app.post(
    "/api/bitwarden/folders/:id/mirror",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const f = folderOf(u, req.params.id) || E(404, "Not found");
      db.prepare("UPDATE bw_folders SET mirror = ? WHERE id = ?").run(mirrorStr(req.body?.mirror), f.id);
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/bitwarden/folders/:id",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const f = folderOf(u, req.params.id) || E(404, "Not found");
      deleteFolderRow(u, f, null);
      res.json({ ok: true });
    }),
  );
  /** A short lease, so only one browser mirrors at a time (other tabs and devices wait). */
  app.post(
    "/api/bitwarden/lock",
    auth,
    wrap((req, res) => {
      const u = mine(req);
      const holder = String(req.body?.holder || "").slice(0, 64);
      if (!holder) E(400, "holder is required");
      const now = Date.now();
      if (req.body?.release) {
        db.prepare("UPDATE bw_users SET lock_holder = NULL, lock_until = NULL WHERE id = ? AND lock_holder = ?").run(u.id, holder);
        return res.json({ ok: true });
      }
      const ttl = Math.min(Math.max(Number(req.body?.ttl) || 60_000, 5_000), 300_000);
      const r = db.prepare("UPDATE bw_users SET lock_holder = ?, lock_until = ? WHERE id = ? AND (lock_holder IS NULL OR lock_holder = ? OR lock_until < ?)").run(holder, now + ttl, u.id, holder, now);
      const cur = userById(u.id)!;
      res.json({ ok: r.changes > 0, holder: cur.lock_holder, until: cur.lock_until });
    }),
  );
}

function removeAccount(u: BwUser) {
  notifyApps(u, UT.LogOut, { UserId: u.id, Date: new Date() }, null);
  for (const c of db.prepare("SELECT id FROM bw_ciphers WHERE user_id = ?").all(u.id) as { id: string }[]) removeCipherFiles(c.id);
  db.prepare("DELETE FROM bw_users WHERE id = ?").run(u.id);
  for (const ws of hubClients.get(u.id) || []) ws.close();
  hubClients.delete(u.id);
}
/** The Scute account is being deleted. */
export function removeUserBitwarden(scuteUserId: string) {
  const u = userByScute(scuteUserId);
  if (u) removeAccount(u);
}

function purgeTrash() {
  const old = db.prepare("SELECT id, user_id FROM bw_ciphers WHERE deleted IS NOT NULL AND deleted < ?").all(Date.now() - TRASH_DAYS * 86400_000) as { id: string; user_id: string }[];
  for (const c of old) {
    db.prepare("DELETE FROM bw_ciphers WHERE id = ?").run(c.id);
    removeCipherFiles(c.id);
    const u = userById(c.user_id);
    if (u) bumpUser(u);
  }
  // uploads that were announced but never sent
  db.prepare("DELETE FROM bw_attachments WHERE uploaded = 0 AND created < ?").run(Date.now() - 86400_000);
}

export function registerBitwardenRoutes(app: Express, httpServer: Server, deps: Deps) {
  registerPluginRoutes(app, deps);
  if (!BW_ON) return;
  registerAppRoutes(app);
  setupHub(httpServer);
  purgeTrash();
  setInterval(purgeTrash, 3600_000).unref();
}
