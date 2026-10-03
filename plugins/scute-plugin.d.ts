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
  readonly apiVersion: 1 | 2 | 3 | 4 | 5 | 6;
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
    update(id: string, patch: Omit<NoteInput, "type"> & { boardId?: string | null }): Promise<void>;
    /** notes:write */
    delete(id: string): Promise<void>;
    open(id: string): void;
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
