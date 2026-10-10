import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Link2, KeyRound, Image as ImageIcon, Paperclip, Pin, CloudOff, Copy, Check, Film, Play, Music, Download, Loader2, AlertTriangle } from "lucide-react";
import { captureFrame, embedFor, fmtDuration, isAudioMime, isVideoMime, isVideoNote, makeVideoPoster, type Embed } from "@/lib/media";
import type { NoteType } from "@shared/schema";
import type { Note } from "@/lib/vault";
import { canWrite, useVault } from "@/lib/vault";
import { joplinRefs, renderMarkdown, resourceIdOf } from "@/lib/markdown";
import { useToast } from "@/hooks/use-toast";
import { BookmarkCardExtras, BookmarkCover } from "@/components/bookmarks";
import { PluginIcon, noteTypeOf, runGuarded, sanitizeCoverSvg, toPlain, usePlugins } from "@/lib/plugins";

export const NOTE_TYPES: { type: NoteType; label: string; icon: typeof FileText }[] = [
  { type: "text", label: "Note", icon: FileText },
  { type: "link", label: "Bookmark", icon: Link2 },
  { type: "password", label: "Password", icon: KeyRound },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "video", label: "Video", icon: Film },
  { type: "file", label: "File", icon: Paperclip },
];
export const typeIcon = (t: NoteType) => NOTE_TYPES.find((x) => x.type === t)?.icon || FileText;

export const NOTE_COLORS: { id: string; label: string; swatch: string }[] = [
  { id: "amber", label: "Amber", swatch: "#d9a441" },
  { id: "clay", label: "Clay", swatch: "#c4673f" },
  { id: "rose", label: "Rose", swatch: "#c2577a" },
  { id: "sky", label: "Sky", swatch: "#4f86b8" },
  { id: "sage", label: "Sage", swatch: "#5f9a74" },
  { id: "violet", label: "Violet", swatch: "#8566b8" },
];
export const colorSwatch = (id?: string | null) => NOTE_COLORS.find((c) => c.id === id)?.swatch;

export function hostOf(url?: string) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
export function fmtBytes(n?: number | null) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [done, setDone] = useState(false);
  const { toast } = useToast();
  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      data-testid={testId}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
          if (label === "password") {
            // best-effort: clear clipboard after 30s if unchanged
            setTimeout(async () => {
              try {
                if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText("");
              } catch {
                /* ignore */
              }
            }, 30_000);
          }
        } catch {
          toast({ title: "Couldn't copy", description: "Clipboard access was blocked." });
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Resolves Joplin resource links (":/<id>") inside Markdown. Provided by Joplin spaces. */
export type ResourceResolver = (id: string) => Promise<{ url: string; mime: string; name: string }>;
export const ResourceContext = createContext<ResourceResolver | null>(null);

function resFail(el: HTMLElement, msg: string, retry: () => void) {
  const box = document.createElement("span");
  box.className = "joplin-res-error";
  box.setAttribute("data-testid", "text-joplin-res-error");
  box.textContent = `Couldn't load attachment: ${msg} `;
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Retry";
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.replaceWith(el);
    retry();
  });
  box.appendChild(b);
  el.replaceWith(box);
}

