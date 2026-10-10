import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  BoardData,
  NoteData,
  RawBoard,
  RawInvite,
  RawMember,
  RawNote,
  RawSpace,
  Role,
  SpaceData,
  SyncResponse,
  UserBundle,
  UserSettings,
} from "@shared/schema";
import * as C from "./crypto";
import { api, ApiError, NetworkError, setToken, setUnauthorizedHandler, setReachabilityHandler, apiDownload } from "./api";
import { idbDel, idbGet, idbSet, idbClearPrefix } from "./idb";

// ---------- decrypted models ----------
export interface Space {
  id: string;
  ownerId: string;
  role: Role;
  key: CryptoKey;
  data: SpaceData;
  members: RawMember[];
}
export interface Board {
  id: string;
  spaceId: string;
  data: BoardData;
}
export interface Note {
  id: string;
  spaceId: string;
  boardId: string | null;
  key: CryptoKey;
  data: NoteData;
  fileSize: number | null;
  pending?: boolean;
}
export interface Invite {
  spaceId: string;
  role: Role;
  invitedBy: string | null;
  key: CryptoKey;
  data: SpaceData;
}

interface Session {
  token: string;
  user: UserBundle;
  master: CryptoKey;
  priv: CryptoKey;
}

interface RawCache {
  seq: number;
  spaces: RawSpace[];
  members: RawMember[];
  invites: RawInvite[];
  boards: Record<string, RawBoard>;
  notes: Record<string, RawNote>;
  settings?: string | null;
  extras?: string[];
}

interface OutboxOp {
  id: string;
  method: string;
  url: string;
  body?: unknown;
}

type Status = "booting" | "signedOut" | "ready";

const emptyCache = (): RawCache => ({ seq: 0, spaces: [], members: [], invites: [], boards: {}, notes: {} });

export const SPACE_COLORS = ["#2f6f5e", "#b5562f", "#3d5a8a", "#8a3d6f", "#8a7a2f", "#4b4b4b"];

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "Device";
  const br = /Firefox/.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ? " app" : "";
  return `${br} on ${os}${standalone}`;
}

