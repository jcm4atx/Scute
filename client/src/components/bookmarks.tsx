// Bookmark extras: previews on cards, saved copies (ArchiveBox-style), duplicate detection.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Archive, Copy as CopyIcon, Download, Eye, Film, Image as ImageIcon, Loader2, Play, RefreshCw, Trash2, X } from "lucide-react";
import type { NoteData } from "@shared/schema";
import { canWrite, useVault, type Note } from "@/lib/vault";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { embedFor } from "@/lib/media";
import { archiveLink, buildPreview, canArchive, guessKind, urlKey, webEnabled, type LinkKind } from "@/lib/web";
import { DecryptedImage, EmbedPlayer, VideoPlayer, AudioPlayer, fmtBytes, hostOf } from "@/components/note-parts";

type Vault = ReturnType<typeof useVault>;

// ---------- background jobs ----------
// Saving a copy can take a while, so it runs after the editor closes. The runtime
// component (mounted once on the home page) keeps a handle on the live vault.
const live: { v: Vault | null } = { v: null };
export function BookmarkRuntime() {
  live.v = useVault();
  return null;
}

type JobState = { msg: string; kind: "preview" | "archive" };
let jobs: Record<string, JobState> = {};
const subs = new Set<() => void>();
function setJob(id: string, s: JobState | null) {
  jobs = { ...jobs };
  if (s) jobs[id] = s;
  else delete jobs[id];
  subs.forEach((f) => f());
}
export function useBookmarkJob(id?: string) {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => (id ? jobs[id] || null : null),
  );
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

async function fresh(id: string, tries = 20): Promise<Note | null> {
  for (let i = 0; i < tries; i++) {
    const n = live.v?.notes.find((x) => x.id === id);
    if (n) return n;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
async function patch(id: string, fn: (d: NoteData) => NoteData, file?: File) {
  const n = await fresh(id);
  if (!n || !live.v) throw new Error("The bookmark is gone");
  await live.v.saveNote({ id: n.id, spaceId: n.spaceId, boardId: n.boardId, data: fn(n.data), file });
}

/** Look up a bookmark's preview (kind, title, thumbnail) and store it with the note. */
async function runPreview(id: string, opts: { fillTitle?: boolean } = {}) {
  const n = await fresh(id);
  if (!n?.data.url) return;
  setJob(id, { kind: "preview", msg: "Looking up the link…" });
  try {
    const p = await buildPreview(n.data.url);
    await patch(id, (d) => ({
      ...d,
      title: d.title || (opts.fillTitle !== false ? p.title || "" : d.title),
      thumb: p.thumb || d.thumb || null,
      preview: { kind: p.kind, site: p.site, description: p.description, image: p.image, checked: Date.now() },
    }));
  } catch (e) {
    await patch(id, (d) => ({ ...d, preview: { kind: d.preview?.kind || guessKind(d.url) || "page", checked: Date.now(), error: (e as Error).message.slice(0, 200) } })).catch(() => undefined);
  } finally {
    setJob(id, null);
  }
}

/** Save a copy of what the bookmark points to as the note's (encrypted) attachment. */
async function runArchive(id: string, quiet = false) {
  const n = await fresh(id);
  if (!n?.data.url) return false;
  const host = hostOf(n.data.url);
  setJob(id, { kind: "archive", msg: "Saving a copy…" });
  try {
    const max = (await maxUpload()) * 1024 * 1024;
    const a = await archiveLink(n.data.url, { maxBytes: max, onProgress: (msg) => setJob(id, { kind: "archive", msg }) });
    if (a.file.size > max) throw new Error(`The copy is ${fmtBytes(a.file.size)}, over this server's upload limit`);
    setJob(id, { kind: "archive", msg: "Encrypting and uploading…" });
    await patch(
      id,
      (d) => ({
        ...d,
        title: d.title || a.title || "",
        file: { name: a.file.name, type: a.file.type, size: a.file.size },
        joplin: d.joplin ? { ...d.joplin, resId: undefined } : d.joplin, // re-send the new copy
        archive: { at: Date.now(), url: a.url, kind: a.kind, title: a.title, resources: a.resources, skipped: a.skipped },
        preview: d.preview ? { ...d.preview, kind: a.kind === "file" ? d.preview.kind : a.kind } : d.preview,
      }),
      a.file,
    );
    if (!quiet)
      toast({
        title: "Copy saved",
        description: `${host} · ${fmtBytes(a.file.size)}${a.kind === "page" ? ` · ${a.resources} image${a.resources === 1 ? "" : "s"}/styles included${a.skipped ? `, ${a.skipped} couldn't be saved` : ""}` : ""}`,
      });
    return true;
  } catch (e) {
    if (!quiet) toast({ title: `Couldn't save a copy of ${host}`, description: (e as Error).message, variant: "destructive" });
    return false;
  } finally {
    setJob(id, null);
  }
}

let maxMb: number | null = null;
async function maxUpload() {
  if (maxMb == null) {
    try {
      const r = await fetch((await import("@/lib/queryClient")).API_BASE + "/api/health");
      maxMb = (await r.json()).maxUploadMb || 200;
    } catch {
      maxMb = 200;
    }
  }
  return maxMb!;
}

/** After the editor saves a bookmark: fetch its preview if needed, then the copy if asked. */
export function afterBookmarkSave(id: string, opts: { preview: boolean; archive: boolean }) {
  void enqueue(async () => {
    if (!(await webEnabled())) return;
    if (opts.preview) await runPreview(id);
    const n = await fresh(id);
    if (opts.archive && canArchive(n?.data.url)) await runArchive(id);
  });
}
export function archiveBookmark(id: string, quiet = false) {
  return enqueue(async () => ((await webEnabled()) ? runArchive(id, quiet) : false));
}
export function refreshPreview(id: string) {
  return enqueue(() => runPreview(id, { fillTitle: false }));
}

export const ARCHIVE_PREF = "scute.bookmarks.saveCopy";
export const archivePref = () => localStorage.getItem(ARCHIVE_PREF) !== "off";

// ---------- cards ----------
const tried = new Set<string>();
/** Bookmarks saved before previews existed get one the first time their card is on screen. */
function useAutoPreview(note: Note, el: React.RefObject<HTMLElement>) {
  const v = useVault();
  const d = note.data;
  useEffect(() => {
    if (d.preview || !d.url || !v.online || tried.has(note.id) || !el.current) return;
    if (!canWrite(v.spaces.find((s) => s.id === note.spaceId)?.role)) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || tried.has(note.id)) return;
        tried.add(note.id);
        io.disconnect();
        void enqueue(async () => {
          if (jobs[note.id] || !(await webEnabled())) return;
          await runPreview(note.id, { fillTitle: !d.title });
        });
      },
      { rootMargin: "200px" },
    );
    io.observe(el.current);
    return () => io.disconnect();
  }, [note.id, !!d.preview, v.online]); // eslint-disable-line
}

