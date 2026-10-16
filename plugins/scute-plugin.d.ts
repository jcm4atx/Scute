// Type definitions for Scute plug-ins (API version 4). See PLUGINS.md.
// Use from JavaScript with:  /** @param {import("../scute-plugin").Scute} scute */

export type NoteType = "text" | "link" | "password" | "image" | "video" | "file" | (string & {});

export interface PlainNote {
  id: string;
  spaceId: string;
  boardId: string | null;
  type: NoteType;
  title: string;
  text: string;
  url?: string;
  tags: string[];
  color: string | null;
  pinned: boolean;
  /** width/height for images and videos, duration (seconds) for video/audio, when known (API 5) */
  file: { name: string; type: string; size: number; width?: number; height?: number; duration?: number } | null;
  created: number;
  modified: number;
  /** This plug-in's private data on the note. */
  data?: unknown;
  /** API 11, "passwords" permission: the user name and password of password notes. */
  username?: string;
  password?: string;
}

export interface BitwardenAccount {
  id: string;
  email: string;
  name: string;
  created: number;
  revision: number;
  kdf: { type: number; iterations: number; memory: number | null; parallelism: number | null };
  /** The user key, encrypted with the master key (EncString) */
  key: string;
  apiKey: boolean;
}

export interface Ctx {
  spaceId: string | null;
  boardId: string | null;
  noteId: string | null;
}

export interface SpaceInfo {
  id: string;
  title: string;
  color?: string;
  kind: string;
  role: string;
  writable: boolean;
}
export interface BoardInfo {
  id: string;
  spaceId: string;
  title: string;
  parentId: string | null;
}

export interface Command {
  id: string;
  title: string;
  /** Inline <svg> markup. */
  icon?: string;
  /** e.g. "mod+shift+d" (mod = Ctrl, or Cmd on macOS). */
  key?: string;
  run(ctx: Ctx): unknown;
}
export interface NoteAction {
  id: string;
  title: string;
  icon?: string;
  when?(note: PlainNote): boolean;
  run(note: PlainNote, ctx: Ctx): unknown;
}
export interface View {
  id: string;
  title: string;
  icon?: string;
  mount(el: HTMLElement, ctx: Ctx): void | (() => void);
}
export interface Template {
  id: string;
  title: string;
  create(ctx: Ctx): NoteInput | Promise<NoteInput>;
}

export interface NoteInput {
  /** A new UUID from util.uuid(); lets notes refer to each other before they're saved. */
  id?: string;
  /** "text", "link" or a note type this plug-in registered. */
  type?: "text" | "link" | (string & {});
  created?: number;
  title?: string;
  text?: string;
  url?: string;
  tags?: string[];
  color?: string | null;
  pinned?: boolean;
  data?: unknown;
}

export interface MenuItem {
  id: string;
  title: string;
  icon?: string;
  run(ctx: Ctx): unknown;
}
export interface SpaceTab {
  id: string;
  title: string;
  icon?: string;
  mount(el: HTMLElement, ctx: Ctx): void | (() => void);
}
/** API 2 */
export interface SpaceKind {
  id: string;
  title: string;
  layout?: "tabs" | "full";
  tabs?: SpaceTab[];
  mount?(el: HTMLElement, ctx: Ctx): void | (() => void);
  newItems?: MenuItem[];
  menuItems?: MenuItem[];
}
export interface CardLine {
  dot?: string;
  parts: string[];
}
/** API 2 */
export interface NoteTypeDef {
  id: string;
  title: string;
  icon?: string;
  /** Note field holding the structured data (default: id). */
  field?: string;
  open?(note: PlainNote, ctx: Ctx): unknown;
  cardLine?(note: PlainNote): CardLine | null | undefined;
  /** API 4: SVG markup or a data:image URL drawn across the top of the card. */
  cardCover?(note: PlainNote): string | null | undefined;
}
/** API 2 */
export interface GlobalMenuItem extends MenuItem {
  location: "spaces";
  when?(ctx: Ctx): boolean;
}

export interface Events {
  "note:open": PlainNote;
  "notes:change": { changed: string[]; removed: string[] };
  "space:change": { id: string; title: string };
  /** API 3 */
  "services:change": { name: string; available: boolean };
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Off = () => void;

export interface Scute {
  readonly version: string;
  readonly apiVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  readonly plugin: { id: string; name: string; version: string; permissions: string[] };

