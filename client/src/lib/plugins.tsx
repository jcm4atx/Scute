/**
 * Plug-in host. Loads the plug-ins the server admin enabled (minus any the user
 * turned off), gives each one a `scute` API object and keeps a registry of what
 * they added: commands, note actions, views, templates, card badges and
 * Markdown hooks. The UI reads the registry through usePlugins().
 *
 * Plug-ins run in the page with the same privileges as Scute itself; the
 * permissions in plugin.json are enforced on this API only and are meant as an
 * honest declaration, not a sandbox. Only the server admin can install them.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import DOMPurify from "dompurify";
import { APP_VERSION } from "@shared/version";
import type { NoteData, NoteType } from "@shared/schema";
import { api, getToken, NetworkError } from "./api";
import { API_BASE } from "./queryClient";
import { webEnabled } from "./web";
import { describeFile } from "./media";
import { useVault, canWrite, type Note, type Vault } from "./vault";
import { setMarkdownTransforms } from "./markdown";
import { toast } from "@/hooks/use-toast";

// ------------------------------------------------------------------ types
export interface ShareInfo {
  slug: string;
  plugin: string;
  published: boolean;
  bytes: number;
  files: number;
  created: number;
  updated: number;
  expires: number | null;
  path: string;
}
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  main: string;
  styles?: string;
  shareViewer?: string;
  permissions: string[];
  source: "bundled" | "installed";
  enabled: boolean;
  hash: string;
  error?: string;
}
export interface PluginStatus {
  state: "loading" | "active" | "error" | "off";
  error?: string;
}

/** A note as plug-ins see it (no password, no encrypted thumbnail). */
export interface PlainNote {
  id: string;
  spaceId: string;
  boardId: string | null;
  type: NoteType;
  title: string;
  text: string;
  url?: string;
  tags: string[];
  color?: string | null;
  pinned?: boolean;
  file?: { name: string; type: string; size: number; width?: number; height?: number; duration?: number; stored?: boolean } | null;
  created: number;
  modified: number;
  data?: unknown; // this plug-in's own ext data
}
export interface Ctx {
  spaceId: string | null;
  boardId: string | null;
  noteId: string | null;
}

type Owned<T> = T & { pluginId: string; uid: string };
export interface Command {
  id: string;
  title: string;
  icon?: string;
  key?: string;
  run: (ctx: Ctx) => unknown;
}
export interface NoteAction {
  id: string;
  title: string;
  icon?: string;
  when?: (note: PlainNote) => boolean;
  run: (note: PlainNote, ctx: Ctx) => unknown;
}
export interface View {
  id: string;
  title: string;
  icon?: string;
  mount: (el: HTMLElement, ctx: Ctx) => void | (() => void);
}
export interface Template {
  id: string;
  title: string;
  create: (ctx: Ctx) => Partial<PlainNote> | Promise<Partial<PlainNote>>;
}
/** A tab inside a plug-in space kind; without mount() it shows the normal note grid. */
export interface SpaceTab {
  id: string;
  title: string;
  icon?: string;
  mount?: (el: HTMLElement, ctx: Ctx) => void | (() => void);
}
export interface MenuItem {
  id: string;
  title: string;
  icon?: string;
  run: (ctx: Ctx) => unknown;
}
/** A special kind of space (chosen when the space is created). */
export interface SpaceKindDef {
  id: string;
  title: string;
  /** "tabs": a tab strip above the note grid; "full": the plug-in draws the whole main area. */
  layout?: "tabs" | "full";
  tabs?: SpaceTab[];
  mount?: (el: HTMLElement, ctx: Ctx) => void | (() => void);
  /** Extra entries at the top of the New menu in spaces of this kind. */
  newItems?: MenuItem[];
  /** Extra entries in the space menu while a space of this kind is open. */
  menuItems?: MenuItem[];
}
export interface CardLine {
  dot?: string;
  parts: string[];
}
/** A note type owned by a plug-in; its structured data lives in note field `field`. */
export interface NoteTypeDef {
  id: string;
  title: string;
  icon?: string;
  field?: string;
  open?: (note: PlainNote, ctx: Ctx) => unknown;
  cardLine?: (note: PlainNote) => CardLine | null | undefined;
  /** API 4: a picture at the top of the card: SVG markup (sanitised) or a data:image/… URL. */
  cardCover?: (note: PlainNote) => string | null | undefined;
}
export interface GlobalMenuItem extends MenuItem {
  location: "spaces";
  when?: (ctx: Ctx) => boolean;
}
type Badge = (note: PlainNote) => string | null | undefined | false;
type Post = (el: HTMLElement, info: { noteId: string | null }) => void;
type Transform = (src: string) => string;

interface Registry {
  commands: Owned<Command>[];
  noteActions: Owned<NoteAction>[];
  views: Owned<View>[];
  templates: Owned<Template>[];
  badges: Owned<{ fn: Badge }>[];
  posts: Owned<{ fn: Post }>[];
  transforms: Owned<{ fn: Transform }>[];
  spaceKinds: Owned<SpaceKindDef>[];
  noteTypes: Owned<NoteTypeDef>[];
  menus: Owned<GlobalMenuItem>[];
}
const emptyReg = (): Registry => ({ commands: [], noteActions: [], views: [], templates: [], badges: [], posts: [], transforms: [], spaceKinds: [], noteTypes: [], menus: [] });
/** Space kinds and note types Scute itself owns; plug-ins can't take these ids. */
const CORE_KINDS = ["notes", "joplin"];
const CORE_TYPES = ["text", "link", "password", "image", "video", "file"];
const CORE_FIELDS = ["type", "title", "text", "url", "username", "password", "tags", "color", "pinned", "file", "thumb", "joplin", "ext", "created", "modified"];
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The plug-in note type a note belongs to (if its plug-in is loaded). */
export function noteTypeOf(type: string) {
  return state.reg.noteTypes.find((t) => t.id === type) || null;
}
export function spaceKindOf(kind: string | undefined) {
  return kind ? state.reg.spaceKinds.find((k) => k.id === kind) || null : null;
}

// ------------------------------------------------------------------ store
interface HostState {
  available: boolean;
  list: PluginInfo[];
  status: Record<string, PluginStatus>;
  reg: Registry;
  rev: number; // bumps when anything that affects rendering changes
  dialog: DialogReq | null;
  tick: number; // bump to reload every plug-in
}
interface DialogReq {
  kind: "confirm" | "prompt" | "alert";
  title: string;
  message?: string;
  value?: string;
  okLabel?: string;
  resolve: (v: unknown) => void;
}
interface Bridge {
  openNote: (id: string) => void;
  openView: (pluginId: string, viewId: string) => void;
  openSpace: (spaceId: string, tab?: string) => void;
  ctx: () => Ctx;
}

