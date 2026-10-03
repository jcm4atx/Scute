// Shared data shapes for Scute.
// Everything under `*Data` is encrypted client-side before it reaches the server.

export type Role = "owner" | "admin" | "member" | "guest";
export type CoreNoteType = "text" | "link" | "password" | "image" | "video" | "file";
/** Built-in note types, or a type provided by a plug-in (its data lives in its own field). */
export type NoteType = CoreNoteType | (string & {});
/** "notes" and "joplin" are built in; plug-ins can provide more space kinds. */
export type SpaceKind = "notes" | "joplin" | (string & {});

export interface SpaceData {
  title: string;
  color: string;
  kind?: SpaceKind; // absent = ordinary notes space
  joplin?: JoplinConfig; // kind === "joplin"
}

/** Connection to a Joplin Server account (kept inside the encrypted space data). */
export interface JoplinConfig {
  url: string;
  email: string;
  password: string;
  autoSync?: boolean; // default true
}

/** Last state exchanged with Joplin, stored on synced notes and boards. */
export interface JoplinLink {
  updated: number; // Joplin updated_time (ms) of the last version exchanged
  hash: string; // hash of the synced fields at that point, to spot local edits
  props?: Record<string, string>; // Joplin properties Scute doesn't use, kept for round-trips
  resId?: string; // resource holding this note's attachment
}

/** Encrypted per-user preferences (stored with the account, synced to every device). */
export interface UserSettings {
  defaultSpaceId?: string | null;
  /** Plug-ins this user turned off for themselves (ids). */
  pluginsOff?: string[];
  /** Small per-plug-in storage (scute.storage), encrypted with the account. */
  pluginData?: Record<string, Record<string, unknown>>;
  /** Spaces this user keeps out of sight (ids). Only hides them from view; they still sync. */
  hiddenSpaces?: string[];
  /** What showing hidden spaces asks for: nothing, the account password, or a PIN. */
  hiddenAsk?: "none" | "password" | "pin";
  /** PBKDF2-SHA256 of the PIN (base64), when hiddenAsk is "pin". */
  hiddenPin?: { salt: string; iter: number; hash: string };
  /** Leave "Show hidden spaces" out of the space menu (then it's only in Settings, or Ctrl+Alt+H). */
  hiddenQuiet?: boolean;
}

export interface BoardData {
  title: string;
  parentId?: string | null;
  joplin?: JoplinLink;
}

export interface FileMeta {
  name: string;
  type: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number; // seconds, for video/audio
}

export interface LinkPreviewData {
  kind: "page" | "image" | "video" | "audio" | "file";
  site?: string;
  description?: string;
  image?: string; // remote preview image URL (the thumbnail itself is in `thumb`)
  checked: number; // when the preview was looked up (ms); set even if it failed
  error?: string;
}

export interface ArchiveInfo {
  at: number; // when the copy was made (ms)
  url: string; // final URL after redirects
  kind: "page" | "image" | "video" | "audio" | "file";
  title?: string;
  resources?: number; // images, styles and fonts inlined into a page copy
  skipped?: number;
}

export interface NoteData {
  type: NoteType;
  title: string;
  text: string; // markdown body / description
  url?: string;
  username?: string;
  password?: string;
  tags: string[];
  color?: string | null;
  pinned?: boolean;
  file?: FileMeta | null;
  thumb?: string | null; // small encrypted-inline data URL (image preview / video poster)
  /** Bookmarks: what the link points to, found when it was saved (see lib/web.ts). */
  preview?: LinkPreviewData;
  /** Bookmarks: a saved copy of the page/file is the note's attachment (`file`). */
  archive?: ArchiveInfo | null;
  joplin?: JoplinLink;
  /** Per-plug-in data attached to a note, keyed by plug-in id (encrypted with the note). */
  ext?: Record<string, unknown>;
  created: number;
  modified: number;
}

// raw rows from /api/sync
export interface RawSpace {
  id: string;
  owner_id: string;
  data: string;
  seq: number;
  role: Role;
  enc_key: string;
}
export interface RawMember {
  space_id: string;
  user_id: string;
  username: string;
  role: Role;
  status: "active" | "pending";
}
export interface RawInvite {
  space_id: string;
  role: Role;
  enc_key: string;
  space_data: string;
  invited_by: string | null;
}
export interface RawBoard {
  id: string;
  space_id: string;
  data: string | null;
  deleted: number;
  seq: number;
}
export interface RawNote {
  id: string;
  space_id: string;
  board_id: string | null;
  enc_key: string | null;
  data: string | null;
  file_size: number | null;
  deleted: number;
  seq: number;
}
export interface SyncResponse {
  seq: number;
  extras?: string[];
  full: boolean;
  settings: string | null;
  spaces: RawSpace[];
  members: RawMember[];
  invites: RawInvite[];
  boards: RawBoard[];
  notes: RawNote[];
}

export interface UserBundle {
  id: string;
  username: string;
  kdfSalt: string;
  kdfIter: number;
  encMaster: string;
  publicKey: string;
  encPrivate: string;
  encSettings: string | null;
  isAdmin: boolean;
  created: number;
}