  context(): Ctx;

  commands: { register(c: Command): Off };
  noteActions: { register(a: NoteAction): Off };
  views: { register(v: View): Off; open(id: string): void };
  templates: { register(t: Template): Off };
  cards: { addBadge(fn: (note: PlainNote) => string | null | undefined | false): Off };
  markdown: {
    addTransform(fn: (src: string) => string): Off;
    addPostProcessor(fn: (el: HTMLElement, info: { noteId: string | null }) => void): Off;
  };
  events: { on<K extends keyof Events>(name: K, fn: (arg: Events[K]) => void): Off };

  /** API 2 */
  spaceKinds: { register(k: SpaceKind): Off };
  /** API 2 */
  noteTypes: { register(t: NoteTypeDef): Off };
  /** API 2 */
  menus: { register(m: GlobalMenuItem): Off };
  /** API 2 */
  util: { uuid(): string };
  /** API 2 */
  status: { online(): boolean };

  /** notes:read */
  spaces: {
    list(): SpaceInfo[];
    current(): SpaceInfo | null;
    /** notes:write (API 2) */
    create(input: { title: string; color?: string; kind?: string }): Promise<string>;
    /** API 2 */
    open(id: string, opts?: { tab?: string }): void;
  };
  boards: {
    /** notes:read */
    list(spaceId?: string): BoardInfo[];
    /** notes:write */
    create(input: { spaceId?: string; title: string }): Promise<string>;
  };
  notes: {
    /** notes:read */
    list(filter?: { spaceId?: string | "all"; boardId?: string | null; type?: NoteType; tag?: string; search?: string }): PlainNote[];
    /** notes:read */
    get(id: string): PlainNote | null;
    /** notes:write */
    create(input: NoteInput & { spaceId?: string; boardId?: string | null }): Promise<string>;
    /** notes:write (API 2). One request; needs a connection. */
    createMany(spaceId: string, inputs: (NoteInput & { boardId?: string | null })[], onProgress?: (done: number, total: number) => void): Promise<string[]>;
    /** notes:write */
    update(id: string, patch: Omit<NoteInput, "type"> & { boardId?: string | null; /** API 11: move to another space */ spaceId?: string }): Promise<void>;
    /** notes:write */
    delete(id: string): Promise<void>;
    /** notes:write (API 11). Move notes to another space or board, like the Move button. */
    move(ids: string[], to: { spaceId: string; boardId?: string | null }): Promise<{ moved: number; failed: { title: string; error: string }[] }>;
    open(id: string): void;
  };

  /** API 11, bitwarden: the user's account on the Bitwarden-compatible server at <scute>/bw (ciphertext only; the plug-in encrypts). */
  bitwarden: {
    info(): Promise<{ enabled: boolean; url: string; version: string; account: BitwardenAccount | null; devices: { id: string; name: string; type: number; kind: string; created: number; lastSeen: number }[] }>;
    createAccount(body: { email: string; name?: string; masterPasswordHash: string; key: string; publicKey: string; privateKey: string; kdf: { kdfType: 0 | 1; iterations: number; memory?: number | null; parallelism?: number | null } }): Promise<{ account: BitwardenAccount; url: string }>;
    updateAccount(patch: { name?: string }): Promise<{ account: BitwardenAccount }>;
    /** confirm: the account's email address */
    deleteAccount(confirm: string): Promise<void>;
    /** Sign every Bitwarden app out. */
    signOutAll(): Promise<void>;
    removeDevice(id: string): Promise<void>;
    /** Every cipher (as the apps see it, plus revision and mirror) and folder. */
    vault(): Promise<{ accountId: string; revision: number; ciphers: any[]; folders: { id: string; name: string; revision: number; mirror: Json | null }[] }>;
    /** Create or replace a cipher; expect = the revision you last saw (null for a new one), else 409. */
    putCipher(id: string, body: { cipher: object; mirror?: Json | null; expect: number | null; deleted?: boolean }): Promise<any>;
    setCipherMirror(id: string, mirror: Json | null, expect?: number): Promise<{ ok: boolean; revision: number }>;
    trashCipher(id: string, opts?: { expect?: number; mirror?: Json | null }): Promise<any>;
    deleteCipher(id: string): Promise<void>;
    putFolder(id: string, body: { name: string; mirror?: Json | null }): Promise<{ id: string; name: string; revision: number; mirror: Json | null }>;
    setFolderMirror(id: string, mirror: Json | null): Promise<void>;
    deleteFolder(id: string): Promise<void>;
    /** A lease so only one browser works on the vault at a time. */
    lock(holder: string, opts?: { ttl?: number; release?: boolean }): Promise<{ ok: boolean; holder: string | null; until: number | null }>;
    /** A Bitwarden app changed the vault (while this page is open). */
    onChange(cb: () => void): Off;
  };

