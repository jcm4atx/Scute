import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Scute storage layer.
 *
 * The server is intentionally "dumb": it stores opaque, client-encrypted blobs
 * and enforces who is allowed to read/write them. It never sees note content,
 * titles, board names, space names, tags, or file contents.
 */

export const DATA_DIR = path.resolve(process.env.SCUTE_DATA_DIR || "./data");
export const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "scute.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0');
INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', '1');

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kdf_salt TEXT NOT NULL,
  kdf_iter INTEGER NOT NULL,
  auth_hash TEXT NOT NULL,
  auth_salt TEXT NOT NULL,
  enc_master TEXT NOT NULL,
  public_key TEXT NOT NULL,
  enc_private TEXT NOT NULL,
  enc_settings TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  enc_key TEXT NOT NULL,
  invited_by TEXT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  data TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  board_id TEXT,
  enc_key TEXT,
  data TEXT,
  file_size INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boards_space_seq ON boards(space_id, seq);
CREATE INDEX IF NOT EXISTS idx_notes_space_seq ON notes(space_id, seq);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
`);

const seqStmt = db.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'seq' RETURNING v");
export function nextSeq(): number {
  const row = seqStmt.get() as { v: string | number };
  return Number(row.v);
}
export function currentSeq(): number {
  const row = db.prepare("SELECT v FROM meta WHERE k = 'seq'").get() as { v: string };
  return Number(row.v);
}

export type Role = "owner" | "admin" | "member" | "guest";
export const ROLE_RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

export interface UserRow {
  id: string;
  username: string;
  kdf_salt: string;
  kdf_iter: number;
  auth_hash: string;
  auth_salt: string;
  enc_master: string;
  public_key: string;
  enc_private: string;
  enc_settings: string | null;
  is_admin: number;
  created: number;
}

export interface MemberRow {
  space_id: string;
  user_id: string;
  role: Role;
  status: "active" | "pending";
  enc_key: string;
  invited_by: string | null;
  seq: number;
}

export function filePath(noteId: string) {
  // noteId is validated as a UUID by the routes before reaching here
  return path.join(FILES_DIR, noteId + ".bin");
}

export function removeFile(noteId: string) {
  try {
    fs.unlinkSync(filePath(noteId));
  } catch {
    /* ignore */
  }
}
