import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { APP_VERSION } from "@shared/version";
import type { Server } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { z } from "zod";
import {
  db,
  nextSeq,
  currentSeq,
  filePath,
  removeFile,
  ROLE_RANK,
  type Role,
  type UserRow,
  type MemberRow,
} from "./storage";

const VERSION = APP_VERSION;
const REGISTRATION = (process.env.SCUTE_REGISTRATION || "open").toLowerCase(); // open | closed
const MAX_UPLOAD_MB = Number(process.env.SCUTE_MAX_UPLOAD_MB || 200);
const SESSION_DAYS = Number(process.env.SCUTE_SESSION_DAYS || 90);

// ---------- helpers ----------
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const blob = z.string().max(4_000_000); // encrypted payload, base64 text
const username = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._@-]+$/, "Letters, numbers, . _ @ - only");
const b64 = z.string().max(20_000);

function serverSecret(): string {
  const row = db.prepare("SELECT v FROM meta WHERE k='secret'").get() as { v: string } | undefined;
  if (row) return row.v;
  const s = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO meta (k, v) VALUES ('secret', ?)").run(s);
  return s;
}
const SECRET = serverSecret();

function hashAuth(authKey: string, salt: string): string {
  return crypto.scryptSync(authKey, Buffer.from(salt, "hex"), 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}
function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function safeEq(a: string, b: string) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function newSession(userId: string, label: string | undefined) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, label, created, last_seen) VALUES (?,?,?,?,?)").run(
    sha256(token),
    userId,
    (label || "").slice(0, 120),
    now,
    now,
  );
  return token;
}

function userBundle(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    kdfSalt: u.kdf_salt,
    kdfIter: u.kdf_iter,
    encMaster: u.enc_master,
    publicKey: u.public_key,
    encPrivate: u.enc_private,
    encSettings: u.enc_settings,
    isAdmin: !!u.is_admin,
    created: u.created,
  };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type AuthedReq = Request & { user: UserRow; tokenHash: string };

function auth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return next(new HttpError(401, "Not signed in"));
  const th = sha256(token);
  const s = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(th) as
    | { user_id: string; last_seen: number }
    | undefined;
  if (!s || Date.now() - s.last_seen > SESSION_DAYS * 86400_000) {
    return next(new HttpError(401, "Session expired"));
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(s.user_id) as UserRow | undefined;
  if (!user) return next(new HttpError(401, "Account not found"));
  if (Date.now() - s.last_seen > 60_000) {
    db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(Date.now(), th);
  }
  (req as AuthedReq).user = user;
  (req as AuthedReq).tokenHash = th;
  next();
}

function membership(spaceId: string, userId: string): MemberRow | undefined {
  return db
    .prepare("SELECT * FROM members WHERE space_id = ? AND user_id = ? AND status = 'active'")
    .get(spaceId, userId) as MemberRow | undefined;
}
function requireRole(spaceId: string, userId: string, min: Role): MemberRow {
  const m = membership(spaceId, userId);
  if (!m) throw new HttpError(404, "Space not found");
  if (ROLE_RANK[m.role] < ROLE_RANK[min]) throw new HttpError(403, `Requires ${min} permission in this space`);
  return m;
}
function touchSpace(spaceId: string) {
  db.prepare("UPDATE spaces SET seq = ? WHERE id = ?").run(nextSeq(), spaceId);
}

const wrap =
  (fn: (req: AuthedReq, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = fn(req as AuthedReq, res);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, `${first?.path?.join(".") || "body"}: ${first?.message || "invalid"}`);
  }
  return r.data;
}

// naive in-memory login throttle
const attempts = new Map<string, { n: number; t: number }>();
function throttle(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && now - a.t < 15 * 60_000) {
    if (a.n >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
    a.n++;
  } else attempts.set(key, { n: 1, t: now });
}