export function Markdown({ src, className = "", noteId = null }: { src: string; className?: string; noteId?: string | null }) {
  const resolve = useContext(ResourceContext);
  const ref = useRef<HTMLDivElement>(null);
  const { rev, reg } = usePlugins(); // plug-in Markdown transforms re-render on change
  const allNotes = useVault().notes; // post-processors may depend on other notes (e.g. wiki links)
  const html = useMemo(() => renderMarkdown(src), [src, rev]); // eslint-disable-line
  useEffect(() => {
    const el = ref.current;
    if (!el || !reg.posts.length) return;
    for (const p of reg.posts) p.fn(el, { noteId });
  }, [html, reg.posts, noteId, allNotes]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !resolve) return;
    // Tag every Joplin resource once; the tag survives effect re-runs, unlike the src.
    el.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
      const id = resourceIdOf(img.getAttribute("src"));
      if (!id) return;
      img.dataset.jres = id;
      img.removeAttribute("src");
    });
    el.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      const id = resourceIdOf(a.getAttribute("href"));
      if (!id) return;
      a.dataset.jres = id;
      a.removeAttribute("href");
      a.removeAttribute("target");
      a.classList.add("joplin-res-link");
      a.setAttribute("role", "button");
    });
    const load = (img: HTMLImageElement) => {
      const id = img.dataset.jres!;
      img.dataset.jstate = "loading";
      img.classList.add("joplin-res-loading");
      resolve(id)
        .then((r) => {
          img.classList.remove("joplin-res-loading");
          img.dataset.jstate = "done";
          if (r.mime.startsWith("video/") || r.mime.startsWith("audio/")) {
            const m = document.createElement(r.mime.startsWith("video/") ? "video" : "audio");
            m.src = r.url;
            m.controls = true;
            m.preload = "metadata";
            m.className = "joplin-res-media";
            m.addEventListener("click", (e) => e.stopPropagation());
            img.replaceWith(m);
          } else if (r.mime.startsWith("image/") || r.mime === "application/octet-stream") {
            img.src = r.url;
          } else {
            // Not an image (e.g. a PDF embedded with image syntax): show it as a download link
            const a = document.createElement("a");
            a.dataset.jres = id;
            a.className = "joplin-res-link";
            a.setAttribute("role", "button");
            a.textContent = img.alt || r.name;
            img.replaceWith(a);
            bindLink(a);
          }
        })
        .catch((e) => {
          img.classList.remove("joplin-res-loading");
          img.dataset.jstate = "error";
          resFail(img, (e as Error).message || "unknown error", () => load(img));
        });
    };
    const bindLink = (a: HTMLAnchorElement) => {
      if (a.dataset.jbound) return;
      a.dataset.jbound = "1";
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const r = await resolve(a.dataset.jres!);
          const d = document.createElement("a");
          d.href = r.url;
          d.download = r.name;
          d.click();
        } catch (err) {
          a.title = `Couldn't download: ${(err as Error).message}`;
          a.classList.add("joplin-res-link-error");
        }
      });
    };
    el.querySelectorAll<HTMLImageElement>("img[data-jres]").forEach((img) => {
      if (img.dataset.jstate !== "done" && img.dataset.jstate !== "loading") load(img);
    });
    el.querySelectorAll<HTMLAnchorElement>("a[data-jres]").forEach(bindLink);
  }, [html, resolve]);
  return <div ref={ref} className={`prose-note text-sm leading-relaxed ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Card cover for Joplin notes: the first embedded image, wherever it sits in the note. */
export function JoplinCover({ text }: { text: string }) {
  const resolve = useContext(ResourceContext);
  const refs = resolve ? joplinRefs(text) : [];
  const first = refs.find((r) => r.image);
  const files = refs.filter((r) => !r.image);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!resolve || !first) return;
    let live = true;
    setErr(null);
    resolve(first.id)
      .then((r) => live && (r.mime.startsWith("image/") || r.mime === "application/octet-stream" ? setUrl(r.url) : setUrl(null)))
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [resolve, first?.id, tick]); // eslint-disable-line
  if (!resolve || !refs.length) return null;
  const moreImages = refs.filter((r) => r.image).length - 1;
  return (
    <>
      {first &&
        (url ? (
          <div className="relative">
            <img src={url} alt={first.name || "Image"} className="w-full object-cover max-h-80 bg-muted" data-testid="img-joplin-cover" />
            {moreImages > 0 && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">+{moreImages}</span>}
          </div>
        ) : err ? (
          <div className="flex items-center gap-2 bg-muted px-4 py-3 text-xs text-muted-foreground" data-testid="text-joplin-cover-error">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">Couldn't load image: {err}</span>
            <button
              type="button"
              className="underline"
              onClick={(e) => {
                e.stopPropagation();
                setTick((t) => t + 1);
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="h-40 w-full animate-pulse bg-muted" />
        ))}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pt-3" data-testid="list-joplin-files">
          {files.slice(0, 3).map((f) => (
            <span key={f.id} className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="truncate">{f.name || "Attachment"}</span>
            </span>
          ))}
          {files.length > 3 && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">+{files.length - 3}</span>}
        </div>
      )}
    </>
  );
}

const NOT_UPLOADED = "This file never finished uploading, so only the preview is here. Edit the note to attach the file again.";

export function DecryptedImage({ note, className, alt }: { note: Note; className?: string; alt: string }) {
  const v = useVault();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    if (!note.fileSize) return;
    v.getFileUrl(note)
      .then((u) => live && setUrl(u))
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, [note.id, note.fileSize]); // eslint-disable-line
  if (err) return <div className="text-xs text-muted-foreground p-4">Image unavailable offline</div>;
  if (!url && !note.fileSize && note.data.file)
    return (
      <div className="space-y-2" data-testid="status-file-not-uploaded">
        {note.data.thumb && <img src={note.data.thumb} alt={alt} className={className} />}
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {NOT_UPLOADED}
        </p>
      </div>
    );
  if (!url) return note.data.thumb ? <img src={note.data.thumb} alt={alt} className={className} /> : <div className="h-40 animate-pulse bg-muted rounded-md" />;
  return <img src={url} alt={alt} className={className} />;
}

/** What went wrong fetching an attachment, in words: only a real decryption failure says "decrypt". */
export function fileError(e: any): string {
  if (!navigator.onLine) return "Not available offline";
  if (e?.name === "NetworkError") return "Couldn't reach your server. Try again in a moment.";
  if (typeof e?.status === "number") return e.status === 404 ? "This file isn't on the server" : `The server couldn't send this file (error ${e.status})`;
  return "Couldn't decrypt this file";
}

