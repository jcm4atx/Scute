import { useEffect, useRef, useState } from "react";
import { FileText, Link2, KeyRound, Image as ImageIcon, Paperclip, Pin, CloudOff, Copy, Check, Film, Play, Music, Download, Loader2, AlertTriangle } from "lucide-react";
import { captureFrame, embedFor, fmtDuration, isAudioMime, isVideoMime, isVideoNote, makeVideoPoster, type Embed } from "@/lib/media";
import type { NoteType } from "@shared/schema";
import type { Note } from "@/lib/vault";
import { canWrite, useVault } from "@/lib/vault";
import { renderMarkdown } from "@/lib/markdown";
import { useToast } from "@/hooks/use-toast";

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

export function Markdown({ src, className = "" }: { src: string; className?: string }) {
  return <div className={`prose-note text-sm leading-relaxed ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />;
}

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
  if (!url) return note.data.thumb ? <img src={note.data.thumb} alt={alt} className={className} /> : <div className="h-40 animate-pulse bg-muted rounded-md" />;
  return <img src={url} alt={alt} className={className} />;
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
    if (!enabled || !note.fileSize) return;
    v.getFileUrl(note, (f) => live && setProgress(f))
      .then((u) => live && setUrl(u))
      .catch((e) => live && setErr(e?.name === "NetworkError" || !navigator.onLine ? "Not available offline" : "Couldn't decrypt this file"));
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
export function EmbedPlayer({ embed }: { embed: Embed }) {
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
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/90 text-black shadow-lg transition-transform hover:scale-105">
            <Play className="h-6 w-6 translate-x-0.5" />
          </span>
          <span className="text-sm font-medium">Play on {embed.label}</span>
          <span className="max-w-xs px-4 text-center text-[11px] text-white/60">Loads the {embed.label} player. {embed.label} will see your IP address; your notes stay private.</span>
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

export function NoteCard({ note, onOpen, boardName }: { note: Note; onOpen: () => void; boardName?: string }) {
  const d = note.data;
  const Icon = typeIcon(d.type);
  const sw = colorSwatch(d.color);
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group relative rounded-lg border bg-card text-card-foreground overflow-hidden cursor-pointer transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={sw ? { borderTopColor: sw, borderTopWidth: 3 } : undefined}
      data-testid={`card-note-${note.id}`}
    >
      {isVideoNote(d) && <VideoPoster note={note} />}
      {d.type === "image" && d.thumb && <img src={d.thumb} alt={d.title || "Image"} className="w-full object-cover max-h-80 bg-muted" loading="lazy" />}
      <div className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <h3 className="flex-1 text-sm font-semibold leading-snug break-words" data-testid={`text-note-title-${note.id}`}>
            {d.title || (d.type === "link" ? hostOf(d.url) : d.type === "file" || d.type === "video" ? d.file?.name : "Untitled")}
          </h3>
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
        {d.type === "link" && embedFor(d.url) && (
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <Play className="h-3 w-3" /> Plays in Scute
          </span>
        )}

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
          <div className="note-clamp text-muted-foreground">
            <Markdown src={d.text.slice(0, 1500)} className="text-[13px]" />
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