  /**
   * API 12, library: ebooks, magazines and comics, stored as ordinary (unencrypted) files on
   * the server with their details, and served to e-reader apps as an OPDS catalog at /opds/.
   */
  library: {
    info(): Promise<{ enabled: boolean; username: string; opds: string; books: number; files: number; bytes: number; maxFile: number; formats: string[] }>;
    list(): Promise<LibraryBook[]>;
    get(id: string): Promise<LibraryBook>;
    /** Upload a new book. A file that's already in the library isn't stored twice: { duplicate: { id, format } }. */
    add(file: Blob, opts?: { name?: string; meta?: LibraryMeta; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<{ book: LibraryBook; duplicate?: { id: string; format: string } }>;
    /** Another format of the same book (replaces that format if present). */
    addFile(id: string, file: Blob, opts?: { name?: string; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<{ book: LibraryBook; duplicate?: { id: string; format: string } }>;
    removeFile(id: string, format: string): Promise<LibraryBook>;
    update(id: string, meta: LibraryMeta): Promise<LibraryBook>;
    setCover(id: string, image: Blob | null): Promise<LibraryBook>;
    remove(id: string): Promise<void>;
    /** <img src> for the cover (no sign-in needed, about a week); call list() or info() first. */
    coverUrl(book: { id: string; cover: number }): string | null;
    fileUrl(id: string, format: string, opts?: { view?: boolean }): Promise<string>;
    download(id: string, format: string): Promise<Blob>;
    /** App passwords for e-reader apps (OPDS sign-in: username + app password). */
    tokens: {
      list(): Promise<{ id: string; label: string; created: number; last_used: number | null }[]>;
      create(label: string): Promise<{ id: string; label: string; token: string }>;
      remove(id: string): Promise<void>;
    };
    /** API 13: book search on IRC (IRCHighway #ebooks by default), done by the server. Absent before API 13. */
    irc?: {
      status(): Promise<LibraryIrcStatus>;
      connect(opts?: { nick?: string }): Promise<LibraryIrcStatus>;
      disconnect(): Promise<LibraryIrcStatus>;
      search(q: string, opts?: { nick?: string }): Promise<LibraryIrcJob>;
      /** command: a result's `command` ("!server file name"). */
      download(command: string, opts?: { nick?: string }): Promise<LibraryIrcJob>;
      /** Poll this; search jobs carry `results` once done. */
      job(id: string): Promise<LibraryIrcJob>;
      /** The file of a finished download (may be a .zip or .rar holding the book). */
      file(id: string): Promise<File>;
      remove(id: string): Promise<void>;
    };
  };

  /** API 3: objects plug-ins share with each other. */
  services: {
    provide(name: string, api: object): Off;
    get<T = any>(name: string): T | null;
  };
  /** API 3: requests through the Scute server to URL prefixes allowed by SCUTE_PLUGIN_NET. */
  net: {
    relay(): { enabled: boolean; allow: string[] };
    allowed(url: string): boolean;
    /** network */
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response>;
    /** API 4: is the server's public web fetcher on? */
    web(): Promise<boolean>;
    /** API 4, network: GET a public http(s) URL through the server (no allow list needed; private/LAN addresses are refused). */
    get(url: string, init?: { headers?: Record<string, string>; accept?: string; maxBytes?: number; signal?: AbortSignal }): Promise<Response>;
  };

  /** API 5: note attachments, decrypted in the browser. */
  files: {
    /** notes:read. The note's small inline preview (data: URL) for images and videos, or null. */
    thumb(id: string): string | null;
    /** notes:read. Object URL of the decrypted attachment (downloaded once, cached; don't revoke it). */
    url(id: string, opts?: { onProgress?: (frac: number) => void }): Promise<string>;
    /** notes:read. The decrypted attachment. */
    blob(id: string): Promise<Blob>;
    /** notes:write. Upload a file as a new image/video/file note (thumbnail and size worked out like a drop). Needs a connection. → id */
    add(file: File, input?: { id?: string; spaceId?: string; boardId?: string | null; title?: string; text?: string; tags?: string[]; color?: string | null; created?: number; data?: Json }): Promise<string>;
  };

  /** API 6, publish: encrypted read-only pages at /shared/<name>/ for people without an account. */
  shares: {
    /** Is publishing on, the size limits, and the public base URL (ends in /shared/). */
    info(): Promise<{ enabled: boolean; maxMb: number; maxFileMb: number; base: string }>;
    /** Your shares from this plug-in. */
    list(): Promise<ShareInfo[]>;
    /** Is a name valid and free (or already yours)? */
    check(name: string): Promise<{ slug: string; valid: boolean; available: boolean; mine: boolean; share: ShareInfo | null }>;
    /** The HTML of the plug-in's shareViewer page, e.g. to export a copy for another web server. */
    viewer(): Promise<string>;
    /** Publish or replace a share. File names: "share.json" or [dir/]name.bin|.json. Unchanged files from the previous version aren't uploaded again. */
    publish(name: string, opts: { files: string[]; produce: (file: string) => Promise<Blob | Uint8Array | string>; expires?: number | null; onProgress?: (done: number, total: number) => void; signal?: AbortSignal }): Promise<ShareInfo>;
    setExpiry(name: string, expires: number | null): Promise<ShareInfo>;
    /** Stop sharing: the page returns 404 and the files are deleted. */
    remove(name: string): Promise<void>;
  };

  /** storage (64 KB per plug-in, per user) */
  storage: {
    get(key: string): Json | undefined;
    all(): Record<string, Json>;
    set(key: string, value: Json | undefined): Promise<void>;
    remove(key: string): Promise<void>;
  };

  ui: {
    toast(t: string | { title: string; description?: string; error?: boolean }): void;
    alert(message: string, title?: string): Promise<void>;
    confirm(message: string, opts?: { title?: string; okLabel?: string }): Promise<boolean>;
    prompt(message: string, value?: string, opts?: { title?: string; okLabel?: string }): Promise<string | null>;
    el(tag: string, attrs?: Record<string, unknown> | null, ...children: unknown[]): HTMLElement;
  };
}

/** Your main.js exports this. Return a cleanup function if you need one. */
export type Activate = (scute: Scute) => void | (() => void) | Promise<void | (() => void)>;

export interface ShareInfo {
  slug: string;
  plugin: string;
  published: boolean;
  bytes: number;
  files: number;
  created: number;
  updated: number;
  /** ms since epoch, or null for never */
  expires: number | null;
  /** "/shared/<slug>/" */
  path: string;
}

export interface LibraryFile {
  format: string;
  name: string;
  size: number;
  sha1: string;
  added: number;
}
export interface LibraryBook {
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
  files: LibraryFile[];
  /** 0 = no cover, otherwise when it last changed */
  cover: number;
  added: number;
  modified: number;
}
export type LibraryMeta = Partial<Omit<LibraryBook, "id" | "files" | "cover" | "added" | "modified">>;

export interface LibraryIrcResult {
  bot: string;
  command: string;
  file: string;
  title: string;
  author: string;
  series: string | null;
  format: string;
  archive: string | null;
  size: number | null;
  sizeText: string;
}
export interface LibraryIrcJob {
  id: string;
  kind: "search" | "download";
  query?: string;
  command?: string;
  bot?: string;
  label: string;
  /** downloads: the title and author from the search result */
  title?: string;
  author?: string;
  status: "queued" | "sent" | "receiving" | "done" | "error";
  message: string;
  received: number;
  size: number;
  name: string;
  created: number;
  finished: number | null;
  count: number | null;
  matches: number | null;
  ready: boolean;
  results?: LibraryIrcResult[];
}
export interface LibraryIrcStatus {
  enabled: boolean;
  allowed: boolean;
  server: string;
  port: number;
  channel: string;
  state: "connecting" | "ready" | "closed";
  nick: string | null;
  error: string | null;
  people: number;
  online: string[];
  jobs: LibraryIrcJob[];
}