/** Downloads + decrypts an attachment with progress, returning a blob URL. */
function useDecryptedUrl(note: Note, enabled = true) {
  const v = useVault();
  const [url, setUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setErr(null);
    setProgress(0);
    if (enabled && !note.fileSize && note.data.file) setErr(NOT_UPLOADED);
    if (!enabled || !note.fileSize) return;
    v.getFileUrl(note, (f) => live && setProgress(f))
      .then((u) => live && setUrl(u))
      .catch((e) => live && setErr(fileError(e)));
    return () => {
      live = false;
    };
  }, [note.id, note.fileSize, enabled]); // eslint-disable-line
  return { url, progress, err };
}

function MediaLoading({ note, progress, poster }: { note: Note; progress: number; poster?: string | null }) {
  const size = note.data.file?.size || note.fileSize || 0;
  return (
    <div className="relative overflow-hidden rounded-md border bg-black aspect-video flex items-center justify-center" data-testid="status-media-loading">
      {poster && <img src={poster} alt="" className="absolute inset-0 h-full w-full object-contain opacity-40" />}
      <div className="relative flex flex-col items-center gap-2 text-white/90 text-xs">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>
          Decrypting{progress > 0 && progress < 1 ? ` · ${Math.round(progress * 100)}%` : "…"}
          {size > 0 && ` of ${fmtBytes(size)}`}
        </span>
        {progress > 0 && progress < 1 && (
          <div className="h-1 w-40 rounded-full bg-white/20 overflow-hidden">
            <div className="h-full bg-white/80 transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function MediaError({ message, onDownload }: { message: string; onDownload?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground" data-testid="status-media-error">
      <AlertTriangle className="h-5 w-5" />
      <span>{message}</span>
      {onDownload && (
        <button type="button" onClick={onDownload} className="inline-flex items-center gap-1 text-primary hover:underline">
          <Download className="h-3.5 w-3.5" /> Download instead
        </button>
      )}
    </div>
  );
}

/** Plays an encrypted video attachment. The file is decrypted in memory; nothing unencrypted touches disk. */
export function VideoPlayer({ note, onDownload, onSetThumb }: { note: Note; onDownload?: () => void; onSetThumb?: (thumb: string) => void }) {
  const { url, progress, err } = useDecryptedUrl(note);
  const [bad, setBad] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  const d = note.data;
  if (err) return <MediaError message={err} />;
  if (!url) return <MediaLoading note={note} progress={progress} poster={d.thumb} />;
  if (bad) return <MediaError message={`This browser can't play ${d.file?.type || "this format"}. MP4 (H.264/AAC) and WebM play almost everywhere.`} onDownload={onDownload} />;
  return (
    <div className="space-y-1.5">
      <video
        ref={vid}
        src={url}
        poster={d.thumb || undefined}
        controls
        playsInline
        preload="metadata"
        className="w-full max-h-[70dvh] rounded-md border bg-black"
        onError={() => setBad(true)}
        data-testid="video-player"
      />
      {onSetThumb && (
        <button
          type="button"
          onClick={() => {
            const t = vid.current && captureFrame(vid.current);
            if (t) onSetThumb(t);
          }}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          data-testid="button-set-thumb"
        >
          <ImageIcon className="h-3.5 w-3.5" /> Use this frame as the thumbnail
        </button>
      )}
    </div>
  );
}

export function AudioPlayer({ note, onDownload }: { note: Note; onDownload?: () => void }) {
  const { url, progress, err } = useDecryptedUrl(note);
  const [bad, setBad] = useState(false);
  if (err) return <MediaError message={err} />;
  if (!url)
    return (
      <div className="flex items-center gap-2 rounded-md border px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Decrypting{progress > 0 && progress < 1 ? ` · ${Math.round(progress * 100)}%` : "…"}
      </div>
    );
  if (bad) return <MediaError message="This browser can't play this audio format." onDownload={onDownload} />;
  return <audio src={url} controls preload="metadata" className="w-full" onError={() => setBad(true)} data-testid="audio-player" />;
}

/**
 * Plays a YouTube / Vimeo / direct media link. Nothing is loaded from the third party until the user presses play.
 */
export function EmbedPlayer({ embed, poster }: { embed: Embed; poster?: string | null }) {
  const [on, setOn] = useState(false);
  const [bad, setBad] = useState(false);
  if (embed.kind === "direct") {
    if (!on)
      return (
        <button type="button" onClick={() => setOn(true)} className="flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm hover:bg-muted/60" data-testid="button-play-embed">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Play className="h-4 w-4 translate-x-px" />
          </span>
          <span className="flex-1">
            Play {embed.media}
            <span className="block text-xs text-muted-foreground">Streams from {embed.label}</span>
          </span>
        </button>
      );
    if (bad) return <MediaError message={`Couldn't play this ${embed.media} from ${embed.label}.`} />;
    return embed.media === "video" ? (
      <video src={embed.src} controls autoPlay playsInline className="w-full max-h-[70dvh] rounded-md border bg-black" onError={() => setBad(true)} data-testid="video-player" />
    ) : (
      <audio src={embed.src} controls autoPlay className="w-full" onError={() => setBad(true)} data-testid="audio-player" />
    );
  }
  return (
    <div className="relative aspect-video overflow-hidden rounded-md border bg-black">
      {on ? (
        <iframe
          src={embed.src}
          title={`${embed.label} video`}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          data-testid="iframe-embed"
        />
      ) : (
        <button type="button" onClick={() => setOn(true)} className="shell-pattern absolute inset-0 flex flex-col items-center justify-center gap-3 text-white" data-testid="button-play-embed">
          {poster && (
            <>
              <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
              <span className="absolute inset-0 bg-black/45" />
            </>
          )}
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-white/90 text-black shadow-lg transition-transform hover:scale-105">
            <Play className="h-6 w-6 translate-x-0.5" />
          </span>
          <span className="relative text-sm font-medium">Play on {embed.label}</span>
          <span className="relative max-w-xs px-4 text-center text-[11px] text-white/60">Loads the {embed.label} player. {embed.label} will see your IP address; your notes stay private.</span>
        </button>
      )}
    </div>
  );
}

// ---------- video thumbnail backfill ----------
// Videos saved before thumbnails existed (or whose frame couldn't be read at upload) get one
// generated the first time their card scrolls into view. One at a time, once per session.
const thumbMemo = new Map<string, string>();
const thumbTried = new Set<string>();
let thumbQueue: Promise<void> = Promise.resolve();

function useVideoThumb(note: Note, el: React.RefObject<HTMLElement>) {
  const v = useVault();
  const d = note.data;
  const [thumb, setThumb] = useState<string | null>(d.thumb || thumbMemo.get(note.id) || null);
  useEffect(() => setThumb(d.thumb || thumbMemo.get(note.id) || null), [d.thumb, note.id]);
  useEffect(() => {
    if (thumb || !note.fileSize || !v.online || thumbTried.has(note.id) || !el.current) return;
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || thumbTried.has(note.id)) return;
      thumbTried.add(note.id);
      io.disconnect();
      thumbQueue = thumbQueue.then(async () => {
        try {
          const url = await v.getFileUrl(note);
          const p = await makeVideoPoster(url);
          if (!p?.thumb) return;
          thumbMemo.set(note.id, p.thumb);
          if (live) setThumb(p.thumb);
          const role = v.spaces.find((s) => s.id === note.spaceId)?.role;
          if (canWrite(role)) {
            const file = d.file ? { ...d.file, width: d.file.width || p.width, height: d.file.height || p.height, duration: d.file.duration ?? p.duration } : d.file;
            await v.saveNote({ id: note.id, spaceId: note.spaceId, boardId: note.boardId, data: { ...d, thumb: p.thumb, file } });
          }
        } catch {
          /* unsupported codec or offline: keep the placeholder */
        }
      });
    }, { rootMargin: "200px" });
    io.observe(el.current);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [note.id, thumb, v.online]); // eslint-disable-line
  return thumb;
}