// ---------- context ----------
function useVaultState() {
  const [status, setStatus] = useState<Status>("booting");
  const [session, setSession] = useState<Session | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [firstSyncDone, setFirstSyncDone] = useState(false);
  const [settings, setSettings] = useState<UserSettings>({});
  const [extras, setExtras] = useState<string[]>([]);
  const settingsRaw = useRef<string | null>(null);
  /** Hidden spaces are on show (until hidden again, a reload, or a while in the background). */
  const [revealed, setRevealed] = useState(false);

  const cache = useRef<RawCache>(emptyCache());
  const outbox = useRef<OutboxOp[]>([]);
  const sess = useRef<Session | null>(null);
  const spaceKeys = useRef(new Map<string, { enc: string; key: CryptoKey }>());
  const noteCache = useRef(new Map<string, { raw: string; note: Note }>());
  const boardCache = useRef(new Map<string, { raw: string; board: Board }>());
  const spaceDataCache = useRef(new Map<string, { raw: string; data: SpaceData }>());
  const fileUrls = useRef(new Map<string, string>());
  const syncLock = useRef<Promise<void> | null>(null);

  const prefix = () => `u:${sess.current?.user.id}:`;

  const persist = useCallback(async () => {
    if (!sess.current) return;
    await idbSet(prefix() + "cache", cache.current);
    await idbSet(prefix() + "outbox", outbox.current);
  }, []);

  /** Rebuild decrypted views from the raw cache. Decryption results are memoised per blob. */
  const rebuild = useCallback(async () => {
    const s = sess.current;
    if (!s) return;
    const c = cache.current;
    const memberMap = new Map<string, RawMember[]>();
    for (const m of c.members) {
      if (!memberMap.has(m.space_id)) memberMap.set(m.space_id, []);
      memberMap.get(m.space_id)!.push(m);
    }
    setExtras(c.extras || []);
    if ((c.settings || null) !== settingsRaw.current) {
      settingsRaw.current = c.settings || null;
      try {
        setSettings(c.settings ? await C.decryptJson<UserSettings>(s.master, c.settings) : {});
      } catch {
        setSettings({});
      }
    }
    const outSpaces: Space[] = [];
    for (const rs of c.spaces) {
      try {
        let k = spaceKeys.current.get(rs.id);
        if (!k || k.enc !== rs.enc_key) {
          k = { enc: rs.enc_key, key: await C.openSealedKey(s.priv, rs.enc_key) };
          spaceKeys.current.set(rs.id, k);
        }
        let d = spaceDataCache.current.get(rs.id);
        if (!d || d.raw !== rs.data) {
          d = { raw: rs.data, data: await C.decryptJson<SpaceData>(k.key, rs.data) };
          spaceDataCache.current.set(rs.id, d);
        }
        outSpaces.push({ id: rs.id, ownerId: rs.owner_id, role: rs.role, key: k.key, data: d.data, members: memberMap.get(rs.id) || [] });
      } catch (e) {
        console.warn("Could not decrypt space", rs.id, e);
      }
    }
    outSpaces.sort((a, b) => a.data.title.localeCompare(b.data.title));
    const keyOf = new Map(outSpaces.map((x) => [x.id, x.key]));

    const outBoards: Board[] = [];
    for (const rb of Object.values(c.boards)) {
      if (rb.deleted || !rb.data) continue;
      const sk = keyOf.get(rb.space_id);
      if (!sk) continue;
      const cached = boardCache.current.get(rb.id);
      if (cached && cached.raw === rb.data && cached.board.spaceId === rb.space_id) {
        outBoards.push(cached.board);
        continue;
      }
      try {
        const board = { id: rb.id, spaceId: rb.space_id, data: await C.decryptJson<BoardData>(sk, rb.data) };
        boardCache.current.set(rb.id, { raw: rb.data, board });
        outBoards.push(board);
      } catch (e) {
        console.warn("Could not decrypt board", rb.id, e);
      }
    }
    outBoards.sort((a, b) => a.data.title.localeCompare(b.data.title));

    const outNotes: Note[] = [];
    const pendingIds = new Set(outbox.current.map((o) => o.url.split("/").pop()));
    for (const rn of Object.values(c.notes)) {
      if (rn.deleted || !rn.data || !rn.enc_key) continue;
      const sk = keyOf.get(rn.space_id);
      if (!sk) continue;
      const sig = rn.enc_key + "|" + rn.data;
      const cached = noteCache.current.get(rn.id);
      if (cached && cached.raw === sig) {
        const n = cached.note;
        const updated =
          n.boardId !== rn.board_id || n.fileSize !== rn.file_size || n.spaceId !== rn.space_id || !!n.pending !== pendingIds.has(rn.id)
            ? { ...n, boardId: rn.board_id, fileSize: rn.file_size, spaceId: rn.space_id, pending: pendingIds.has(rn.id) }
            : n;
        cached.note = updated;
        outNotes.push(updated);
        continue;
      }
      try {
        const key = await C.unwrapKey(sk, rn.enc_key);
        const data = await C.decryptJson<NoteData>(key, rn.data);
        const note: Note = { id: rn.id, spaceId: rn.space_id, boardId: rn.board_id, key, data, fileSize: rn.file_size, pending: pendingIds.has(rn.id) };
        noteCache.current.set(rn.id, { raw: sig, note });
        outNotes.push(note);
      } catch (e) {
        console.warn("Could not decrypt note", rn.id, e);
      }
    }

    const outInvites: Invite[] = [];
    for (const iv of c.invites) {
      try {
        const key = await C.openSealedKey(s.priv, iv.enc_key);
        const data = await C.decryptJson<SpaceData>(key, iv.space_data);
        outInvites.push({ spaceId: iv.space_id, role: iv.role, invitedBy: iv.invited_by, key, data });
      } catch (e) {
        console.warn("Could not decrypt invite", iv.space_id, e);
      }
    }

    setSpaces(outSpaces);
    setBoards(outBoards);
    setNotes(outNotes);
    setInvites(outInvites);
    setPending(outbox.current.length);
  }, []);

  const applySync = useCallback((r: SyncResponse) => {
    const c = cache.current;
    const ids = new Set(r.spaces.map((s) => s.id));
    c.spaces = r.spaces;
    c.members = r.members;
    c.invites = r.invites;
    if (r.full) {
      c.boards = {};
      c.notes = {};
    }
    for (const b of r.boards) {
      if (b.deleted) delete c.boards[b.id];
      else c.boards[b.id] = b;
    }
    for (const n of r.notes) {
      if (n.deleted) delete c.notes[n.id];
      else c.notes[n.id] = n;
    }
    for (const [id, b] of Object.entries(c.boards)) if (!ids.has(b.space_id)) delete c.boards[id];
    for (const [id, n] of Object.entries(c.notes)) if (!ids.has(n.space_id)) delete c.notes[id];
    // re-apply any still-queued local writes on top of server state
    for (const op of outbox.current) applyOptimistic(op);
    c.seq = r.seq;
    c.settings = r.settings;
    c.extras = r.extras || [];
  }, []);

  function applyOptimistic(op: OutboxOp) {
    const c = cache.current;
    const parts = op.url.split("/"); // ['', 'api', 'notes', id]
    const kind = parts[2];
    const id = parts[3];
    const body = op.body as any;
    if (kind === "notes") {
      if (op.method === "PUT") {
        const prev = c.notes[id];
        c.notes[id] = {
          id,
          space_id: body.spaceId,
          board_id: body.boardId ?? null,
          enc_key: body.encKey,
          data: body.data,
          file_size: prev?.file_size ?? null,
          deleted: 0,
          seq: prev?.seq ?? 0,
        };
      } else if (op.method === "DELETE") delete c.notes[id];
    } else if (kind === "boards") {
      if (op.method === "PUT") c.boards[id] = { id, space_id: body.spaceId, data: body.data, deleted: 0, seq: c.boards[id]?.seq ?? 0 };
      else if (op.method === "DELETE") {
        delete c.boards[id];
        for (const n of Object.values(c.notes)) if (n.board_id === id) n.board_id = null;
      }
    }
  }

  const flushOutbox = useCallback(async () => {
    while (outbox.current.length) {
      const op = outbox.current[0];
      try {
        await api(op.method, op.url, op.body);
      } catch (e) {
        if (e instanceof NetworkError) throw e;
        // server rejected it (permissions, validation) — drop it so the queue can't jam
        console.warn("Dropping rejected queued change", op, e);
      }
      outbox.current.shift();
      await persist();
      setPending(outbox.current.length);
    }
  }, [persist]);

  const sync = useCallback(async (): Promise<void> => {
    if (!sess.current) return;
    if (syncLock.current) return syncLock.current;
    const run = (async () => {
      setSyncing(true);
      try {
        await flushOutbox();
        const r = await api<SyncResponse>("GET", `/api/sync?since=${cache.current.seq}`);
        applySync(r);
        await persist();
        await rebuild();
        setOnline(true);
        setLastSync(Date.now());
        setSyncError(null);
        setFirstSyncDone(true);
      } catch (e) {
        if (e instanceof NetworkError) setOnline(false);
        else setSyncError((e as Error).message);
      } finally {
        setSyncing(false);
        syncLock.current = null;
      }
    })();
    syncLock.current = run;
    return run;
  }, [applySync, flushOutbox, persist, rebuild]);

  /** Send a write. Optimistically applied; queued if offline. */
  const write = useCallback(
    async (method: string, url: string, body?: unknown, { queueable = true } = {}) => {
      const op: OutboxOp = { id: C.uuid(), method, url, body };
      if (queueable) {
        applyOptimistic(op);
        await rebuild();
      }
      try {
        if (outbox.current.length && queueable) throw new NetworkError("queue busy");
        const res = await api(method, url, body);
        setOnline(true);
        return res;
      } catch (e) {
        if (e instanceof NetworkError && queueable) {
          outbox.current.push(op);
          await persist();
          setPending(outbox.current.length);
          if (!(e.message === "queue busy")) setOnline(false);
          else void sync();
          await rebuild();
          return null;
        }
        if (e instanceof NetworkError) setOnline(false);
        // roll back optimistic state from the server
        void sync();
        throw e;
      }
    },
    [persist, rebuild, sync],
  );

  // ---------- auth ----------
  const startSession = useCallback(
    async (s: Session, remember: boolean) => {
      sess.current = s;
      setToken(s.token);
      spaceKeys.current.clear();
      noteCache.current.clear();
      boardCache.current.clear();
      spaceDataCache.current.clear();
      cache.current = (await idbGet<RawCache>(`u:${s.user.id}:cache`)) || emptyCache();
      outbox.current = (await idbGet<OutboxOp[]>(`u:${s.user.id}:outbox`)) || [];
      if (remember) await idbSet("session", s);
      else await idbDel("session");
      setSession(s);
      await rebuild();
      setStatus("ready");
      void sync();
    },
    [rebuild, sync],
  );

  const clearLocal = useCallback(async (wipeCache: boolean) => {
    const uid = sess.current?.user.id;
    await idbDel("session");
    if (wipeCache && uid) await idbClearPrefix(`u:${uid}:`);
    fileUrls.current.forEach((u) => URL.revokeObjectURL(u));
    fileUrls.current.clear();
    sess.current = null;
    setToken(null);
    cache.current = emptyCache();
    outbox.current = [];
    setSession(null);
    setSpaces([]);
    setBoards([]);
    setNotes([]);
    setInvites([]);
    setRevealed(false);
    setFirstSyncDone(false);
    setStatus("signedOut");
  }, []);

  // any request that reaches the server (or doesn't) keeps the online flag honest
  useEffect(() => {
    setReachabilityHandler((ok) => setOnline(ok));
    return () => setReachabilityHandler(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clearLocal(false);
    });
    (async () => {
      const saved = await idbGet<Session>("session");
      if (saved?.token && saved.master && saved.priv) await startSession(saved, true);
      else setStatus("signedOut");
    })();
  }, [clearLocal, startSession]);

  const login = useCallback(
    async (username: string, password: string, remember: boolean) => {
      const p = await api<{ salt: string; iter: number }>("GET", `/api/auth/params?username=${encodeURIComponent(username)}`);
      const { authKey, kek } = await C.deriveFromPassword(password, p.salt, p.iter);
      const r = await api<{ token: string; user: UserBundle }>("POST", "/api/auth/login", { username, authKey, label: deviceLabel() });
      const master = await C.unwrapKey(kek, r.user.encMaster, false);
      const priv = await C.unwrapPrivate(master, r.user.encPrivate);
      await startSession({ token: r.token, user: r.user, master, priv }, remember);
    },
    [startSession],
  );

  const register = useCallback(
    async (username: string, password: string, remember: boolean) => {
      const m = await C.createAccountMaterial(password);
      const r = await api<{ token: string; user: UserBundle }>("POST", "/api/auth/register", {
        username,
        kdfSalt: m.kdfSalt,
        kdfIter: m.kdfIter,
        authKey: m.authKey,
        encMaster: m.encMaster,
        publicKey: m.publicKey,
        encPrivate: m.encPrivate,
        label: deviceLabel(),
      });
      await startSession({ token: r.token, user: r.user, master: m.master, priv: m.privateKey }, remember);
    },
    [startSession],
  );

  const logout = useCallback(
    async (wipe = true) => {
      try {
        await api("POST", "/api/auth/logout");
      } catch {
        /* offline is fine */
      }
      await clearLocal(wipe);
    },
    [clearLocal],
  );

  const changePassword = useCallback(async (current: string, next: string) => {
    const s = sess.current!;
    const me = await api<{ user: UserBundle }>("GET", "/api/me");
    const old = await C.deriveFromPassword(current, me.user.kdfSalt, me.user.kdfIter);
    let masterRaw: CryptoKey;
    try {
      masterRaw = await C.unwrapKey(old.kek, me.user.encMaster, true);
    } catch {
      throw new Error("Current password is wrong");
    }
    const newSalt = C.toB64(C.randomBytes(16));
    const n = await C.deriveFromPassword(next, newSalt, C.KDF_ITER);
    await api("POST", "/api/me/password", {
      authKey: old.authKey,
      newKdfSalt: newSalt,
      newKdfIter: C.KDF_ITER,
      newAuthKey: n.authKey,
      newEncMaster: await C.wrapKey(n.kek, masterRaw),
    });
    const user = { ...s.user, kdfSalt: newSalt, kdfIter: C.KDF_ITER };
    sess.current = { ...s, user };
    setSession(sess.current);
    if (await idbGet("session")) await idbSet("session", sess.current);
  }, []);

  const deleteAccount = useCallback(
    async (password: string) => {
      const s = sess.current!;
      const d = await C.deriveFromPassword(password, s.user.kdfSalt, s.user.kdfIter);
      await api("POST", "/api/me/delete", { authKey: d.authKey });
      await clearLocal(true);
    },
    [clearLocal],
  );

  // ---------- spaces ----------
  const createSpace = useCallback(
    async (data: SpaceData) => {
      const s = sess.current!;
      const id = C.uuid();
      const key = await C.newAesKey(true);
      await api("PUT", `/api/spaces/${id}`, { data: await C.encryptJson(key, data), encKey: await C.sealKey(s.user.publicKey, key) });
      await sync();
      return id;
    },
    [sync],
  );

  const updateSpace = useCallback(
    async (space: Space, data: SpaceData) => {
      await api("PUT", `/api/spaces/${space.id}`, { data: await C.encryptJson(space.key, data) });
      await sync();
    },
    [sync],
  );

  const deleteSpace = useCallback(
    async (spaceId: string) => {
      await api("DELETE", `/api/spaces/${spaceId}`);
      await sync();
    },
    [sync],
  );

  const inviteMember = useCallback(
    async (space: Space, username: string, role: Role) => {
      const u = await api<{ id: string; username: string; publicKey: string }>("GET", `/api/users/${encodeURIComponent(username)}/key`);
      if (u.id === sess.current?.user.id) throw new Error("You're already in this space");
      const fp = await C.fingerprint(u.publicKey);
      await api("PUT", `/api/spaces/${space.id}/members/${u.id}`, { role, encKey: await C.sealKey(u.publicKey, space.key) });
      await sync();
      return fp;
    },
    [sync],
  );

  const setMemberRole = useCallback(
    async (spaceId: string, userId: string, role: Role) => {
      await api("PUT", `/api/spaces/${spaceId}/members/${userId}`, { role });
      await sync();
    },
    [sync],
  );

  const removeMember = useCallback(
    async (spaceId: string, userId: string) => {
      await api("DELETE", `/api/spaces/${spaceId}/members/${userId}`);
      await sync();
    },
    [sync],
  );

  const acceptInvite = useCallback(
    async (spaceId: string) => {
      await api("POST", `/api/spaces/${spaceId}/accept`);
      await sync();
    },
    [sync],
  );
  const declineInvite = useCallback(
    async (spaceId: string) => {
      await api("DELETE", `/api/spaces/${spaceId}/members/${sess.current!.user.id}`);
      await sync();
    },
    [sync],
  );

  // ---------- boards ----------
  const saveBoard = useCallback(
    async (spaceId: string, data: BoardData, id?: string) => {
      const sp = spaceKeys.current.get(spaceId);
      if (!sp) throw new Error("Unknown space");
      const bid = id || C.uuid();
      await write("PUT", `/api/boards/${bid}`, { spaceId, data: await C.encryptJson(sp.key, data) });
      return bid;
    },
    [write],
  );
  const deleteBoard = useCallback((id: string) => write("DELETE", `/api/boards/${id}`), [write]);

  // ---------- notes ----------
  const saveNote = useCallback(
    async (input: { id?: string; spaceId: string; boardId: string | null; data: NoteData; file?: File | null }) => {
      const sp = spaceKeys.current.get(input.spaceId);
      if (!sp) throw new Error("Unknown space");
      const existing = input.id ? noteCache.current.get(input.id)?.note : undefined;
      const id = input.id || C.uuid();
      const key = existing?.key || (await C.newAesKey(true));
      const body = {
        spaceId: input.spaceId,
        boardId: input.boardId,
        encKey: await C.wrapKey(sp.key, key),
        data: await C.encryptJson(key, input.data),
      };
      if (input.file) {
        // uploads need a connection: save note first, then stream the encrypted file
        await write("PUT", `/api/notes/${id}`, body, { queueable: false });
        const bytes = new Uint8Array(await input.file.arrayBuffer());
        const encd = await C.encryptBytes(key, bytes);
        try {
          await api("PUT", `/api/files/${id}`, undefined, encd);
        } catch (e) {
          // don't leave a note behind that points at a file the server never got
          try {
            if (!existing) await api("DELETE", `/api/notes/${id}`);
            else await api("PUT", `/api/notes/${id}`, { ...body, data: await C.encryptJson(key, existing.data) });
          } catch {
            /* offline: the next sync shows the note as it is on the server */
          }
          void sync();
          throw e;
        }
        fileUrls.current.delete(id);
        if (encd.length <= 12 * 1024 * 1024) await idbSet(prefix() + "file:" + id, encd);
        await sync();
      } else {
        await write("PUT", `/api/notes/${id}`, body);
      }
      return id;
    },
    [write, sync],
  );

  /** Save many notes at once (imports). Needs a connection; syncs once at the end. */
  const saveNotesBulk = useCallback(
    async (spaceId: string, items: { id: string; boardId?: string | null; data: NoteData }[], onProgress?: (done: number, total: number) => void) => {
      const sp = spaceKeys.current.get(spaceId);
      if (!sp) throw new Error("Unknown space");
      let done = 0;
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const it = items[next++];
          const existing = noteCache.current.get(it.id)?.note;
          const key = existing?.key || (await C.newAesKey(true));
          await api("PUT", `/api/notes/${it.id}`, {
            spaceId,
            boardId: it.boardId ?? null,
            encKey: await C.wrapKey(sp.key, key),
            data: await C.encryptJson(key, it.data),
          });
          onProgress?.(++done, items.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
      await sync();
    },
    [sync],
  );

  /** Merge and save encrypted account preferences. */
  const saveSettings = useCallback(
    async (patch: Partial<UserSettings>) => {
      const s = sess.current;
      if (!s) return;
      const next = { ...settings, ...patch };
      const enc = await C.encryptJson(s.master, next);
      await api("PUT", "/api/me/settings", { data: enc });
      cache.current.settings = enc;
      settingsRaw.current = enc;
      setSettings(next);
      await persist();
    },
    [settings, persist],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      await write("DELETE", `/api/notes/${id}`);
      await idbDel(prefix() + "file:" + id);
    },
    [write],
  );

  /** Fetch + decrypt an attachment. Returns an object URL. */
  const getFileUrl = useCallback(async (note: Note, onProgress?: (frac: number) => void): Promise<string> => {
    const hit = fileUrls.current.get(note.id);
    if (hit) return hit;
    const cacheKey = prefix() + "file:" + note.id;
    let plain: Uint8Array | null = null;
    const cached = await idbGet<Uint8Array>(cacheKey);
    if (cached) {
      try {
        plain = await C.decryptBytes(note.key, cached);
      } catch {
        // A damaged copy on this device (older versions could keep a cut-off
        // download): drop it and fetch the file again.
        await idbDel(cacheKey);
      }
    }
    if (!plain) {
      const bytes = await apiDownload(`/api/files/${note.id}`, onProgress);
      plain = await C.decryptBytes(note.key, bytes);
      // only keep copies that are known to be good
      if (bytes.length <= 12 * 1024 * 1024) void idbSet(cacheKey, bytes);
    }
    const url = URL.createObjectURL(new Blob([plain], { type: note.data.file?.type || "application/octet-stream" }));
    fileUrls.current.set(note.id, url);
    return url;
  }, []);

  /** Decrypted attachment as a Blob (used by Joplin sync to upload resources). */
  const fileBlob = useCallback(
    async (note: Note): Promise<Blob> => {
      const url = await getFileUrl(note);
      return await (await fetch(url)).blob();
    },
    [getFileUrl],
  );

  /** Ids of notes/boards deleted from a space (server keeps tombstones). */
  const tombstones = useCallback((spaceId: string) => api<{ notes: string[]; boards: string[] }>("GET", `/api/spaces/${spaceId}/tombstones`), []);

  // ---------- export / import ----------
  const exportData = useCallback(
    async (includeFiles: boolean) => {
      const out: any = {
        format: "scute-export",
        version: 1,
        exported: new Date().toISOString(),
        spaces: spaces.map((s) => ({ id: s.id, ...s.data })),
        boards: boards.map((b) => ({ id: b.id, space_id: b.spaceId, ...b.data })),
        notes: notes.map((n) => ({ id: n.id, space_id: n.spaceId, board_id: n.boardId, ...n.data })),
        files: [] as { note_id: string; data: string }[],
      };
      if (includeFiles) {
        for (const n of notes) {
          if (!n.fileSize) continue;
          try {
            const url = await getFileUrl(n);
            const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
            out.files.push({ note_id: n.id, data: C.toB64(buf) });
          } catch (e) {
            console.warn("skip file", n.id, e);
          }
        }
      }
      return out;
    },
    [spaces, boards, notes, getFileUrl],
  );

  /** Imports a Scute export, or (best effort) a Turtl JSON backup. */
  const importData = useCallback(
    async (json: any, targetSpaceId: string | null, onProgress?: (done: number, total: number) => void) => {
      if (!json || !Array.isArray(json.notes)) throw new Error("That file doesn't look like a Scute or Turtl export");
      const spaceMap = new Map<string, string>();
      const boardMap = new Map<string, string>();
      const srcSpaces: any[] = Array.isArray(json.spaces) ? json.spaces : [];
      if (targetSpaceId) {
        for (const s of srcSpaces) spaceMap.set(String(s.id), targetSpaceId);
      } else {
        for (const s of srcSpaces) {
          const nid = await createSpace({ title: String(s.title || "Imported"), color: s.color || SPACE_COLORS[0] });
          spaceMap.set(String(s.id), nid);
        }
      }
      let fallback = targetSpaceId || spaceMap.values().next().value;
      if (!fallback) fallback = await createSpace({ title: "Imported", color: SPACE_COLORS[2] });
      const resolveSpace = (sid: any) => spaceMap.get(String(sid)) || fallback!;
      for (const b of Array.isArray(json.boards) ? json.boards : []) {
        const sid = resolveSpace(b.space_id ?? b.spaceId);
        const nid = await saveBoard(sid, { title: String(b.title || "Board") });
        boardMap.set(String(b.id), nid);
      }
      const files = new Map<string, string>();
      for (const f of Array.isArray(json.files) ? json.files : []) {
        const nid = f.note_id ?? f.noteId ?? f.id;
        if (nid && typeof f.data === "string") files.set(String(nid), f.data);
      }
      const total = json.notes.length;
      let done = 0;
      for (const n of json.notes) {
        const type = ["text", "link", "password", "image", "video", "file"].includes(n.type) ? n.type : "text";
        const sid = resolveSpace(n.space_id ?? n.spaceId);
        const bid = boardMap.get(String(n.board_id ?? n.boardId)) || null;
        const fdata = files.get(String(n.id));
        let file: File | null = null;
        const meta = n.file && typeof n.file === "object" ? n.file : null;
        if (fdata) {
          const bytes = C.fromB64(fdata);
          file = new File([bytes], meta?.name || "file", { type: meta?.type || "application/octet-stream" });
        }
        const now = Date.now();
        const toMs = (v: any) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) || now : now);
        await saveNote({
          spaceId: sid,
          boardId: bid,
          file,
          data: {
            type,
            title: String(n.title || ""),
            text: String(n.text || ""),
            url: n.url || undefined,
            username: n.username || undefined,
            password: n.password || undefined,
            tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
            color: typeof n.color === "string" ? n.color : null,
            pinned: !!n.pinned,
            file: meta
              ? {
                  name: meta.name || "file",
                  type: meta.type || "application/octet-stream",
                  size: meta.size || 0,
                  ...(meta.width ? { width: Number(meta.width), height: Number(meta.height) } : {}),
                  ...(meta.duration != null ? { duration: Number(meta.duration) } : {}),
                }
              : null,
            thumb: typeof n.thumb === "string" ? n.thumb : null,
            created: toMs(n.created),
            modified: toMs(n.modified ?? n.mod),
          },
        });
        done++;
        onProgress?.(done, total);
      }
      await sync();
      return done;
    },
    [createSpace, saveBoard, saveNote, sync],
  );

  // ---------- hidden spaces ----------
  /** True if this is the account password (checked here, against the account's own key; works offline). */
  const checkPassword = useCallback(async (password: string) => {
    const s = sess.current;
    if (!s) return false;
    let u: UserBundle = s.user;
    try {
      u = (await api<{ user: UserBundle }>("GET", "/api/me")).user;
    } catch {
      /* offline: the copy from sign-in */
    }
    try {
      const { kek } = await C.deriveFromPassword(password, u.kdfSalt, u.kdfIter);
      await C.unwrapKey(kek, u.encMaster, false);
      return true;
    } catch {
      return false;
    }
  }, []);
  const hiddenKey = (settings.hiddenSpaces || []).join(",");
  const hiddenNow = useMemo(() => new Set(revealed || !hiddenKey ? [] : hiddenKey.split(",")), [revealed, hiddenKey]);
  const shownSpaces = useMemo(() => (hiddenNow.size ? spaces.filter((x) => !hiddenNow.has(x.id)) : spaces), [spaces, hiddenNow]);
  const shownBoards = useMemo(() => (hiddenNow.size ? boards.filter((x) => !hiddenNow.has(x.spaceId)) : boards), [boards, hiddenNow]);
  const shownNotes = useMemo(() => (hiddenNow.size ? notes.filter((x) => !hiddenNow.has(x.spaceId)) : notes), [notes, hiddenNow]);
  const reveal = useCallback(() => setRevealed(true), []);
  const conceal = useCallback(() => setRevealed(false), []);
  /** Hide or show one space; hiding also puts every hidden space away again. */
  const setSpaceHidden = useCallback(
    async (id: string, hide: boolean) => {
      const cur = settings.hiddenSpaces || [];
      const next = hide ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
      await saveSettings({ hiddenSpaces: next, ...(hide && settings.defaultSpaceId === id ? { defaultSpaceId: null } : {}) });
      if (hide) setRevealed(false);
    },
    [settings, saveSettings],
  );
  // put them away again after five minutes in the background
  useEffect(() => {
    if (!revealed) return;
    let away = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") away = Date.now();
      else if (away && Date.now() - away > 5 * 60_000) setRevealed(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [revealed]);
  // forget spaces that are gone
  useEffect(() => {
    if (!firstSyncDone || !hiddenKey || !spaces.length) return;
    const ids = hiddenKey.split(",");
    const live = ids.filter((id) => spaces.some((x) => x.id === id));
    if (live.length !== ids.length) void saveSettings({ hiddenSpaces: live }).catch(() => {});
  }, [firstSyncDone, hiddenKey, spaces]); // eslint-disable-line

  // back in touch: send what's waiting
  useEffect(() => {
    if (online && pending && status === "ready") void sync();
  }, [online]); // eslint-disable-line

  // ---------- lifecycle: polling + connectivity ----------
  useEffect(() => {
    if (status !== "ready") return;
    const onOnline = () => {
      setOnline(true);
      void sync();
    };
    const onOffline = () => setOnline(false);
    const onVis = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVis);
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, 20_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(t);
    };
  }, [status, sync]);

  return useMemo(
    () => ({
      status,
      session,
      user: session?.user || null,
      /** Spaces, boards and notes on show: hidden spaces (and everything in them) are left out unless revealed. */
      spaces: shownSpaces,
      boards: shownBoards,
      notes: shownNotes,
      /** Every space, hidden ones included (for Settings). */
      allSpaces: spaces,
      revealed,
      reveal,
      conceal,
      setSpaceHidden,
      checkPassword,
      invites,
      online,
      syncing,
      lastSync,
      pending,
      syncError,
      firstSyncDone,
      settings,
      extras,
      saveSettings,
      saveNotesBulk,
      login,
      register,
      logout,
      changePassword,
      deleteAccount,
      sync,
      createSpace,
      updateSpace,
      deleteSpace,
      inviteMember,
      setMemberRole,
      removeMember,
      acceptInvite,
      declineInvite,
      saveBoard,
      deleteBoard,
      saveNote,
      deleteNote,
      getFileUrl,
      fileBlob,
      tombstones,
      exportData,
      importData,
    }),
    [
      status, session, shownSpaces, shownBoards, shownNotes, spaces, revealed, reveal, conceal, setSpaceHidden, checkPassword, invites, online, syncing, lastSync, pending, syncError, firstSyncDone, settings, extras, saveSettings, saveNotesBulk,
      login, register, logout, changePassword, deleteAccount, sync, createSpace, updateSpace, deleteSpace, inviteMember,
      setMemberRole, removeMember, acceptInvite, declineInvite, saveBoard, deleteBoard, saveNote, deleteNote, getFileUrl, fileBlob, tombstones,
      exportData, importData,
    ],
  );
}

export type Vault = ReturnType<typeof useVaultState>;
const Ctx = createContext<Vault | null>(null);

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const v = useVaultState();
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export function useVault() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVault outside provider");
  return v;
}

export function canWrite(role: Role | undefined) {
  return role === "owner" || role === "admin" || role === "member";
}
export function canManage(role: Role | undefined) {
  return role === "owner" || role === "admin";
}
export { ApiError };