export function bookmarkKind(d: NoteData): LinkKind {
  return (d.archive?.kind && d.archive.kind !== "file" ? d.archive.kind : null) || d.preview?.kind || guessKind(d.url) || "page";
}

/** The picture at the top of a bookmark card: image, video poster or page preview. */
export function BookmarkCover({ note }: { note: Note }) {
  const d = note.data;
  const ref = useRef<HTMLDivElement>(null);
  useAutoPreview(note, ref);
  const kind = bookmarkKind(d);
  const job = useBookmarkJob(note.id);
  if (kind === "video")
    return (
      <div ref={ref} className="relative w-full aspect-video bg-black overflow-hidden" data-testid={`bookmark-video-${note.id}`}>
        {d.thumb ? (
          <img src={d.thumb} alt={d.title || "Video"} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="shell-pattern flex h-full w-full items-center justify-center text-white/40">{job ? <Loader2 className="h-6 w-6 animate-spin" /> : <Film className="h-8 w-8" />}</div>
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform group-hover:scale-110">
            <Play className="h-5 w-5 translate-x-0.5" />
          </span>
        </span>
      </div>
    );
  if (kind === "image")
    return (
      <div ref={ref} className="w-full bg-muted" data-testid={`bookmark-image-${note.id}`}>
        {d.thumb ? (
          <img src={d.thumb} alt={d.title || "Image"} className="w-full object-cover max-h-80" loading="lazy" />
        ) : (
          <div className="flex h-32 items-center justify-center text-muted-foreground">{job ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImageIcon className="h-6 w-6" />}</div>
        )}
      </div>
    );
  return (
    <div ref={ref} data-testid={d.thumb ? `bookmark-cover-${note.id}` : undefined}>
      {d.thumb && <img src={d.thumb} alt="" className="w-full object-cover max-h-44 bg-muted" loading="lazy" />}
    </div>
  );
}

/** Small line under the host on a bookmark card. */
export function BookmarkCardExtras({ note }: { note: Note }) {
  const d = note.data;
  const job = useBookmarkJob(note.id);
  return (
    <>
      {!d.text && d.preview?.description && <p className="text-xs text-muted-foreground line-clamp-2">{d.preview.description}</p>}
      {(job?.kind === "archive" || d.archive) && (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" data-testid={`badge-archived-${note.id}`}>
          {job?.kind === "archive" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
          {job?.kind === "archive" ? "Saving copy…" : "Saved copy"}
        </span>
      )}
    </>
  );
}

// ---------- viewer ----------
async function fileText(v: Vault, n: Note) {
  const u = await v.getFileUrl(n);
  return (await fetch(u)).text();
}

/** Bookmark body in the note viewer: image / video / preview, and the saved copy. */
export function BookmarkView({ noteId, writable }: { noteId: string; writable: boolean }) {
  const v = useVault();
  const note = v.notes.find((n) => n.id === noteId);
  const job = useBookmarkJob(noteId);
  const [viewing, setViewing] = useState(false);
  const [fullErr, setFullErr] = useState(false);
  if (!note) return null;
  const d = note.data;
  const kind = bookmarkKind(d);
  const embed = embedFor(d.url);
  const a = d.archive && note.fileSize ? d.archive : null;
  const aType = d.file?.type || "";

  async function download() {
    try {
      const u = await v.getFileUrl(note!);
      const el = document.createElement("a");
      el.href = u;
      el.download = d.file?.name || "copy";
      el.click();
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  let media: React.ReactNode = null;
  if (a && aType.startsWith("video/")) media = <VideoPlayer note={note} onDownload={download} />;
  else if (a && aType.startsWith("audio/")) media = <AudioPlayer note={note} onDownload={download} />;
  else if (a && aType.startsWith("image/")) media = <DecryptedImage note={note} alt={d.title || "Image"} className="w-full rounded-md border bg-muted" />;
  else if (embed) media = <EmbedPlayer key={d.url} embed={embed} poster={d.thumb} />;
  else if (kind === "image" && d.url)
    media = fullErr ? (
      d.thumb ? <img src={d.thumb} alt={d.title || "Image"} className="w-full rounded-md border bg-muted" /> : null
    ) : (
      <img src={d.preview?.image || d.url} alt={d.title || "Image"} referrerPolicy="no-referrer" className="w-full rounded-md border bg-muted" onError={() => setFullErr(true)} data-testid="img-bookmark" />
    );
  else if (d.thumb) media = <img src={d.thumb} alt="" className="w-full max-h-72 object-cover rounded-md border bg-muted" data-testid="img-bookmark-preview" />;

  return (
    <div className="space-y-3">
      {media}
      {d.preview?.description && !d.text && <p className="text-sm text-muted-foreground">{d.preview.description}</p>}
      <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5 text-sm" data-testid="panel-archive">
        <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-[10rem]">
          {job?.kind === "archive" ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-testid="status-archive-job">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {job.msg}
            </span>
          ) : a ? (
            <>
              <span className="font-medium">Saved copy</span>
              <span className="block text-xs text-muted-foreground" data-testid="text-archive-info">
                {new Date(a.at).toLocaleString()} · {fmtBytes(d.file?.size || note.fileSize)}
                {a.kind === "page" && a.skipped ? ` · ${a.skipped} item${a.skipped > 1 ? "s" : ""} missing` : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {embed && embed.kind !== "direct" ? (
                <>
                  Not saved offline
                  <span className="block text-xs">Scute keeps the title and thumbnail; the video itself stays on {embed.label}.</span>
                </>
              ) : (
                "No saved copy yet."
              )}
            </span>
          )}
        </div>
        {a && a.kind === "page" && (
          <Button size="sm" variant="secondary" onClick={() => setViewing(true)} data-testid="button-view-archive">
            <Eye className="h-3.5 w-3.5" /> View
          </Button>
        )}
        {a && (
          <Button size="sm" variant="ghost" onClick={download} data-testid="button-download-archive">
            <Download className="h-3.5 w-3.5" /> Download
          </Button>
        )}
        {writable && !job && canArchive(d.url) && (
          <Button size="sm" variant={a ? "ghost" : "secondary"} disabled={!v.online} onClick={() => void archiveBookmark(noteId)} data-testid="button-save-copy">
            {a ? <RefreshCw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />} {a ? "Save again" : "Save a copy"}
          </Button>
        )}
      </div>
      {viewing && a && <ArchiveViewer note={note} onClose={() => setViewing(false)} />}
    </div>
  );
}

/**
 * Shows a saved page. It runs in a sandboxed frame with no scripts and an opaque
 * origin, so nothing in the copy can reach Scute or your keys.
 */
function ArchiveViewer({ note, onClose }: { note: Note; onClose: () => void }) {
  const v = useVault();
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    fileText(v, note)
      .then((t) => on && setHtml(t))
      .catch((e) => on && setErr((e as Error).message));
    return () => {
      on = false;
    };
  }, [note.id, note.fileSize]); // eslint-disable-line
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl w-[96vw] h-[92dvh] p-0 gap-0 flex flex-col" data-testid="dialog-archive">
        <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b px-4 py-2.5 pr-12 text-left">
          <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm">{note.data.archive?.title || note.data.title || hostOf(note.data.url)}</DialogTitle>
            <DialogDescription className="truncate text-xs">
              Saved copy of {note.data.archive?.url || note.data.url} · {note.data.archive ? new Date(note.data.archive.at).toLocaleString() : ""}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="relative flex-1 bg-white">
          {err ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground bg-background">
              <AlertTriangle className="h-4 w-4" /> {err}
            </div>
          ) : html == null ? (
            <div className="flex h-full items-center justify-center bg-background">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <iframe title="Saved copy" srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full border-0" data-testid="iframe-archive" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- duplicates ----------
export function findDuplicates(notes: Note[], url: string | undefined, exceptId?: string) {
  const k = urlKey(url);
  if (!k) return [];
  return notes.filter((n) => n.id !== exceptId && n.data.type === "link" && urlKey(n.data.url) === k);
}

export function DuplicateWarning({ url, exceptId, onOpen }: { url?: string; exceptId?: string; onOpen?: (n: Note) => void }) {
  const v = useVault();
  const [q, setQ] = useState(url);
  useEffect(() => {
    const t = setTimeout(() => setQ(url), 250);
    return () => clearTimeout(t);
  }, [url]);
  const dups = useMemo(() => findDuplicates(v.notes, q, exceptId), [v.notes, q, exceptId]);
  if (!dups.length) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs space-y-1.5" role="status" data-testid="warning-duplicate">
      <div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
        <CopyIcon className="h-3.5 w-3.5" /> Already bookmarked{dups.length > 1 ? ` ${dups.length} times` : ""}
      </div>
      {dups.slice(0, 4).map((n) => (
        <div key={n.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {n.data.title || hostOf(n.data.url)}
            <span className="text-muted-foreground"> · {placeOf(v, n)}</span>
          </span>
          {onOpen && (
            <button type="button" className="shrink-0 text-primary hover:underline" onClick={() => onOpen(n)} data-testid={`button-open-duplicate-${n.id}`}>
              Open
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function placeOf(v: Vault, n: Note) {
  const s = v.spaces.find((x) => x.id === n.spaceId)?.data.title || "Space";
  const b = n.boardId ? v.boards.find((x) => x.id === n.boardId)?.data.title : null;
  return b ? `${s} / ${b}` : s;
}

// ---------- tools dialog ----------
export function BookmarkToolsDialog({ open, onClose, spaceId, onOpen }: { open: boolean; onClose: () => void; spaceId: string | null; onOpen: (n: Note) => void }) {
  const v = useVault();
  const [allSpaces, setAllSpaces] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number; failed: number; what: string } | null>(null);
  const stop = useRef(false);
  const writableSpace = (id: string) => canWrite(v.spaces.find((s) => s.id === id)?.role);

  const groups = useMemo(() => {
    const m = new Map<string, Note[]>();
    for (const n of v.notes) {
      if (n.data.type !== "link" || !n.data.url || (!allSpaces && n.spaceId !== spaceId)) continue;
      const k = urlKey(n.data.url);
      if (!k) continue;
      m.set(k, [...(m.get(k) || []), n]);
    }
    return [...m.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => (a.data.archive ? 0 : 1) - (b.data.archive ? 0 : 1) || (a.data.created || 0) - (b.data.created || 0)));
  }, [v.notes, allSpaces, spaceId]);

  const inSpace = v.notes.filter((n) => n.data.type === "link" && n.data.url && n.spaceId === spaceId);
  const noCopy = inSpace.filter((n) => !n.data.archive && canArchive(n.data.url));
  const noPreview = inSpace.filter((n) => !n.data.preview || n.data.preview.error || (!n.data.thumb && ["image", "video"].includes(bookmarkKind(n.data))));
  const canEdit = !!spaceId && writableSpace(spaceId);

  async function del(ids: string[]) {
    try {
      for (const id of ids) await v.deleteNote(id);
      toast({ title: ids.length > 1 ? `Deleted ${ids.length} duplicates` : "Deleted" });
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function runBulk(list: Note[], what: "copies" | "previews") {
    stop.current = false;
    let failed = 0;
    setBulk({ done: 0, total: list.length, failed: 0, what });
    for (let i = 0; i < list.length && !stop.current; i++) {
      if (what === "copies") failed += (await archiveBookmark(list[i].id, true)) ? 0 : 1;
      else await refreshPreview(list[i].id);
      setBulk({ done: i + 1, total: list.length, failed, what });
    }
    setBulk(null);
    toast({ title: what === "copies" ? `Saved ${list.length - failed} cop${list.length - failed === 1 ? "y" : "ies"}` : "Previews updated", description: failed ? `${failed} couldn't be saved. Open them to see why.` : undefined, variant: failed ? "destructive" : undefined });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !bulk && onClose()}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" data-testid="dialog-bookmark-tools">
        <DialogHeader>
          <DialogTitle>Bookmark tools</DialogTitle>
          <DialogDescription>Find duplicate bookmarks and keep saved copies of the pages they point to.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="dups">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="dups" data-testid="tab-duplicates">
              Duplicates{groups.length ? ` (${groups.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="copies" data-testid="tab-copies">
              Saved copies
            </TabsTrigger>
          </TabsList>
          <TabsContent value="dups" className="space-y-3 pt-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allSpaces} onChange={(e) => setAllSpaces(e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" data-testid="checkbox-dups-all" />
              Look across all spaces
            </label>
            {groups.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground" data-testid="text-no-duplicates">
                No duplicate bookmarks{allSpaces ? "" : " in this space"}.
              </p>
            ) : (
              groups.map((g, gi) => (
                <div key={gi} className="rounded-md border" data-testid={`group-duplicate-${gi}`}>
                  <div className="truncate border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{g[0].data.url}</div>
                  {g.map((n) => {
                    const w = writableSpace(n.spaceId);
                    return (
                      <div key={n.id} className="flex items-center gap-2 px-3 py-2 text-sm border-b last:border-b-0">
                        <button type="button" className="min-w-0 flex-1 text-left hover:underline" onClick={() => onOpen(n)}>
                          <span className="block truncate font-medium">{n.data.title || hostOf(n.data.url)}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {placeOf(v, n)} · added {new Date(n.data.created || 0).toLocaleDateString()}
                            {n.data.archive ? " · saved copy" : ""}
                          </span>
                        </button>
                        {w && g.filter((x) => x.id !== n.id && writableSpace(x.spaceId)).length > 0 && (
                          <Button size="sm" variant="ghost" className="shrink-0 text-xs" onClick={() => void del(g.filter((x) => x.id !== n.id && writableSpace(x.spaceId)).map((x) => x.id))} data-testid={`button-keep-${n.id}`}>
                            Keep only this
                          </Button>
                        )}
                        {w && (
                          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Delete this bookmark" onClick={() => void del([n.id])} data-testid={`button-delete-dup-${n.id}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </TabsContent>
          <TabsContent value="copies" className="space-y-3 pt-2 text-sm">
            <p className="text-muted-foreground">
              {inSpace.length} bookmark{inSpace.length === 1 ? "" : "s"} in this space, {inSpace.length - noCopy.length} with a saved copy. Copies are encrypted like your other attachments.
            </p>
            {bulk ? (
              <div className="space-y-2 rounded-md border px-3 py-3" data-testid="status-bulk">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> {bulk.what === "copies" ? "Saving copies" : "Updating previews"} · {bulk.done} of {bulk.total}
                  {bulk.failed ? ` · ${bulk.failed} failed` : ""}
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (stop.current = true)} data-testid="button-bulk-stop">
                    <X className="h-3.5 w-3.5" /> Stop
                  </Button>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${(bulk.done / Math.max(1, bulk.total)) * 100}%` }} />
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button disabled={!canEdit || !noCopy.length || !v.online} onClick={() => void runBulk(noCopy, "copies")} data-testid="button-bulk-archive">
                  <Archive className="h-4 w-4" /> Save {noCopy.length || ""} missing cop{noCopy.length === 1 ? "y" : "ies"}
                </Button>
                <Button variant="secondary" disabled={!canEdit || !noPreview.length || !v.online} onClick={() => void runBulk(noPreview, "previews")} data-testid="button-bulk-preview">
                  <RefreshCw className="h-4 w-4" /> Refresh {noPreview.length || ""} preview{noPreview.length === 1 ? "" : "s"}
                </Button>
              </div>
            )}
            {!canEdit && <p className="text-xs text-muted-foreground">You can only view this space.</p>}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