/** Poster shown on grid cards for video notes. */
function VideoPoster({ note }: { note: Note }) {
  const d = note.data;
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useVideoThumb(note, ref);
  const ratio = d.file?.width && d.file?.height ? d.file.width / d.file.height : 16 / 9;
  return (
    <div ref={ref} className="relative w-full bg-black overflow-hidden max-h-80" style={{ aspectRatio: String(Math.max(0.56, Math.min(2.4, ratio))) }} data-testid={`video-thumb-${note.id}`}>
      {thumb ? (
        <img src={thumb} alt={d.title || "Video"} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="shell-pattern flex h-full w-full items-center justify-center text-white/40">
          <Film className="h-8 w-8" />
        </div>
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform group-hover:scale-110">
          <Play className="h-5 w-5 translate-x-0.5" />
        </span>
      </span>
      {d.file?.duration != null && (
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">{fmtDuration(d.file.duration)}</span>
      )}
    </div>
  );
}

export function NoteCard({
  note,
  onOpen,
  boardName,
  selecting,
  selected,
  onSelect,
  onDragStart,
}: {
  note: Note;
  onOpen: () => void;
  boardName?: string;
  /** Selection mode: a click selects instead of opening. */
  selecting?: boolean;
  selected?: boolean;
  /** Toggle this card (shift: extend a range). Ctrl/Cmd-click also starts selecting. */
  onSelect?: (e: { shiftKey: boolean }) => void;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  const d = note.data;
  const Icon = typeIcon(d.type);
  usePlugins(); // plug-in note types can change the icon and card line
  const pt = noteTypeOf(d.type);
  const sw = colorSwatch(d.color);
  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={selecting ? !!selected : undefined}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={(e) => {
        if (onSelect && (selecting || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSelect({ shiftKey: e.shiftKey });
        } else onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (selecting && onSelect) onSelect({ shiftKey: e.shiftKey });
          else onOpen();
        }
      }}
      className={`group relative rounded-lg border bg-card text-card-foreground overflow-hidden cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "ring-2 ring-primary" : ""}`}
      style={sw ? { borderTopColor: sw, borderTopWidth: 3 } : undefined}
      data-testid={`card-note-${note.id}`}
    >
      {selecting && (
        <>
          {/* covers links and players inside the card, so a click only selects */}
          <span className={`absolute inset-0 z-10 ${selected ? "bg-primary/10" : "hover:bg-foreground/5"}`} aria-hidden="true" />
        </>
      )}
      {isVideoNote(d) && <VideoPoster note={note} />}
      {d.type === "link" && <BookmarkCover note={note} />}
      {d.type === "image" && d.thumb && <img src={d.thumb} alt={d.title || "Image"} className="w-full object-cover max-h-80 bg-muted" loading="lazy" />}
      {d.type === "text" && d.text && /:\/[0-9a-fA-F]{32}/.test(d.text) && <JoplinCover text={d.text} />}
      {pt?.cardCover && <PluginCardCover note={note} />}
      <div className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          {selecting ? (
            <span className={`mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60 bg-background"}`} aria-hidden="true" data-testid={`check-note-${note.id}`}>
              {selected && <Check className="h-3 w-3" strokeWidth={3.5} />}
            </span>
          ) : pt?.icon ? (
            <PluginIcon icon={pt.icon} className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          ) : (
            <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          )}
          <h3 className="flex-1 text-sm font-semibold leading-snug break-words" data-testid={`text-note-title-${note.id}`}>
            {d.title || (d.type === "link" ? hostOf(d.url) : d.type === "file" || d.type === "video" ? d.file?.name : "Untitled")}
          </h3>
          {d.joplin?.props?.is_todo === "1" && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${d.joplin.props.todo_completed && d.joplin.props.todo_completed !== "0" ? "bg-muted text-muted-foreground line-through" : "bg-accent text-accent-foreground"}`} data-testid={`badge-todo-${note.id}`}>
              To-do
            </span>
          )}
          <PluginBadges note={note} />
          {d.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-primary" aria-label="Pinned" />}
          {note.pending && <CloudOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Waiting to sync" />}
        </div>

        {d.type === "link" && d.url && (
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-xs text-primary hover:underline"
            data-testid={`link-note-url-${note.id}`}
          >
            {hostOf(d.url)}
          </a>
        )}
        {d.type === "link" && (embedFor(d.url) || (d.archive && /^(video|audio)\//.test(d.file?.type || ""))) && (
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <Play className="h-3 w-3" /> Plays in Scute
          </span>
        )}
        {d.type === "link" && <BookmarkCardExtras note={note} />}

        {pt?.cardLine && <PluginCardLine note={note} />}
        {d.type === "password" && (
          <div className="rounded-md bg-muted/70 px-2 py-1.5 text-xs space-y-1">
            {d.username && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono truncate">{d.username}</span>
                <CopyButton value={d.username} label="username" testId={`button-copy-user-${note.id}`} />
              </div>
            )}
            {d.password && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono tracking-widest text-muted-foreground">••••••••••</span>
                <CopyButton value={d.password} label="password" testId={`button-copy-pass-${note.id}`} />
              </div>
            )}
          </div>
        )}

        {d.type === "file" && d.file && (
          <div className="flex items-center gap-2 rounded-md bg-muted/70 px-2 py-1.5 text-xs">
            {isVideoMime(d.file.type) ? <Film className="h-3.5 w-3.5" /> : isAudioMime(d.file.type) ? <Music className="h-3.5 w-3.5" /> : <Paperclip className="h-3.5 w-3.5" />}
            <span className="truncate flex-1">{d.file.name}</span>
            <span className="text-muted-foreground tabular-nums">{fmtBytes(d.file.size)}</span>
          </div>
        )}

        {d.text && (
          <div className={`note-clamp text-muted-foreground${d.joplin ? " note-clamp-noimg" : ""}`}>
            <Markdown src={d.text.slice(0, 1500)} className="text-[13px]" noteId={note.id} />
          </div>
        )}

        {(d.tags.length > 0 || boardName) && (
          <div className="flex flex-wrap gap-1 pt-1">
            {boardName && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-accent-foreground">{boardName}</span>}
            {d.tags.map((t) => (
              <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/** Small labels plug-ins add to note cards (scute.cards.addBadge). */
function PluginBadges({ note }: { note: Note }) {
  const { reg } = usePlugins();
  if (!reg.badges.length) return null;
  const out: { key: string; text: string }[] = [];
  for (const b of reg.badges) {
    const t = b.fn(toPlain(note, b.pluginId));
    if (t) out.push({ key: b.uid, text: String(t).slice(0, 40) });
  }
  return (
    <>
      {out.map((b) => (
        <span key={b.key} className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground" data-testid={`badge-plugin-${note.id}`}>
          {b.text}
        </span>
      ))}
    </>
  );
}

/** A picture a plug-in note type draws at the top of its cards (API 4). */
function PluginCardCover({ note }: { note: Note }) {
  const pt = noteTypeOf(note.data.type);
  const cover = pt?.cardCover ? (runGuarded(pt.pluginId, `${pt.title} cover`, () => pt.cardCover!(toPlain(note, pt.pluginId))) as string | null | undefined) : null;
  if (typeof cover !== "string" || !cover) return null;
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(cover)) return <img src={cover} alt="" className="w-full object-cover max-h-80 bg-muted" loading="lazy" data-testid={`cover-${note.data.type}-${note.id}`} />;
  const html = sanitizeCoverSvg(cover);
  if (!html) return null;
  return <div className="plugin-cover w-full [&>svg]:block [&>svg]:w-full [&>svg]:h-auto" dangerouslySetInnerHTML={{ __html: html }} data-testid={`cover-${note.data.type}-${note.id}`} />;
}

/** The one-line summary a plug-in note type shows on its cards. */
function PluginCardLine({ note }: { note: Note }) {
  const pt = noteTypeOf(note.data.type);
  const line = pt?.cardLine ? (runGuarded(pt.pluginId, `${pt.title} card`, () => pt.cardLine!(toPlain(note, pt.pluginId))) as ReturnType<NonNullable<typeof pt.cardLine>>) : null;
  const parts = Array.isArray(line?.parts) ? line!.parts.filter((x) => typeof x === "string" && x) : [];
  if (!line || !parts.length) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`text-${note.data.type}-line-${note.id}`}>
      {line.dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: /^#[0-9a-f]{3,8}$/i.test(line.dot) ? line.dot : undefined }} />}
      {parts.map((x, i) => (
        <span key={i} className="contents">
          {i > 0 && <span aria-hidden>·</span>}
          <span className={i === parts.length - 1 ? "truncate tabular-nums" : "tabular-nums"}>{x}</span>
        </span>
      ))}
    </p>
  );
}