let state: HostState = { available: false, list: [], status: {}, reg: emptyReg(), rev: 0, dialog: null, tick: 0 };
/** URL prefixes the server relays for scute.net.fetch (["*"] = any; [] = relay off). */
let netAllow: string[] = [];
/** Cross-plug-in services (API 3): name → { pluginId, api }. */
const services = new Map<string, { pluginId: string; api: unknown }>();
/** Unload and load all plug-ins again (after enabling, installing or removing one). */
export function reloadPlugins() {
  set({ tick: state.tick + 1 });
}
const subs = new Set<() => void>();
function set(patch: Partial<HostState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
function bumpReg(mut: (r: Registry) => void) {
  const r = { ...state.reg };
  (Object.keys(r) as (keyof Registry)[]).forEach((k) => ((r as any)[k] = [...r[k]]));
  mut(r);
  setMarkdownTransforms(
    r.transforms.map((t) => (src: string) => {
      try {
        const out = t.fn(src);
        return typeof out === "string" ? out : src;
      } catch (e) {
        reportError(t.pluginId, "Markdown transform", e);
        return src;
      }
    }),
  );
  set({ reg: r, rev: state.rev + 1 });
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export function usePlugins() {
  return useSyncExternalStore(subscribe, () => state);
}

/** Spaces plug-ins created this session (id → plug-in id), until the vault list has them. */
const created = new Map<string, string>();
let bridge: Bridge = { openNote: () => {}, openView: () => {}, openSpace: () => {}, ctx: () => ({ spaceId: null, boardId: null, noteId: null }) };
/** Home registers how to open notes/views and what's currently on screen. */
export function setPluginBridge(b: Bridge) {
  bridge = b;
}

// ------------------------------------------------------------------ events
type EvName = "note:open" | "notes:change" | "space:change" | "services:change";
const listeners = new Map<EvName, Set<Owned<{ fn: (arg: any) => void }>>>();
export function emitPluginEvent(name: EvName, arg: unknown) {
  listeners.get(name)?.forEach((l) => guard(l.pluginId, `"${name}" handler`, l.fn, undefined)(arg));
}

// ------------------------------------------------------------------ helpers
const lastReport = new Map<string, number>();
function reportError(pluginId: string, what: string, e: unknown) {
  const msg = (e as Error)?.message || String(e);
  console.error(`[plug-in ${pluginId}] ${what}:`, e);
  const k = `${pluginId}|${what}|${msg}`;
  if (Date.now() - (lastReport.get(k) || 0) < 10_000) return; // don't flood the screen
  lastReport.set(k, Date.now());
  const name = state.list.find((p) => p.id === pluginId)?.name || pluginId;
  toast({ title: `${name}: ${what} failed`, description: msg.slice(0, 300), variant: "destructive" });
}
/** Wrap plug-in callbacks so one broken plug-in can't break Scute. */
function guard<A extends unknown[], R>(pluginId: string, what: string, fn: (...a: A) => R, fallback: R): (...a: A) => R {
  return (...a: A) => {
    try {
      const out = fn(...a);
      if (out && typeof (out as any).then === "function") (out as any).catch?.((e: unknown) => reportError(pluginId, what, e));
      return out;
    } catch (e) {
      reportError(pluginId, what, e);
      return fallback;
    }
  };
}
export const runGuarded = (pluginId: string, what: string, fn: () => unknown) => guard(pluginId, what, fn, undefined)();

// ---------------------------------------------------------------- Scute Drive (API 8)
const davPath = (rel: string) => `${API_BASE}/dav/${rel.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
async function davFetch(method: string, rel: string, init: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = { ...(init.headers || {}) };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  let r: Response;
  try {
    r = await fetch(davPath(rel), { method, headers, body: init.body, signal: init.signal, cache: "no-store" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error(unreachable(new NetworkError((e as Error).message)));
  }
  if (!r.ok && r.status !== 207) {
    const msg = (await r.text().catch(() => "")) || r.statusText;
    if (r.status >= 502 && r.status <= 504) throw new Error(unreachable(new NetworkError(`${r.status}`)));
    const e = new Error(msg.slice(0, 300)) as Error & { status: number };
    e.status = r.status;
    throw e;
  }
  return r;
}
export interface DriveItem {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  type: string;
}
function driveApi(need: () => void) {
  const q = (rel: string) => encodeURIComponent(rel);
  return {
    async info() {
      need();
      const r = await api<{ enabled: boolean; username: string; dav: string; used: number; quota: number | null; maxFile: number; trashDays: number; folder: string }>("GET", "/api/drive");
      return { ...r, url: new URL(`${API_BASE}/dav/`, location.href).href };
    },
    async usage() {
      need();
      return (await api<{ used: number }>("GET", "/api/drive?fresh=1")).used;
    },
    async list(rel = ""): Promise<DriveItem[]> {
      need();
      return (await api<{ items: DriveItem[] }>("GET", `/api/drive/list?path=${q(rel)}`)).items;
    },
    async tree(rel = ""): Promise<{ path: string; size: number; mtime: number }[]> {
      need();
      return (await api<{ files: { path: string; size: number; mtime: number }[] }>("GET", `/api/drive/tree?path=${q(rel)}`)).files;
    },
    /** A link to one file that works without signing in, for about 6 hours (streams video, big downloads). Add "?dl=1" to download. */
    async link(rel: string) {
      need();
      const r = await api<{ url: string }>("POST", "/api/drive/link", { path: rel });
      return new URL(`${API_BASE}${r.url}`, location.href).href;
    },
    async mkdir(rel: string) {
      need();
      await davFetch("MKCOL", rel);
    },
    async remove(rel: string) {
      need();
      await davFetch("DELETE", rel);
    },
    async move(from: string, to: string, opts: { overwrite?: boolean; copy?: boolean } = {}) {
      need();
      await davFetch(opts.copy ? "COPY" : "MOVE", from, { headers: { Destination: new URL(davPath(to), location.href).href, Overwrite: opts.overwrite ? "T" : "F" } });
    },
    async download(rel: string, opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<Blob> {
      need();
      const r = await davFetch("GET", rel, { signal: opts.signal });
      const total = Number(r.headers.get("content-length") || 0);
      if (!r.body || !opts.onProgress) return r.blob();
      const reader = r.body.getReader();
      const parts: BlobPart[] = [];
      let done = 0;
      for (;;) {
        const x = await reader.read();
        if (x.done) break;
        parts.push(x.value as BlobPart);
        done += x.value.length;
        opts.onProgress(done, total);
      }
      return new Blob(parts, { type: r.headers.get("content-type") || "application/octet-stream" });
    },
    /** Upload (or replace) a file; keeps the file's modification time. */
    upload(rel: string, file: Blob, opts: { mtime?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<void> {
      need();
      return new Promise((ok, bad) => {
        const x = new XMLHttpRequest();
        x.open("PUT", davPath(rel));
        const t = getToken();
        if (t) x.setRequestHeader("Authorization", `Bearer ${t}`);
        x.setRequestHeader("Content-Type", "application/octet-stream");
        const mt = opts.mtime ?? (file instanceof File ? file.lastModified : 0);
        if (mt) x.setRequestHeader("X-OC-Mtime", String(Math.floor(mt / 1000)));
        x.upload.onprogress = (e) => opts.onProgress?.(e.loaded, e.total || file.size);
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) return ok();
          const e = new Error(x.status >= 502 && x.status <= 504 ? unreachable(new NetworkError(String(x.status))) : (x.responseText || x.statusText || `Error ${x.status}`).slice(0, 300)) as Error & { status: number };
          e.status = x.status;
          bad(e);
        };
        x.onerror = () => bad(new Error(unreachable(new NetworkError("upload failed"))));
        x.onabort = () => bad(new DOMException("Cancelled", "AbortError"));
        opts.signal?.addEventListener("abort", () => x.abort());
        x.send(file);
      });
    },
    tokens: {
      async list() {
        need();
        return (await api<{ tokens: { id: string; label: string; created: number; last_used: number | null }[] }>("GET", "/api/drive/tokens")).tokens;
      },
      async create(label: string) {
        need();
        return api<{ id: string; label: string; token: string }>("POST", "/api/drive/tokens", { label });
      },
      async remove(id: string) {
        need();
        await api("DELETE", `/api/drive/tokens/${encodeURIComponent(id)}`);
      },
    },
    trash: {
      async list() {
        need();
        return api<{ days: number; items: { id: string; path: string; dir: boolean; size: number; deleted: number; reason: string }[] }>("GET", "/api/drive/trash");
      },
      async restore(id: string, opts: { to?: string; replace?: boolean } = {}) {
        need();
        return api<{ path: string }>("POST", `/api/drive/trash/${encodeURIComponent(id)}/restore`, opts);
      },
      async remove(id: string) {
        need();
        await api("DELETE", `/api/drive/trash/${encodeURIComponent(id)}`);
      },
      async empty() {
        need();
        await api("DELETE", "/api/drive/trash");
      },
    },
  };
}

/** The file of an image/video/file note that never finished uploading (the note was saved, the upload wasn't). */
function missingFile(n: Note): string {
  const name = n.data.file?.name || n.data.title || "A note";
  return `${name}: its file never finished uploading to Scute. Open the note and attach the file again, or delete the note.`;
}

export function toPlain(n: Note, pluginId?: string): PlainNote {
  const d = n.data;
  return {
    id: n.id,
    spaceId: n.spaceId,
    boardId: n.boardId,
    type: d.type,
    title: d.title,
    text: d.text,
    url: d.url,
    tags: [...(d.tags || [])],
    color: d.color ?? null,
    pinned: !!d.pinned,
    file: d.file ? { name: d.file.name, type: d.file.type, size: d.file.size, ...(d.file.width ? { width: d.file.width, height: d.file.height } : {}), ...(d.file.duration ? { duration: d.file.duration } : {}), stored: !!n.fileSize } : null,
    created: d.created,
    modified: d.modified,
    data: pluginId ? structuredCloneSafe(ownedField(d.type, pluginId) ? (d as any)[ownedField(d.type, pluginId)!] : d.ext?.[pluginId]) : undefined,
  };
}
/** The note field a plug-in's own note type keeps its data in. */
function ownedField(type: string, pluginId: string) {
  const t = state.reg.noteTypes.find((x) => x.id === type && x.pluginId === pluginId);
  return t ? t.field || t.id : null;
}
function structuredCloneSafe<T>(v: T): T {
  if (v === undefined) return v;
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

/** Sanitised inline SVG for plug-in icons (or null). */
export function pluginIconHtml(icon?: string): string | null {
  if (!icon || !/^\s*<svg[\s>]/i.test(icon)) return null;
  return DOMPurify.sanitize(icon, { USE_PROFILES: { svg: true, svgFilters: false } });
}

function parseKey(k: string) {
  const parts = k.toLowerCase().split("+").map((s) => s.trim());
  return { mod: parts.includes("mod") || parts.includes("ctrl") || parts.includes("cmd"), shift: parts.includes("shift"), alt: parts.includes("alt"), key: parts[parts.length - 1] };
}
export function keyLabel(k?: string) {
  if (!k) return "";
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return k
    .split("+")
    .map((p) => (/^(mod|ctrl|cmd)$/i.test(p) ? (mac ? "⌘" : "Ctrl") : /^shift$/i.test(p) ? (mac ? "⇧" : "Shift") : /^alt$/i.test(p) ? (mac ? "⌥" : "Alt") : p.toUpperCase()))
    .join(mac ? "" : "+");
}

function el(tag: string, attrs?: Record<string, unknown> | null, ...children: unknown[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k === "class" || k === "className") e.className = String(v);
    else if (k === "html") continue; // no raw HTML through el(); use textContent-safe children
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  const add = (c: unknown) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else e.append(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
  return e;
}

function ask(req: Omit<DialogReq, "resolve">): Promise<unknown> {
  return new Promise((resolve) => set({ dialog: { ...req, resolve } }));
}
export function closePluginDialog(value: unknown) {
  const d = state.dialog;
  set({ dialog: null });
  d?.resolve(value);
}

// ------------------------------------------------------------------ the API
const NOTE_FIELDS = ["title", "text", "url", "tags", "color", "pinned"] as const;

/** A friendlier message for a request that never got a proper answer from the server. */
function unreachable(e: Error) {
  const m = e.message || "";
  if (/^50[234]\b/.test(m))
    return `The web server in front of Scute answered ${m} instead of Scute. Scute may be restarting, or a large file hit the proxy's timeout or size limit; try again, and see the README (Published shares) if it keeps happening.`;
  return `Couldn't reach the Scute server (${m || "network error"}). Check the connection and try again.`;
}

function makeApi(p: PluginInfo, vRef: { current: Vault }, disposers: (() => void)[], storageQueue: { p: Promise<unknown> }) {
  const need = (perm: string) => {
    if (!p.permissions.includes(perm)) throw new Error(`"${p.id}" needs the "${perm}" permission in its plugin.json`);
  };
  async function publishShare(
    name: string,
    opts: { files: string[]; produce: (file: string) => Promise<Blob | Uint8Array | string>; expires?: number | null; onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
  ) {
    const slug = encodeURIComponent(name);
    const begin = await api<{ version: string; have: string[] }>("POST", `/api/shares/${slug}/begin`, { plugin: p.id });
    const have = new Set(begin.have);
    const todo = opts.files.filter((f) => f === "share.json" || !have.has(f));
    const prog = opts.onProgress ? guard(p.id, "publish progress", opts.onProgress, undefined) : undefined;
    let done = 0;
    prog?.(0, todo.length);
    for (const f of todo) {
      if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const data = await opts.produce(f);
      const body = typeof data === "string" ? new Blob([data]) : data instanceof Blob ? data : new Blob([data as BlobPart]);
      await api("PUT", `/api/shares/${slug}/${begin.version}/${f.split("/").map(encodeURIComponent).join("/")}`, undefined, body);
      prog?.(++done, todo.length);
    }
    const body: Record<string, unknown> = { files: opts.files };
    if (opts.expires !== undefined) body.expires = opts.expires;
    return api<ShareInfo>("POST", `/api/shares/${slug}/${begin.version}/commit`, body);
  }
  const own = <T extends object>(kind: keyof Registry, item: T, id: string) => {
    const uid = `${p.id}:${id}`;
    const entry = { ...item, pluginId: p.id, uid } as any;
    bumpReg((r) => {
      (r[kind] as any[]) = (r[kind] as any[]).filter((x) => x.uid !== uid);
      (r[kind] as any[]).push(entry);
    });
    const off = () => bumpReg((r) => ((r[kind] as any[]) = (r[kind] as any[]).filter((x) => x !== entry)));
    disposers.push(off);
    return off;
  };
  const reqStr = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
    return v;
  };
  let anon = 0;
  const recent = new Map<string, PlainNote>(); // writes not yet visible in vault state

  const findNote = (id: string) => vRef.current.notes.find((n) => n.id === id);
  const writableSpace = (spaceId: string) => {
    const s = vRef.current.spaces.find((x) => x.id === spaceId);
    if (!s) {
      // Created a moment ago by this plug-in; the vault list catches up on the next render.
      if (created.get(spaceId) === p.id) return;
      throw new Error("Unknown space");
    }
    if (!canWrite(s.role)) throw new Error("You can't edit that space");
    if (s.data.kind && s.data.kind !== "notes" && !state.reg.spaceKinds.some((k) => k.id === s.data.kind && k.pluginId === p.id))
      throw new Error("Plug-ins can only change notes in ordinary spaces or spaces of their own kind");
    return s;
  };
  const cleanPatch = (patch: Partial<PlainNote>) => {
    const out: Partial<NoteData> = {};
    for (const k of NOTE_FIELDS) if (k in patch) (out as any)[k] = (patch as any)[k];
    if (out.title != null) out.title = String(out.title).slice(0, 500);
    if (out.text != null) out.text = String(out.text);
    if (out.tags) out.tags = [...new Set((out.tags as unknown[]).map((t) => String(t).trim().replace(/^#/, "")).filter(Boolean))].slice(0, 50);
    return out;
  };

  /** Validate a new note from a plug-in and turn it into note data. */
  const buildNew = (sid: string, input: Partial<PlainNote> & { boardId?: string | null }) => {
    const owned = typeof input.type === "string" ? ownedField(input.type, p.id) : null;
    const type: NoteType = owned ? input.type! : input.type === "link" ? "link" : "text";
    const now = Date.now();
    const created = typeof input.created === "number" && input.created > 0 && input.created <= now + 86_400_000 ? input.created : now;
    // imports may keep the original "last edited" time (Scute 1.17.0)
    const modified = typeof input.modified === "number" && input.modified >= created && input.modified <= now + 86_400_000 ? input.modified : now;
    const data: NoteData = { type, title: "", text: "", tags: [], created, modified, ...cleanPatch(input) } as NoteData;
    if (input.data !== undefined) {
      if (owned) (data as any)[owned] = structuredCloneSafe(input.data);
      else data.ext = { [p.id]: structuredCloneSafe(input.data) };
    }
    let id: string | undefined;
    if (input.id !== undefined) {
      if (typeof input.id !== "string" || !UUID_RE.test(input.id)) throw new Error("A new note id must be a UUID (use scute.util.uuid())");
      if (findNote(input.id) || recent.has(input.id)) throw new Error("A note with that id already exists");
      id = input.id.toLowerCase();
    }
    const b = input.boardId === undefined ? bridge.ctx().boardId : input.boardId;
    const boardId = b && vRef.current.boards.some((x) => x.id === b && x.spaceId === sid) ? b : null;
    return { id, data, boardId };
  };
  const reqId = (v: unknown, what: string) => {
    if (typeof v !== "string" || !ID_RE.test(v)) throw new Error(`${what} must be lower-case letters, digits and dashes`);
    return v;
  };
  const menuItem = (m: MenuItem, what: string): MenuItem => {
    reqId(m?.id, `${what} id`);
    reqStr(m?.title, `${what} title`);
    if (typeof m.run !== "function") throw new Error(`${what}.run must be a function`);
    return { id: m.id, title: m.title, icon: m.icon, run: guard(p.id, `${what} "${m.title}"`, m.run, undefined) };
  };

  const scute = {
    version: APP_VERSION,
    apiVersion: 8,
    plugin: { id: p.id, name: p.name, version: p.version, permissions: [...p.permissions] },

    commands: {
      register(c: Command) {
        reqStr(c?.id, "command id");
        reqStr(c?.title, "command title");
        return own("commands", { ...c, run: guard(p.id, `command "${c.title}"`, c.run, undefined) }, c.id);
      },
    },
    noteActions: {
      register(a: NoteAction) {
        reqStr(a?.id, "note action id");
        reqStr(a?.title, "note action title");
        return own("noteActions", { ...a, when: a.when ? guard(p.id, `note action "${a.title}" check`, a.when, false) : undefined, run: guard(p.id, `note action "${a.title}"`, a.run, undefined) }, a.id);
      },
    },
    views: {
      register(view: View) {
        reqStr(view?.id, "view id");
        reqStr(view?.title, "view title");
        if (typeof view.mount !== "function") throw new Error("view.mount must be a function");
        return own("views", view, view.id);
      },
      open(id: string) {
        bridge.openView(p.id, id);
      },
    },
    spaceKinds: {
      register(k: SpaceKindDef) {
        reqId(k?.id, "space kind id");
        reqStr(k?.title, "space kind title");
        if (CORE_KINDS.includes(k.id)) throw new Error(`"${k.id}" is a built-in space kind`);
        const other = state.reg.spaceKinds.find((x) => x.id === k.id && x.pluginId !== p.id);
        if (other) throw new Error(`Space kind "${k.id}" is already provided by ${other.pluginId}`);
        const layout = k.layout === "full" ? "full" : "tabs";
        if (layout === "full" && typeof k.mount !== "function") throw new Error("A full-page space kind needs mount()");
        const tabs = (k.tabs || []).map((t) => {
          reqId(t?.id, "tab id");
          reqStr(t?.title, "tab title");
          return { id: t.id, title: t.title, icon: t.icon, mount: typeof t.mount === "function" ? t.mount : undefined };
        });
        return own("spaceKinds", { id: k.id, title: k.title, layout, tabs, mount: k.mount, newItems: (k.newItems || []).map((m) => menuItem(m, "new item")), menuItems: (k.menuItems || []).map((m) => menuItem(m, "menu item")) }, k.id);
      },
    },
    noteTypes: {
      register(t: NoteTypeDef) {
        reqId(t?.id, "note type id");
        reqStr(t?.title, "note type title");
        if (CORE_TYPES.includes(t.id)) throw new Error(`"${t.id}" is a built-in note type`);
        const field = t.field === undefined ? t.id : t.field;
        if (typeof field !== "string" || !/^[a-z][a-zA-Z0-9]{0,39}$/.test(field) || CORE_FIELDS.includes(field)) throw new Error(`"${field}" can't be used as a note field`);
        const other = state.reg.noteTypes.find((x) => (x.id === t.id || (x.field || x.id) === field) && x.pluginId !== p.id);
        if (other) throw new Error(`Note type "${t.id}" is already provided by ${other.pluginId}`);
        return own(
          "noteTypes",
          { id: t.id, title: t.title, icon: t.icon, field, open: t.open ? guard(p.id, `open ${t.title}`, t.open, undefined) : undefined, cardLine: t.cardLine ? guard(p.id, `${t.title} card`, t.cardLine, null) : undefined, cardCover: t.cardCover ? guard(p.id, `${t.title} cover`, t.cardCover, null) : undefined },
          t.id,
        );
      },
    },
    menus: {
      register(m: GlobalMenuItem) {
        if (m?.location !== "spaces") throw new Error('menu location must be "spaces"');
        return own("menus", { ...menuItem(m, "menu item"), location: "spaces", when: m.when ? guard(p.id, `menu item "${m.title}" check`, m.when, false) : undefined }, m.id);
      },
    },
    util: {
      uuid: () => crypto.randomUUID(),
    },
    /** API 3: share an object with other plug-ins, and use theirs. */
    services: {
      provide(name: string, api: object) {
        reqId(name, "service name");
        if (!api || typeof api !== "object") throw new Error("A service must be an object");
        const other = services.get(name);
        if (other && other.pluginId !== p.id) throw new Error(`Service "${name}" is already provided by ${other.pluginId}`);
        const entry = { pluginId: p.id, api: Object.freeze({ ...api }) };
        services.set(name, entry);
        queueMicrotask(() => emitPluginEvent("services:change", { name, available: true }));
        const off = () => {
          if (services.get(name) === entry) {
            services.delete(name);
            emitPluginEvent("services:change", { name, available: false });
          }
        };
        disposers.push(off);
        return off;
      },
      get(name: string) {
        return (services.get(name)?.api as any) ?? null;
      },
    },
    /** API 3 (network): fetch through the Scute server, which relays to allowed URLs. */
    net: {
      relay: () => ({ enabled: netAllow.length > 0, allow: [...netAllow] }),
      /** API 4: is the public web fetcher on (SCUTE_ARCHIVE)? */
      web: () => webEnabled(),
      /** API 4 (network): GET a public http(s) URL through the server's web fetcher (no allow list; private addresses refused). */
      async get(url: string, init: { headers?: Record<string, string>; accept?: string; maxBytes?: number; signal?: AbortSignal } = {}) {
        need("network");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const tok = getToken();
        if (tok) headers.Authorization = `Bearer ${tok}`;
        const r = await fetch(`${API_BASE}/api/web/fetch`, {
          method: "POST",
          headers,
          cache: "no-store",
          signal: init.signal,
          body: JSON.stringify({ url, accept: init.accept || "application/json, */*;q=0.8", maxBytes: init.maxBytes, headers: init.headers || {} }),
        });
        if (!r.ok) {
          let msg = r.statusText;
          try {
            msg = (await r.json()).message || msg;
          } catch {
            /* not json */
          }
          throw new Error(msg);
        }
        const status = Number(r.headers.get("x-upstream-status") || 200);
        const h = { "content-type": r.headers.get("x-upstream-type") || "application/octet-stream", "x-final-url": r.headers.get("x-final-url") || url };
        // Response() refuses bodies for 204/304 and statuses outside 200-599
        if (status === 204 || status === 304 || status < 200 || status > 599) return new Response(null, { status: status >= 200 && status <= 599 ? status : 502, headers: h });
        return new Response(r.body, { status, headers: h });
      },
      allowed(url: string) {
        if (netAllow.includes("*")) return /^https?:\/\//i.test(url);
        return netAllow.some((pre) => url === pre || url.startsWith(pre + "/") || url.startsWith(pre + "?"));
      },
      async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) {
        need("network");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const tok = getToken();
        if (tok) headers.Authorization = `Bearer ${tok}`;
        const r = await fetch(`${API_BASE}/api/plugins-net`, {
          method: "POST",
          headers,
          cache: "no-store",
          signal: init.signal,
          body: JSON.stringify({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body ?? null }),
        });
        if (!r.ok) {
          let msg = r.statusText;
          try {
            msg = (await r.json()).message || msg;
          } catch {
            /* not json */
          }
          throw new Error(msg);
        }
        const status = Number(r.headers.get("x-upstream-status") || 200);
        return new Response(r.body, { status, headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" } });
      },
    },
    status: {
      online: () => !!vRef.current.online,
    },
    templates: {
      register(t: Template) {
        reqStr(t?.id, "template id");
        reqStr(t?.title, "template title");
        return own("templates", t, t.id);
      },
    },
    cards: {
      addBadge(fn: Badge) {
        return own("badges", { fn: guard(p.id, "card badge", fn, null) }, `badge${anon++}`);
      },
    },
    markdown: {
      addTransform(fn: Transform) {
        return own("transforms", { fn }, `transform${anon++}`);
      },
      addPostProcessor(fn: Post) {
        return own("posts", { fn: guard(p.id, "Markdown post-processor", fn, undefined) }, `post${anon++}`);
      },
    },
    events: {
      on(name: EvName, fn: (arg: any) => void) {
        if (!["note:open", "notes:change", "space:change", "services:change"].includes(name)) throw new Error(`Unknown event "${name}"`);
        const entry = { fn, pluginId: p.id, uid: `${p.id}:ev${anon++}` };
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(entry);
        const off = () => listeners.get(name)?.delete(entry);
        disposers.push(off);
        return off;
      },
    },

    context: () => bridge.ctx(),
    spaces: {
      list() {
        need("notes:read");
        return vRef.current.spaces.map((s) => ({ id: s.id, title: s.data.title, color: s.data.color, kind: s.data.kind || "notes", role: s.role, writable: canWrite(s.role) }));
      },
      /** Create a space. Plug-ins may create ordinary spaces or spaces of a kind they provide. */
      async create(input: { title: string; color?: string; kind?: string }) {
        need("notes:write");
        const kind = input?.kind || "notes";
        if (kind !== "notes" && !state.reg.spaceKinds.some((k) => k.id === kind && k.pluginId === p.id)) throw new Error(`"${p.id}" can't create "${kind}" spaces`);
        const color = typeof input.color === "string" && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : "#2f6f5e";
        const id = await vRef.current.createSpace({ title: reqStr(input.title, "space title").slice(0, 200), color, ...(kind !== "notes" ? { kind } : {}) } as any);
        created.set(id, p.id);
        return id;
      },
      open(id: string, opts: { tab?: string } = {}) {
        bridge.openSpace(id, opts?.tab);
      },
      current() {
        need("notes:read");
        const id = bridge.ctx().spaceId;
        return scute.spaces.list().find((s) => s.id === id) || null;
      },
    },
    boards: {
      list(spaceId?: string) {
        need("notes:read");
        const sid = spaceId || bridge.ctx().spaceId;
        return vRef.current.boards.filter((b) => b.spaceId === sid).map((b) => ({ id: b.id, spaceId: b.spaceId, title: b.data.title, parentId: b.data.parentId || null }));
      },
      async create(input: { spaceId?: string; title: string }) {
        need("notes:write");
        const sid = input.spaceId || bridge.ctx().spaceId;
        if (!sid) throw new Error("No space selected");
        writableSpace(sid);
        return vRef.current.saveBoard(sid, { title: reqStr(input.title, "board title").slice(0, 200) });
      },
    },
    notes: {
      list(filter: { spaceId?: string | "all"; boardId?: string | null; type?: NoteType; tag?: string; search?: string } = {}) {
        need("notes:read");
        const sid = filter.spaceId === "all" ? null : filter.spaceId || bridge.ctx().spaceId;
        const q = filter.search?.toLowerCase();
        const seen = new Set<string>();
        const out: PlainNote[] = [];
        for (const n of vRef.current.notes) {
          seen.add(n.id);
          const r = recent.get(n.id);
          const pn = r && r.modified > n.data.modified ? r : toPlain(n, p.id);
          out.push(pn);
        }
        for (const [id, r] of recent) if (!seen.has(id)) out.push(r);
        return out.filter(
          (n) =>
            (!sid || n.spaceId === sid) &&
            (filter.boardId === undefined || n.boardId === filter.boardId) &&
            (!filter.type || n.type === filter.type) &&
            (!filter.tag || n.tags.includes(filter.tag)) &&
            (!q || n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q)),
        );
      },
      get(id: string) {
        need("notes:read");
        const n = findNote(id);
        const r = recent.get(id);
        if (n && (!r || r.modified <= n.data.modified)) return toPlain(n, p.id);
        return r || null;
      },
      async create(input: Partial<PlainNote> & { spaceId?: string; boardId?: string | null }) {
        need("notes:write");
        const sid = input.spaceId || bridge.ctx().spaceId;
        if (!sid) throw new Error("No space selected");
        writableSpace(sid);
        const { id: wanted, data, boardId } = buildNew(sid, input);
        const id = await vRef.current.saveNote({ id: wanted, spaceId: sid, boardId, data });
        recent.set(id, { ...toPlain({ id, spaceId: sid, boardId, data } as Note, p.id) });
        return id;
      },
      /** Create many notes in one space at once (imports). Needs a connection. */
      async createMany(spaceId: string, inputs: (Partial<PlainNote> & { boardId?: string | null })[], onProgress?: (done: number, total: number) => void) {
        need("notes:write");
        writableSpace(spaceId);
        if (!Array.isArray(inputs)) throw new Error("createMany needs an array of notes");
        const items = inputs.map((i) => ({ ...buildNew(spaceId, i) }));
        const ids = new Set(items.map((i) => i.id));
        if (ids.size !== items.length) throw new Error("Duplicate note ids");
        const prog = onProgress ? guard(p.id, "import progress", onProgress, undefined) : undefined;
        await vRef.current.saveNotesBulk(spaceId, items.map((i) => ({ id: i.id!, boardId: i.boardId, data: i.data })), prog);
        return items.map((i) => i.id!);
      },
      async update(id: string, patch: Partial<PlainNote> & { boardId?: string | null }) {
        need("notes:write");
        const n = findNote(id);
        if (!n) throw new Error("Note not found");
        writableSpace(n.spaceId);
        const data: NoteData = { ...n.data, ...cleanPatch(patch), modified: Date.now() };
        const field = ownedField(n.data.type, p.id);
        if (patch.data !== undefined) {
          if (field) (data as any)[field] = structuredCloneSafe(patch.data);
          else data.ext = { ...(n.data.ext || {}), [p.id]: structuredCloneSafe(patch.data) };
        }
        const boardId = patch.boardId !== undefined ? patch.boardId : n.boardId;
        await vRef.current.saveNote({ id, spaceId: n.spaceId, boardId, data });
        recent.set(id, toPlain({ ...n, boardId, data }, p.id));
      },
      async delete(id: string) {
        need("notes:write");
        const n = findNote(id);
        if (!n) throw new Error("Note not found");
        writableSpace(n.spaceId);
        recent.delete(id);
        await vRef.current.deleteNote(id);
      },
      open(id: string) {
        bridge.openNote(id);
      },
    },
    /** API 5: attachments (photos, videos, files) of notes, decrypted in the browser. */
    files: {
      /** The note's small inline preview (images and videos), or null. */
      thumb(id: string): string | null {
        need("notes:read");
        const n = findNote(id);
        return n && typeof n.data.thumb === "string" && n.data.thumb.startsWith("data:image/") ? n.data.thumb : null;
      },
      /** An object URL for the decrypted attachment (cached; don't revoke it). */
      async url(id: string, opts: { onProgress?: (frac: number) => void } = {}) {
        need("notes:read");
        const n = findNote(id);
        if (!n?.data.file) throw new Error("That note has no attachment");
        if (!n.fileSize) throw new Error(missingFile(n));
        const prog = opts?.onProgress ? guard(p.id, "download progress", opts.onProgress, undefined) : undefined;
        return vRef.current.getFileUrl(n, prog);
      },
      async blob(id: string) {
        need("notes:read");
        const n = findNote(id);
        if (!n?.data.file) throw new Error("That note has no attachment");
        if (!n.fileSize) throw new Error(missingFile(n));
        return vRef.current.fileBlob(n);
      },
      /** Upload a file as a new image/video/file note, like dropping it on a space. Needs a connection. */
      async add(file: File, input: Partial<PlainNote> & { spaceId?: string; boardId?: string | null } = {}) {
        need("notes:write");
        if (!(file instanceof Blob)) throw new Error("files.add needs a File");
        const sid = input.spaceId || bridge.ctx().spaceId;
        if (!sid) throw new Error("No space selected");
        writableSpace(sid);
        const f = file instanceof File ? file : new File([file], "file", { type: (file as Blob).type });
        const info = await describeFile(f);
        const { id: wanted, data, boardId } = buildNew(sid, { ...input, type: undefined });
        const full: NoteData = { ...data, ...info, title: typeof input.title === "string" ? data.title : info.title };
        let id: string;
        try {
          id = await vRef.current.saveNote({ id: wanted, spaceId: sid, boardId, data: full, file: f });
        } catch (e) {
          if (e instanceof NetworkError) throw new Error(unreachable(e));
          throw e;
        }
        recent.set(id, toPlain({ id, spaceId: sid, boardId, data: full } as Note, p.id));
        return id;
      },
    },
    /**
     * API 6 (publish): put files on this server at /shared/<name>/ for anyone
     * with the address. Encrypt what you upload; the page there is your
     * plug-in's "shareViewer" file.
     */
    shares: {
      async info() {
        need("publish");
        const r = await api<{ enabled: boolean; maxMb: number; maxFileMb: number }>("GET", `/api/shares?plugin=${encodeURIComponent(p.id)}`);
        return { enabled: r.enabled && !!p.shareViewer, maxMb: r.maxMb, maxFileMb: r.maxFileMb, base: new URL(`${API_BASE}/shared/`, location.href).href };
      },
      async list() {
        need("publish");
        const r = await api<{ shares: ShareInfo[] }>("GET", `/api/shares?plugin=${encodeURIComponent(p.id)}`);
        return r.shares;
      },
      async check(name: string) {
        need("publish");
        return api<{ slug: string; valid: boolean; available: boolean; mine: boolean; share: ShareInfo | null }>("GET", `/api/shares/${encodeURIComponent(name)}`);
      },
      /** The viewer page's HTML, e.g. to export a copy for another web server. */
      async viewer() {
        need("publish");
        if (!p.shareViewer) throw new Error(`"${p.id}" has no shareViewer in its plugin.json`);
        const r = await fetch(`${API_BASE}/plugins/${p.id}/${p.shareViewer}?v=${p.hash}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`Couldn't load ${p.shareViewer} (${r.status})`);
        return r.text();
      },
      /**
       * Publish (or replace) a share. `files` lists every file name; `produce`
       * is only called for the ones the server doesn't already have from the
       * previous version, so stable names make updates quick.
       */
      async publish(
        name: string,
        opts: { files: string[]; produce: (file: string) => Promise<Blob | Uint8Array | string>; expires?: number | null; onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
      ) {
        need("publish");
        // No check of the online flag first: just try, and say what actually went wrong.
        try {
          return await publishShare(name, opts);
        } catch (e) {
          if (e instanceof NetworkError) throw new Error(unreachable(e));
          throw e;
        }
      },
      async setExpiry(name: string, expires: number | null) {
        need("publish");
        return api<ShareInfo>("PATCH", `/api/shares/${encodeURIComponent(name)}`, { expires });
      },
      async remove(name: string) {
        need("publish");
        await api("DELETE", `/api/shares/${encodeURIComponent(name)}`);
      },
    },
    /**
     * API 8 (drive): the user's Scute Drive, a WebDAV folder of ordinary
     * (unencrypted) files at /dav/. Paths are "a/b/c.txt", relative to the drive.
     */
    drive: driveApi(() => need("drive")),
    storage: {
      get(key: string) {
        need("storage");
        return structuredCloneSafe(vRef.current.settings.pluginData?.[p.id]?.[key]);
      },
      all() {
        need("storage");
        return structuredCloneSafe({ ...(vRef.current.settings.pluginData?.[p.id] || {}) });
      },
      set(key: string, value: unknown) {
        need("storage");
        const run = async () => {
          const all = { ...(vRef.current.settings.pluginData || {}) };
          const mine = { ...(all[p.id] || {}) };
          if (value === undefined) delete mine[key];
          else mine[key] = structuredCloneSafe(value);
          if (JSON.stringify(mine).length > 64 * 1024) throw new Error("Plug-in storage is limited to 64 KB per plug-in");
          all[p.id] = mine;
          await vRef.current.saveSettings({ pluginData: all });
          await new Promise((r) => setTimeout(r, 0)); // let React publish the new settings to vRef
        };
        const next = storageQueue.p.then(run, run);
        storageQueue.p = next.catch(() => {});
        return next;
      },
      remove(key: string) {
        return scute.storage.set(key, undefined);
      },
    },
    ui: {
      toast(t: string | { title: string; description?: string; error?: boolean }) {
        const o = typeof t === "string" ? { title: t } : t;
        toast({ title: String(o.title || ""), description: o.description ? String(o.description) : undefined, variant: o.error ? "destructive" : undefined });
      },
      alert: (message: string, title = p.name) => ask({ kind: "alert", title, message }).then(() => undefined),
      confirm: (message: string, opts: { title?: string; okLabel?: string } = {}) => ask({ kind: "confirm", title: opts.title || p.name, message, okLabel: opts.okLabel }) as Promise<boolean>,
      prompt: (message: string, value = "", opts: { title?: string; okLabel?: string } = {}) => ask({ kind: "prompt", title: opts.title || p.name, message, value, okLabel: opts.okLabel }) as Promise<string | null>,
      el,
    },
  };
  return Object.freeze(scute);
}

// ------------------------------------------------------------------ loader
interface Loaded {
  disposers: (() => void)[];
  deactivate?: () => void;
}

export function usePluginLoader() {
  const v = useVault();
  const vRef = useRef(v);
  vRef.current = v;
  const loaded = useRef(new Map<string, Loaded>());
  const storageQueue = useRef({ p: Promise.resolve() as Promise<unknown> });
  const userId = v.user?.id;
  const off = (v.settings.pluginsOff || []).join(",");
  const tick = useSyncExternalStore(subscribe, () => state.tick);

  const unloadAll = useCallback(() => {
    for (const [id, l] of loaded.current) {
      try {
        l.deactivate?.();
      } catch (e) {
        console.error(`[plug-in ${id}] deactivate`, e);
      }
      l.disposers.forEach((d) => d());
      document.querySelectorAll(`link[data-plugin="${CSS.escape(id)}"]`).forEach((n) => n.remove());
    }
    loaded.current.clear();
    listeners.clear();
    set({ reg: emptyReg(), rev: state.rev + 1 });
    setMarkdownTransforms([]);
  }, []);

  useEffect(() => {
    if (v.status !== "ready" || !userId) return;
    let cancelled = false;
    (async () => {
      let list: PluginInfo[] = [];
      let available = false;
      try {
        const r = await api<{ enabled: boolean; net?: string[]; plugins: PluginInfo[] }>("GET", "/api/plugins");
        list = r.plugins;
        available = r.enabled;
        netAllow = Array.isArray(r.net) ? r.net : [];
        try {
          localStorage.setItem(`scute:plugins:${userId}`, JSON.stringify(r));
        } catch {
          /* storage full or blocked */
        }
      } catch {
        // offline: use the last list we saw; older server: no plug-ins
        try {
          const r = JSON.parse(localStorage.getItem(`scute:plugins:${userId}`) || "null");
          if (r) {
            list = r.plugins;
            available = r.enabled;
            netAllow = Array.isArray(r.net) ? r.net : [];
          }
        } catch {
          /* ignore */
        }
      }
      if (cancelled) return;
      unloadAll();
      const userOff = new Set(off ? off.split(",") : []);
      const status: Record<string, PluginStatus> = {};
      for (const p of list) status[p.id] = p.error ? { state: "error", error: p.error } : !p.enabled || userOff.has(p.id) ? { state: "off" } : { state: "loading" };
      set({ available, list, status });
      for (const p of list) {
        if (status[p.id].state !== "loading") continue;
        const disposers: (() => void)[] = [];
        try {
          const base = `${API_BASE}/plugins/${encodeURIComponent(p.id)}/`;
          if (p.styles) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = `${base}${p.styles}?v=${p.hash}`;
            link.dataset.plugin = p.id;
            document.head.appendChild(link);
          }
          const mod = await import(/* @vite-ignore */ new URL(`${base}${p.main}?v=${p.hash}`, location.href).href);
          if (cancelled) return;
          const activate = mod.activate || mod.default;
          if (typeof activate !== "function") throw new Error(`${p.main} must export an activate(scute) function`);
          const ret = await activate(makeApi(p, vRef, disposers, storageQueue.current));
          loaded.current.set(p.id, { disposers, deactivate: typeof ret === "function" ? ret : typeof mod.deactivate === "function" ? mod.deactivate : undefined });
          set({ status: { ...state.status, [p.id]: { state: "active" } } });
        } catch (e) {
          disposers.forEach((d) => d());
          loaded.current.set(p.id, { disposers: [] });
          console.error(`[plug-in ${p.id}] failed to load`, e);
          set({ status: { ...state.status, [p.id]: { state: "error", error: (e as Error)?.message || String(e) } } });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [v.status, userId, off, tick, unloadAll]);

  useEffect(() => () => unloadAll(), [unloadAll]);

  // notes:change — ids whose content changed since the last render
  const prev = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!listeners.get("notes:change")?.size) {
      prev.current = null;
      return;
    }
    const now = new Map(v.notes.map((n) => [n.id, n.data.modified]));
    if (prev.current) {
      const changed: string[] = [];
      for (const [id, m] of now) if (prev.current.get(id) !== m) changed.push(id);
      const removed = [...prev.current.keys()].filter((id) => !now.has(id));
      if (changed.length || removed.length) emitPluginEvent("notes:change", { changed, removed });
    }
    prev.current = now;
  }, [v.notes, state.rev]); // eslint-disable-line

  // keyboard shortcuts for commands
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const c of state.reg.commands) {
        if (!c.key) continue;
        const k = parseKey(c.key);
        if (k.mod !== (e.ctrlKey || e.metaKey) || k.shift !== e.shiftKey || k.alt !== e.altKey || e.key.toLowerCase() !== k.key) continue;
        const t = e.target as HTMLElement;
        if (!k.mod && t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) continue;
        e.preventDefault();
        c.run(bridge.ctx());
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ------------------------------------------------------------------ small components
export function PluginIcon({ icon, className = "h-4 w-4" }: { icon?: string; className?: string }) {
  const html = useMemo(() => pluginIconHtml(icon), [icon]);
  if (!html) return null;
  return <span className={`inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full ${className}`} aria-hidden dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Mounts a plug-in view into a plain DOM container. */
export function PluginViewHost({ view, ctx }: { view: Owned<View>; ctx: Ctx }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const ctxKey = `${ctx.spaceId}|${ctx.boardId}`;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    setErr(null);
    let cleanup: void | (() => void);
    try {
      cleanup = view.mount(el, ctx);
    } catch (e) {
      console.error(`[plug-in ${view.pluginId}] view`, e);
      setErr((e as Error)?.message || String(e));
    }
    return () => {
      try {
        if (typeof cleanup === "function") cleanup();
      } catch (e) {
        console.error(e);
      }
      el.innerHTML = "";
    };
  }, [view, ctxKey]); // eslint-disable-line
  return (
    <div>
      {err && (
        <p className="mb-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive" data-testid="text-plugin-view-error">
          This view failed to open: {err}
        </p>
      )}
      <div ref={ref} className="scute-plugin-view" data-plugin={view.pluginId} data-testid={`view-plugin-${view.pluginId}-${view.id}`} />
    </div>
  );
}

export const PluginRevContext = createContext(0);
export const usePluginRev = () => useContext(PluginRevContext);

const coverCache = new Map<string, string>();
/** Sanitised SVG markup for a plug-in card cover (cached; covers are called on every render). */
export function sanitizeCoverSvg(markup: string) {
  const hit = coverCache.get(markup);
  if (hit !== undefined) return hit;
  const clean = DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["use"], FORBID_TAGS: ["foreignObject", "script", "style"] }) as unknown as string;
  if (coverCache.size > 300) coverCache.clear();
  coverCache.set(markup, clean);
  return clean;
}
