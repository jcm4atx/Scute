// Shared data shapes for Scute.
// Everything under `*Data` is encrypted client-side before it reaches the server.

export type Role = "owner" | "admin" | "member" | "guest";
export type NoteType = "text" | "link" | "password" | "image" | "video" | "file";

export interface SpaceData {
  title: string;
  color: string;
}

export interface BoardData {
  title: string;
  parentId?: string | null;
}

export interface FileMeta {
  name: string;
  type: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number; // seconds, for video/audio
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