// ---------- routes ----------
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/health", (_req, res) => {
    const users = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
    res.json({
      ok: true,
      name: "Scute",
      version: VERSION,
      registration: users === 0 ? "open" : REGISTRATION,
      maxUploadMb: MAX_UPLOAD_MB,
      features: ["video", "multi-upload", "slideshow", "video-thumbnails"],
      hasUsers: users > 0,
    });
  });

  // Pre-login: fetch KDF params. Unknown users get a stable fake salt so
  // usernames cannot be enumerated through this endpoint.
  app.get(
    "/api/auth/params",
    wrap((req, res) => {
      const name = parse(username, String(req.query.username || ""));
      const u = db.prepare("SELECT kdf_salt, kdf_iter FROM users WHERE username = ?").get(name) as
        | { kdf_salt: string; kdf_iter: number }
        | undefined;
      if (u) return res.json({ salt: u.kdf_salt, iter: u.kdf_iter });
      const fake = crypto.createHmac("sha256", SECRET).update(name.toLowerCase()).digest("base64");
      res.json({ salt: fake, iter: 600000 });
    }),
  );

  app.post(
    "/api/auth/register",
    wrap((req, res) => {
      const body = parse(
        z.object({
          username,
          kdfSalt: b64,
          kdfIter: z.number().int().min(100000).max(10_000_000),
          authKey: z.string().min(16).max(200),
          encMaster: b64,
          publicKey: b64,
          encPrivate: b64,
          label: z.string().max(120).optional(),
        }),
        req.body,
      );
      const count = (db.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;
      if (count > 0 && REGISTRATION !== "open") throw new HttpError(403, "Registration is closed on this server");
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(body.username)) {
        throw new HttpError(409, "That username is taken");
      }
      const id = crypto.randomUUID();
      const authSalt = crypto.randomBytes(16).toString("hex");
      db.prepare(
        `INSERT INTO users (id, username, kdf_salt, kdf_iter, auth_hash, auth_salt, enc_master, public_key, enc_private, is_admin, created)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        body.username,
        body.kdfSalt,
        body.kdfIter,
        hashAuth(body.authKey, authSalt),
        authSalt,
        body.encMaster,
        body.publicKey,
        body.encPrivate,
        count === 0 ? 1 : 0,
        Date.now(),
      );
      const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
      res.json({ token: newSession(id, body.label), user: userBundle(u) });
    }),
  );

  app.post(
    "/api/auth/login",
    wrap((req, res) => {
      const body = parse(
        z.object({ username, authKey: z.string().min(16).max(200), label: z.string().max(120).optional() }),
        req.body,
      );
      throttle(`${req.ip}|${body.username.toLowerCase()}`);
      const u = db.prepare("SELECT * FROM users WHERE username = ?").get(body.username) as UserRow | undefined;
      if (!u || !safeEq(hashAuth(body.authKey, u.auth_salt), u.auth_hash)) {
        throw new HttpError(401, "Wrong username or password");
      }
      attempts.delete(`${req.ip}|${body.username.toLowerCase()}`);
      res.json({ token: newSession(u.id, body.label), user: userBundle(u) });
    }),
  );

  app.post(
    "/api/auth/logout",
    auth,
    wrap((req, res) => {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.tokenHash);
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/me",
    auth,
    wrap((req, res) => res.json({ user: userBundle(req.user) })),
  );

  app.get(
    "/api/me/sessions",
    auth,
    wrap((req, res) => {
      const rows = db
        .prepare("SELECT token_hash, label, created, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC")
        .all(req.user.id) as { token_hash: string; label: string; created: number; last_seen: number }[];
      res.json(
        rows.map((r) => ({
          id: r.token_hash.slice(0, 16),
          label: r.label,
          created: r.created,
          lastSeen: r.last_seen,
          current: r.token_hash === req.tokenHash,
        })),
      );
    }),
  );

  app.delete(
    "/api/me/sessions/:id",
    auth,
    wrap((req, res) => {
      const id = String(req.params.id).replace(/[^0-9a-f]/g, "");
      if (id === "others") {
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(req.user.id, req.tokenHash);
      } else {
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash,1,16) = ?").run(req.user.id, id);
      }
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/me/sessions",
    auth,
    wrap((req, res) => {
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(req.user.id, req.tokenHash);
      res.json({ ok: true });
    }),
  );

  // Encrypted per-user settings blob (theme, default space, etc.)
  app.put(
    "/api/me/settings",
    auth,
    wrap((req, res) => {
      const body = parse(z.object({ data: blob }), req.body);
      db.prepare("UPDATE users SET enc_settings = ? WHERE id = ?").run(body.data, req.user.id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/me/password",
    auth,
    wrap((req, res) => {
      const body = parse(
        z.object({
          authKey: z.string().min(16).max(200),
          newKdfSalt: b64,
          newKdfIter: z.number().int().min(100000).max(10_000_000),
          newAuthKey: z.string().min(16).max(200),
          newEncMaster: b64,
        }),
        req.body,
      );
      const u = req.user;
      if (!safeEq(hashAuth(body.authKey, u.auth_salt), u.auth_hash)) throw new HttpError(401, "Current password is wrong");
      const authSalt = crypto.randomBytes(16).toString("hex");
      db.prepare(
        "UPDATE users SET kdf_salt=?, kdf_iter=?, auth_hash=?, auth_salt=?, enc_master=? WHERE id=?",
      ).run(body.newKdfSalt, body.newKdfIter, hashAuth(body.newAuthKey, authSalt), authSalt, body.newEncMaster, u.id);
      // sign out every other device
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(u.id, req.tokenHash);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/me/delete",
    auth,
    wrap((req, res) => {
      const body = parse(z.object({ authKey: z.string().min(16).max(200) }), req.body);
      const u = req.user;
      if (!safeEq(hashAuth(body.authKey, u.auth_salt), u.auth_hash)) throw new HttpError(401, "Password is wrong");
      const owned = db.prepare("SELECT id FROM spaces WHERE owner_id = ?").all(u.id) as { id: string }[];
      const tx = db.transaction(() => {
        for (const s of owned) {
          const notes = db.prepare("SELECT id FROM notes WHERE space_id = ? AND file_size IS NOT NULL").all(s.id) as {
            id: string;
          }[];
          notes.forEach((n) => removeFile(n.id));
          db.prepare("DELETE FROM spaces WHERE id = ?").run(s.id);
        }
        db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
      });
      tx();
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/users/:username/key",
    auth,
    wrap((req, res) => {
      const name = parse(username, req.params.username);
      const u = db.prepare("SELECT id, username, public_key FROM users WHERE username = ?").get(name) as
        | { id: string; username: string; public_key: string }
        | undefined;
      if (!u) throw new HttpError(404, "No user with that username on this server");
      res.json({ id: u.id, username: u.username, publicKey: u.public_key });
    }),
  );

  // ---------- sync ----------
  app.get(
    "/api/sync",
    auth,
    wrap((req, res) => {
      const since = Math.max(0, Number(req.query.since || 0) | 0);
      const uid = req.user.id;
      const seq = currentSeq();
      const spaces = db
        .prepare(
          `SELECT s.id, s.owner_id, s.data, s.seq, m.role, m.enc_key, m.seq AS mseq
           FROM spaces s JOIN members m ON m.space_id = s.id
           WHERE m.user_id = ? AND m.status = 'active'`,
        )
        .all(uid) as {
        id: string;
        owner_id: string;
        data: string;
        seq: number;
        role: Role;
        enc_key: string;
        mseq: number;
      }[];
      const ids = spaces.map((s) => s.id);
      const members = ids.length
        ? (db
            .prepare(
              `SELECT m.space_id, m.user_id, u.username, m.role, m.status
               FROM members m JOIN users u ON u.id = m.user_id
               WHERE m.space_id IN (${ids.map(() => "?").join(",")})`,
            )
            .all(...ids) as unknown[])
        : [];
      const boards: unknown[] = [];
      const notes: unknown[] = [];
      const bStmt = db.prepare("SELECT id, space_id, data, deleted, seq FROM boards WHERE space_id = ? AND seq > ?");
      const nStmt = db.prepare(
        "SELECT id, space_id, board_id, enc_key, data, file_size, deleted, seq FROM notes WHERE space_id = ? AND seq > ?",
      );
      for (const s of spaces) {
        // if membership changed after the client's cursor, send the whole space
        const eff = s.mseq > since ? 0 : since;
        for (const b of bStmt.all(s.id, eff)) boards.push(b);
        for (const n of nStmt.all(s.id, eff)) notes.push(n);
      }
      const invites = db
        .prepare(
          `SELECT m.space_id, m.role, m.enc_key, s.data AS space_data, iu.username AS invited_by
           FROM members m JOIN spaces s ON s.id = m.space_id LEFT JOIN users iu ON iu.id = m.invited_by
           WHERE m.user_id = ? AND m.status = 'pending'`,
        )
        .all(uid);
      res.json({
        seq,
        full: since === 0,
        settings: req.user.enc_settings,
        spaces: spaces.map(({ mseq, ...s }) => s),
        members,
        invites,
        boards,
        notes,
      });
    }),
  );

  // ---------- spaces ----------
  app.put(
    "/api/spaces/:id",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const body = parse(z.object({ data: blob, encKey: b64.optional() }), req.body);
      const existing = db.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as { owner_id: string } | undefined;
      const seq = nextSeq();
      if (!existing) {
        if (!body.encKey) throw new HttpError(400, "encKey required when creating a space");
        db.transaction(() => {
          db.prepare("INSERT INTO spaces (id, owner_id, data, seq) VALUES (?,?,?,?)").run(id, req.user.id, body.data, seq);
          db.prepare(
            "INSERT INTO members (space_id, user_id, role, status, enc_key, invited_by, seq) VALUES (?,?,?,?,?,?,?)",
          ).run(id, req.user.id, "owner", "active", body.encKey, null, seq);
        })();
      } else {
        requireRole(id, req.user.id, "admin");
        db.prepare("UPDATE spaces SET data = ?, seq = ? WHERE id = ?").run(body.data, seq, id);
      }
      res.json({ ok: true, seq });
    }),
  );

  app.delete(
    "/api/spaces/:id",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      requireRole(id, req.user.id, "owner");
      const files = db.prepare("SELECT id FROM notes WHERE space_id = ? AND file_size IS NOT NULL").all(id) as {
        id: string;
      }[];
      db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
      files.forEach((f) => removeFile(f.id));
      nextSeq();
      res.json({ ok: true });
    }),
  );

  // invite (or re-key) a member
  app.put(
    "/api/spaces/:id/members/:userId",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const target = parse(uuid, req.params.userId);
      const body = parse(
        z.object({ role: z.enum(["admin", "member", "guest"]), encKey: b64.optional() }),
        req.body,
      );
      const me = requireRole(id, req.user.id, "admin");
      if (body.role === "admin" && me.role !== "owner") throw new HttpError(403, "Only the owner can grant admin");
      const existing = db.prepare("SELECT * FROM members WHERE space_id = ? AND user_id = ?").get(id, target) as
        | MemberRow
        | undefined;
      const seq = nextSeq();
      if (existing) {
        if (existing.role === "owner") throw new HttpError(400, "Cannot change the owner's role");
        if (existing.role === "admin" && me.role !== "owner") throw new HttpError(403, "Only the owner can change an admin");
        db.prepare("UPDATE members SET role = ?, seq = ? WHERE space_id = ? AND user_id = ?").run(body.role, seq, id, target);
      } else {
        if (!body.encKey) throw new HttpError(400, "encKey required for invite");
        if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(target)) throw new HttpError(404, "User not found");
        db.prepare(
          "INSERT INTO members (space_id, user_id, role, status, enc_key, invited_by, seq) VALUES (?,?,?,?,?,?,?)",
        ).run(id, target, body.role, "pending", body.encKey, req.user.id, seq);
      }
      touchSpace(id);
      res.json({ ok: true });
    }),
  );

  app.delete(
    "/api/spaces/:id/members/:userId",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const target = parse(uuid, req.params.userId);
      const row = db.prepare("SELECT * FROM members WHERE space_id = ? AND user_id = ?").get(id, target) as
        | MemberRow
        | undefined;
      if (!row) throw new HttpError(404, "Not a member");
      if (row.role === "owner") throw new HttpError(400, "The owner cannot leave. Delete the space instead.");
      if (target !== req.user.id) {
        const me = requireRole(id, req.user.id, "admin");
        if (row.role === "admin" && me.role !== "owner") throw new HttpError(403, "Only the owner can remove an admin");
      }
      db.prepare("DELETE FROM members WHERE space_id = ? AND user_id = ?").run(id, target);
      touchSpace(id);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/spaces/:id/accept",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const r = db
        .prepare("UPDATE members SET status = 'active', seq = ? WHERE space_id = ? AND user_id = ? AND status = 'pending'")
        .run(nextSeq(), id, req.user.id);
      if (!r.changes) throw new HttpError(404, "Invite not found");
      touchSpace(id);
      res.json({ ok: true });
    }),
  );

  // ---------- boards ----------
  app.put(
    "/api/boards/:id",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const body = parse(z.object({ spaceId: uuid, data: blob }), req.body);
      const existing = db.prepare("SELECT space_id FROM boards WHERE id = ?").get(id) as { space_id: string } | undefined;
      requireRole(body.spaceId, req.user.id, "member");
      if (existing && existing.space_id !== body.spaceId) requireRole(existing.space_id, req.user.id, "member");
      const seq = nextSeq();
      db.prepare(
        `INSERT INTO boards (id, space_id, data, deleted, seq) VALUES (?,?,?,0,?)
         ON CONFLICT(id) DO UPDATE SET space_id = excluded.space_id, data = excluded.data, deleted = 0, seq = excluded.seq`,
      ).run(id, body.spaceId, body.data, seq);
      res.json({ ok: true, seq });
    }),
  );

  app.delete(
    "/api/boards/:id",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const b = db.prepare("SELECT space_id FROM boards WHERE id = ?").get(id) as { space_id: string } | undefined;
      if (!b) return res.json({ ok: true });
      requireRole(b.space_id, req.user.id, "member");
      const seq = nextSeq();
      db.prepare("UPDATE boards SET deleted = 1, data = NULL, seq = ? WHERE id = ?").run(seq, id);
      // notes on the board stay, just unassigned
      db.prepare("UPDATE notes SET board_id = NULL, seq = ? WHERE board_id = ? AND deleted = 0").run(seq, id);
      res.json({ ok: true, seq });
    }),
  );

  // ---------- notes ----------
  app.put(
    "/api/notes/:id",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const body = parse(
        z.object({ spaceId: uuid, boardId: uuid.nullable().optional(), encKey: b64, data: blob }),
        req.body,
      );
      requireRole(body.spaceId, req.user.id, "member");
      const existing = db.prepare("SELECT space_id, file_size FROM notes WHERE id = ?").get(id) as
        | { space_id: string; file_size: number | null }
        | undefined;
      if (existing && existing.space_id !== body.spaceId) requireRole(existing.space_id, req.user.id, "member");
      if (body.boardId) {
        const b = db.prepare("SELECT space_id FROM boards WHERE id = ? AND deleted = 0").get(body.boardId) as
          | { space_id: string }
          | undefined;
        if (!b || b.space_id !== body.spaceId) throw new HttpError(400, "Board is not in that space");
      }
      const seq = nextSeq();
      db.prepare(
        `INSERT INTO notes (id, space_id, board_id, enc_key, data, file_size, deleted, seq) VALUES (?,?,?,?,?,?,0,?)
         ON CONFLICT(id) DO UPDATE SET space_id = excluded.space_id, board_id = excluded.board_id,
           enc_key = excluded.enc_key, data = excluded.data, deleted = 0, seq = excluded.seq`,
      ).run(id, body.spaceId, body.boardId ?? null, body.encKey, body.data, existing?.file_size ?? null, seq);
      res.json({ ok: true, seq });
    }),
  );

  app.delete(
    "/api/notes/:id",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.id);
      const n = db.prepare("SELECT space_id FROM notes WHERE id = ?").get(id) as { space_id: string } | undefined;
      if (!n) return res.json({ ok: true });
      requireRole(n.space_id, req.user.id, "member");
      const seq = nextSeq();
      db.prepare(
        "UPDATE notes SET deleted = 1, data = NULL, enc_key = NULL, board_id = NULL, file_size = NULL, seq = ? WHERE id = ?",
      ).run(seq, id);
      removeFile(id);
      res.json({ ok: true, seq });
    }),
  );

  // ---------- encrypted file attachments ----------
  app.put(
    "/api/files/:noteId",
    auth,
    express.raw({ type: "*/*", limit: `${MAX_UPLOAD_MB}mb` }),
    wrap((req, res) => {
      const id = parse(uuid, req.params.noteId);
      const n = db.prepare("SELECT space_id FROM notes WHERE id = ? AND deleted = 0").get(id) as
        | { space_id: string }
        | undefined;
      if (!n) throw new HttpError(404, "Save the note before uploading its file");
      requireRole(n.space_id, req.user.id, "member");
      const buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, "Empty upload");
      fs.writeFileSync(filePath(id), buf);
      const seq = nextSeq();
      db.prepare("UPDATE notes SET file_size = ?, seq = ? WHERE id = ?").run(buf.length, seq, id);
      res.json({ ok: true, seq, size: buf.length });
    }),
  );

  app.get(
    "/api/files/:noteId",
    auth,
    wrap((req, res) => {
      const id = parse(uuid, req.params.noteId);
      const n = db.prepare("SELECT space_id FROM notes WHERE id = ? AND deleted = 0").get(id) as
        | { space_id: string }
        | undefined;
      if (!n) throw new HttpError(404, "File not found");
      requireRole(n.space_id, req.user.id, "guest");
      const p = filePath(id);
      if (!fs.existsSync(p)) throw new HttpError(404, "File not found");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=0");
      fs.createReadStream(p).pipe(res);
    }),
  );

  // JSON errors for the API
  app.use("/api", (err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err instanceof HttpError ? err.status : err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ message: status >= 500 ? "Server error" : err.message });
  });
  app.use("/api", (_req, res) => res.status(404).json({ message: "Not found" }));

  return httpServer;
}
