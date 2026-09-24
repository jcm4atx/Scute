import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { FileMeta, NoteData, NoteType } from "@shared/schema";
import { canWrite, useVault, type Note } from "@/lib/vault";
import {
  CopyButton,
  AudioPlayer,
  DecryptedImage,
  EmbedPlayer,
  Markdown,
  VideoPlayer,
  NOTE_COLORS,
  NOTE_TYPES,
  colorSwatch,
  fmtBytes,
  hostOf,
} from "./note-parts";
import { isImageNote, audioDuration, detectType, embedFor, fmtDuration, guessMime, isAudioMime, isVideoMime, makeVideoPoster } from "@/lib/media";
import { api } from "@/lib/api";

let maxUploadMb: number | null = null;
async function getMaxUploadMb() {
  if (maxUploadMb == null) {
    try {
      maxUploadMb = (await api<{ maxUploadMb: number }>("GET", "/api/health")).maxUploadMb || 50;
    } catch {
      return 50;
    }
  }
  return maxUploadMb;
}
const HAS_FILE = (t: NoteType) => t === "image" || t === "video" || t === "file";
import { GalleryHorizontalEnd, Check, Download, Music, Eye, EyeOff, ExternalLink, Loader2, Pencil, Pin, PinOff, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";

export interface EditorTarget {
  note?: Note;
  type?: NoteType;
  spaceId: string;
  boardId: string | null;
  prefill?: Partial<NoteData>;
  /** Files to attach. More than one creates one note per file. */
  files?: File[];
}

function genPassword(len = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+?";
  const out: string[] = [];
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out.push(chars[buf[i] % chars.length]);
  return out.join("");
}

async function makeThumb(file: File): Promise<{ thumb: string; width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 560 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return { thumb: c.toDataURL("image/jpeg", 0.72), width: bmp.width, height: bmp.height };
  } catch {
    return null;
  }
}

const blank = (type: NoteType): NoteData => ({
  type,
  title: "",
  text: "",
  url: "",
  username: "",
  password: "",
  tags: [],
  color: null,
  pinned: false,
  file: null,
  thumb: null,
  created: Date.now(),
  modified: Date.now(),
});

/** Build the note fields (type, title, metadata, thumbnail) for one attachment. */
async function describeFile(f: File): Promise<Pick<NoteData, "type" | "title" | "file" | "thumb">> {
  const type = detectType(f);
  const meta: FileMeta = { name: f.name, type: f.type || guessMime(f.name), size: f.size };
  const title = f.name.replace(/\.[^.]+$/, "");
  if (type === "image") {
    const t = await makeThumb(f);
    return { type, title, file: { ...meta, width: t?.width, height: t?.height }, thumb: t?.thumb || null };
  }
  if (type === "video") {
    const p = await makeVideoPoster(f);
    return { type, title, file: { ...meta, width: p?.width, height: p?.height, duration: p?.duration }, thumb: p?.thumb || null };
  }
  if (isAudioMime(meta.type)) return { type, title, file: { ...meta, duration: await audioDuration(f) }, thumb: null };
  return { type, title: f.name, file: meta, thumb: null };
}

const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;


export function NoteEditor({ target, onClose, onSlideshow }: { target: EditorTarget | null; onClose: () => void; onSlideshow?: (note: Note) => void }) {
  const v = useVault();
  const { toast } = useToast();
  const open = !!target;
  const existing = target?.note;
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState<NoteData>(blank("text"));
  const [spaceId, setSpaceId] = useState("");
  const [boardId, setBoardId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<File[]>([]);
  const [batchStep, setBatchStep] = useState<{ i: number; n: number } | null>(null);
  const [extras, setExtras] = useState<File[]>([]); // extra files picked while editing an existing note
  const attachRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [textTab, setTextTab] = useState<"write" | "preview">("write");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!target) return;
    const incoming = !target.note ? target.files?.filter(Boolean) || [] : [];
    const firstType = incoming.length === 1 ? detectType(incoming[0]) : null;
    const base = target.note ? { ...blank(target.note.data.type), ...target.note.data } : { ...blank(firstType || target.type || "text"), ...target.prefill };
    setD(base);
    setSpaceId(target.note?.spaceId || target.spaceId);
    setBoardId(target.note ? target.note.boardId : target.boardId);
    setEditing(!target.note);
    setFile(null);
    setBatch([]);
    setExtras([]);
    setBatchStep(null);
    setPreview(null);
    setShowPw(false);
    if (incoming.length === 1) void pickFile(incoming[0], firstType!);
    else if (incoming.length > 1) void addToBatch(incoming, []);
    setTagDraft("");
    setTextTab("write");
  }, [target]);

  const space = v.spaces.find((s) => s.id === spaceId);
  const writable = canWrite(space?.role);
  const writableSpaces = v.spaces.filter((s) => canWrite(s.role));
  const spaceBoards = v.boards.filter((b) => b.spaceId === spaceId);
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    v.notes.forEach((n) => n.data.tags.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [v.notes]);
  const tagSuggestions = tagDraft ? allTags.filter((t) => t.startsWith(tagDraft.toLowerCase()) && !d.tags.includes(t)).slice(0, 5) : [];

  const set = <K extends keyof NoteData>(k: K, val: NoteData[K]) => setD((x) => ({ ...x, [k]: val }));
  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, "").toLowerCase();
    if (t && !d.tags.includes(t)) set("tags", [...d.tags, t]);
    setTagDraft("");
  };

  async function pickFile(f: File | null, type: NoteType = d.type) {
    if (!f) return;
    const limit = await getMaxUploadMb();
    if (f.size + 1024 > limit * 1024 * 1024) {
      toast({ title: "File too large", description: `This server accepts files up to ${limit} MB (set SCUTE_MAX_UPLOAD_MB to raise it).`, variant: "destructive" });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(f);
    const meta = { name: f.name, type: f.type || guessMime(f.name), size: f.size };
    if (type === "video" || (type === "file" && isVideoMime(meta.type))) {
      setPreview(null);
      setD((x) => ({ ...x, type: "video", file: meta, thumb: null, title: x.title || f.name.replace(/\.[^.]+$/, "") }));
      const p = await makeVideoPoster(f);
      setD((x) => ({ ...x, file: { ...meta, width: p?.width, height: p?.height, duration: p?.duration }, thumb: p?.thumb || null }));
      setPreview(p?.thumb || null);
      if (!p) toast({ title: "No preview available", description: "This browser can't decode that video, but it will still be stored encrypted." });
    } else if (isAudioMime(meta.type)) {
      const duration = await audioDuration(f);
      setD((x) => ({ ...x, file: { ...meta, duration }, title: x.title || f.name.replace(/\.[^.]+$/, "") }));
    } else if (type === "image" || f.type.startsWith("image/")) {
      const t = await makeThumb(f);
      setD((x) => ({ ...x, type: x.type === "file" && f.type.startsWith("image/") ? "image" : x.type, file: { ...meta, width: t?.width, height: t?.height }, thumb: t?.thumb || null, title: x.title || f.name.replace(/\.[^.]+$/, "") }));
      setPreview(t?.thumb || null);
    } else {
      setD((x) => ({ ...x, file: meta, title: x.title || f.name }));
    }
  }

  /** Handle one or many picked/dropped files. */
  async function pickFiles(list: File[]) {
    const fs = list.filter(Boolean);
    if (fs.length === 0) return;
    if (existing) {
      if (fs.length > 1) {
        const more = await filterSize(fs.slice(1), [...extras, fs[0]]);
        setExtras((x) => [...x, ...more]);
        if (more.length) toast({ title: `${more.length} more file${more.length > 1 ? "s" : ""} will become separate notes`, description: "The first file is attached to this note." });
      }
      return pickFile(fs[0]);
    }
    const current = batch.length ? batch : file ? [file] : [];
    if (current.length + fs.length === 1) return pickFile(fs[0]);
    return addToBatch(fs, current);
  }

  /** Drop duplicates and files over the server limit (with a toast). */
  async function filterSize(fs: File[], current: File[]) {
    const limit = await getMaxUploadMb();
    const seen = new Set(current.map(fileKey));
    const out: File[] = [];
    const tooBig: string[] = [];
    for (const f of fs) {
      if (seen.has(fileKey(f))) continue;
      if (f.size + 1024 > limit * 1024 * 1024) tooBig.push(f.name);
      else {
        seen.add(fileKey(f));
        out.push(f);
      }
    }
    if (tooBig.length) toast({ title: `Skipped ${tooBig.length} file${tooBig.length > 1 ? "s" : ""} over ${limit} MB`, description: tooBig.slice(0, 3).join(", ") + (tooBig.length > 3 ? "…" : ""), variant: "destructive" });
    return out;
  }

  async function addToBatch(fs: File[], current: File[]) {
    const limit = await getMaxUploadMb();
    const seen = new Set(current.map(fileKey));
    const tooBig: string[] = [];
    const next = [...current];
    for (const f of fs) {
      if (seen.has(fileKey(f))) continue;
      if (f.size + 1024 > limit * 1024 * 1024) {
        tooBig.push(f.name);
        continue;
      }
      seen.add(fileKey(f));
      next.push(f);
    }
    if (tooBig.length) toast({ title: `Skipped ${tooBig.length} file${tooBig.length > 1 ? "s" : ""} over ${limit} MB`, description: tooBig.slice(0, 3).join(", ") + (tooBig.length > 3 ? "…" : ""), variant: "destructive" });
    if (next.length === 1) {
      setBatch([]);
      return pickFile(next[0], detectType(next[0]));
    }
    if (next.length === 0) return;
    setBatch(next);
    setFile(null);
    setPreview(null);
    setD((x) => ({ ...x, type: HAS_FILE(x.type) ? x.type : "file", title: "", file: null, thumb: null }));
    if (fileRef.current) fileRef.current.value = "";
  }

  function removeFromBatch(k: string) {
    const next = batch.filter((f) => fileKey(f) !== k);
    if (next.length === 1) {
      setBatch([]);
      void pickFile(next[0], detectType(next[0]));
    } else setBatch(next);
  }

  /** Create one note per file, sharing the given text/tags/color. */
  async function uploadEach(list: File[], common: Pick<NoteData, "text" | "tags" | "color" | "pinned">) {
    const bId = spaceBoards.some((b) => b.id === boardId) ? boardId : null;
    const failed: File[] = [];
    let lastErr = "";
    let done = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setBatchStep({ i, n: list.length });
      try {
        const info = await describeFile(f);
        const now = Date.now();
        const data: NoteData = { ...blank(info.type), ...common, ...info, created: now, modified: now };
        await v.saveNote({ spaceId, boardId: bId, data, file: f });
        done++;
      } catch (e) {
        failed.push(f);
        lastErr = (e as Error).message;
      }
    }
    setBatchStep(null);
    return { done, failed, lastErr };
  }

  /** "Attach files" on an existing note: each file becomes a new note next to it. */
  async function attachFiles(list: File[]) {
    if (!space || list.length === 0) return;
    const fs = await filterSize(list, []);
    if (!fs.length) return;
    setBusy(true);
    const { done, failed, lastErr } = await uploadEach(fs, { text: "", tags: d.tags, color: d.color, pinned: false });
    setBusy(false);
    if (attachRef.current) attachRef.current.value = "";
    if (!failed.length) toast({ title: `Added ${done} note${done > 1 ? "s" : ""}`, description: "Each file was encrypted and saved as its own note with this note's tags and board." });
    else toast({ title: `${failed.length} of ${fs.length} uploads failed`, description: lastErr, variant: "destructive" });
  }

  async function saveBatch() {
    if (!space) return;
    setBusy(true);
    const tags = tagDraft.trim() ? [...new Set([...d.tags, tagDraft.trim().toLowerCase()])] : d.tags;
    const { done, failed, lastErr } = await uploadEach(batch, { text: d.text, tags, color: d.color, pinned: d.pinned });
    setBusy(false);
    if (!failed.length) {
      toast({ title: `Added ${done} notes`, description: "Each file was encrypted and uploaded as its own note." });
      onClose();
    } else {
      setBatch(failed);
      toast({
        title: `${failed.length} of ${failed.length + done} uploads failed`,
        description: `${lastErr}. The failed files are still listed so you can try again.`,
        variant: "destructive",
      });
    }
  }

  async function save() {
    if (!space) return;
    if (batch.length > 1) return saveBatch();
    if (HAS_FILE(d.type) && !file && !existing?.fileSize) {
      toast({ title: "Choose a file first" });
      return;
    }
    const url = d.url && !/^[a-z][a-z0-9+.-]*:/i.test(d.url.trim()) ? "https://" + d.url.trim() : d.url?.trim();
    setBusy(true);
    try {
      const data: NoteData = { ...d, url, tags: tagDraft.trim() ? [...new Set([...d.tags, tagDraft.trim().toLowerCase()])] : d.tags, modified: Date.now() };
      await v.saveNote({ id: existing?.id, spaceId, boardId: spaceBoards.some((b) => b.id === boardId) ? boardId : null, data, file });
      if (extras.length) {
        const r = await uploadEach(extras, { text: "", tags: data.tags, color: data.color, pinned: false });
        if (r.failed.length) {
          setExtras(r.failed);
          toast({ title: `Saved, but ${r.failed.length} extra file${r.failed.length > 1 ? "s" : ""} failed`, description: r.lastErr, variant: "destructive" });
          return;
        }
        toast({ title: "Saved", description: `Also added ${r.done} new note${r.done > 1 ? "s" : ""} from the other files.` });
      } else toast({ title: existing ? "Saved" : "Added", description: v.online ? "Encrypted and synced." : "Saved on this device. It will sync when you're back online." });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function setThumbFromFrame(thumb: string) {
    if (!existing) return;
    try {
      await v.saveNote({ id: existing.id, spaceId: existing.spaceId, boardId: existing.boardId, data: { ...existing.data, thumb } });
      setD((x) => ({ ...x, thumb }));
      toast({ title: "Thumbnail updated" });
    } catch (e) {
      toast({ title: "Couldn't update the thumbnail", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function togglePin() {
    if (!existing) return;
    try {
      await v.saveNote({ id: existing.id, spaceId: existing.spaceId, boardId: existing.boardId, data: { ...existing.data, pinned: !existing.data.pinned } });
      setD((x) => ({ ...x, pinned: !x.pinned }));
    } catch (e) {
      toast({ title: "Couldn't update", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function del() {
    if (!existing) return;
    await v.deleteNote(existing.id);
    setConfirmDel(false);
    onClose();
    toast({ title: "Deleted" });
  }

  async function download() {
    if (!existing) return;
    try {
      const url = await v.getFileUrl(existing);
      const a = document.createElement("a");
      a.href = url;
      a.download = existing.data.file?.name || "file";
      a.click();
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  const embed = !editing ? embedFor(d.url) || (d.type === "text" ? embedFor(d.text.match(/https?:\/\/\S+/)?.[0]) : null) : null;
  const TypeIcon = NOTE_TYPES.find((t) => t.type === d.type)?.icon;
  const typeLabel = NOTE_TYPES.find((t) => t.type === d.type)?.label || "Note";

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl max-h-[92dvh] overflow-y-auto p-0 gap-0" data-testid="dialog-note">
          <div className="h-1 w-full" style={{ background: colorSwatch(d.color) || "transparent" }} />
          <DialogHeader className="px-6 pt-5 pb-3 text-left">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {TypeIcon && <TypeIcon className="h-3.5 w-3.5" />}
              <span>{typeLabel}</span>
              {space && (
                <>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: space.data.color }} />
                    {space.data.title}
                  </span>
                </>
              )}
            </div>
            <DialogTitle className="text-lg font-semibold">
              {editing ? (existing ? "Edit " + typeLabel.toLowerCase() : batch.length > 1 ? `New notes from ${batch.length} files` : "New " + typeLabel.toLowerCase()) : d.title || hostOf(d.url) || d.file?.name || "Untitled"}
            </DialogTitle>
            <DialogDescription className="sr-only">Encrypted {typeLabel.toLowerCase()}</DialogDescription>
          </DialogHeader>

          {!editing && existing ? (
            <div className="px-6 pb-6 space-y-4">
              {d.type === "image" && <DecryptedImage note={existing} alt={d.title || "Image"} className="w-full rounded-md border bg-muted" />}
              {(d.type === "video" || (d.type === "file" && isVideoMime(d.file?.type))) && <VideoPlayer note={existing} onDownload={download} onSetThumb={writable ? setThumbFromFrame : undefined} />}
              {d.type === "file" && isAudioMime(d.file?.type) && <AudioPlayer note={existing} onDownload={download} />}
              {(d.type === "link" || d.type === "text") && embed && <EmbedPlayer key={d.url} embed={embed} />}
              {d.type === "link" && d.url && (
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline break-all" data-testid="link-open-url">
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  {d.url}
                </a>
              )}
              {d.type === "password" && (
                <div className="rounded-md border divide-y">
                  {d.username && (
                    <div className="flex items-center gap-3 px-3 py-2">
                      <span className="w-20 text-xs text-muted-foreground">Username</span>
                      <span className="flex-1 font-mono text-sm break-all">{d.username}</span>
                      <CopyButton value={d.username} label="username" testId="button-copy-username" />
                    </div>
                  )}
                  {d.password && (
                    <div className="flex items-center gap-3 px-3 py-2">
                      <span className="w-20 text-xs text-muted-foreground">Password</span>
                      <span className="flex-1 font-mono text-sm break-all" data-testid="text-password">
                        {showPw ? d.password : "••••••••••••"}
                      </span>
                      <button type="button" className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted" onClick={() => setShowPw(!showPw)} aria-label={showPw ? "Hide password" : "Show password"} data-testid="button-toggle-password">
                        {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <CopyButton value={d.password} label="password" testId="button-copy-password" />
                    </div>
                  )}
                  {d.url && (
                    <div className="flex items-center gap-3 px-3 py-2">
                      <span className="w-20 text-xs text-muted-foreground">Site</span>
                      <a href={d.url} target="_blank" rel="noopener noreferrer" className="flex-1 text-sm text-primary hover:underline truncate">
                        {hostOf(d.url)}
                      </a>
                    </div>
                  )}
                </div>
              )}
              {HAS_FILE(d.type) && d.file && (
                <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                  <span className="flex-1 truncate">{d.file.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {d.file.duration != null && `${fmtDuration(d.file.duration)} · `}
                    {fmtBytes(d.file.size)}
                  </span>
                  <Button size="sm" variant="outline" onClick={download} data-testid="button-download-file">
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                </div>
              )}
              {d.text ? <Markdown src={d.text} /> : null}
              {d.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {d.tags.map((t) => (
                    <span key={t} className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Edited {new Date(d.modified).toLocaleString()}
                {existing.boardId && ` · ${v.boards.find((b) => b.id === existing.boardId)?.data.title || ""}`}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t -mx-6 px-6 pt-4">
                {writable && (
                  <>
                    <Button onClick={() => setEditing(true)} data-testid="button-edit-note">
                      <Pencil className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button variant="outline" onClick={togglePin} data-testid="button-pin-note">
                      {d.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                      {d.pinned ? "Unpin" : "Pin"}
                    </Button>
                    {onSlideshow && isImageNote(d) && (
                      <Button variant="outline" onClick={() => onSlideshow(existing)} data-testid="button-note-slideshow">
                        <GalleryHorizontalEnd className="h-4 w-4" /> Slideshow
                      </Button>
                    )}
                    <input ref={attachRef} type="file" multiple className="hidden" onChange={(e) => void attachFiles(Array.from(e.target.files || []))} data-testid="input-attach-files" />
                    <Button variant="outline" onClick={() => attachRef.current?.click()} disabled={busy || !v.online} title="Each file becomes its own note with this note's tags and board" data-testid="button-attach-files">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      {busy && batchStep ? `Uploading ${batchStep.i + 1} of ${batchStep.n}…` : "Attach files"}
                    </Button>
                    <div className="flex-1" />
                    <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDel(true)} data-testid="button-delete-note">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </>
                )}
                {!writable && <p className="text-xs text-muted-foreground">You have read-only access to this space.</p>}
              </div>
            </div>
          ) : (
            <form
              className="px-6 pb-6 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {!existing && batch.length < 2 && (
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Type">
                  {NOTE_TYPES.map((t) => (
                    <button
                      key={t.type}
                      type="button"
                      role="radio"
                      aria-checked={d.type === t.type}
                      onClick={() => set("type", t.type)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${d.type === t.type ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                      data-testid={`button-type-${t.type}`}
                    >
                      <t.icon className="h-3.5 w-3.5" />
                      {t.label}
                    </button>
                  ))}
                </div>
              )}

              {(d.type === "link" || d.type === "password") && (
                <div className="space-y-1.5">
                  <Label htmlFor="n-url">{d.type === "link" ? "URL" : "Website"}</Label>
                  <Input id="n-url" type="text" inputMode="url" placeholder="https://" value={d.url || ""} onChange={(e) => set("url", e.target.value)} autoFocus={d.type === "link"} data-testid="input-note-url" />
                </div>
              )}

              {batch.length < 2 && <div className="space-y-1.5">
                <Label htmlFor="n-title">Title</Label>
                <Input id="n-title" value={d.title} onChange={(e) => set("title", e.target.value)} autoFocus={d.type === "text"} data-testid="input-note-title" />
              </div>}

              {d.type === "password" && (
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="n-user">Username</Label>
                    <Input id="n-user" autoComplete="off" value={d.username || ""} onChange={(e) => set("username", e.target.value)} className="font-mono" data-testid="input-note-username" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="n-pass">Password</Label>
                    <div className="flex gap-1">
                      <Input id="n-pass" type={showPw ? "text" : "password"} autoComplete="new-password" value={d.password || ""} onChange={(e) => set("password", e.target.value)} className="font-mono" data-testid="input-note-password" />
                      <Button type="button" size="icon" variant="outline" onClick={() => setShowPw(!showPw)} aria-label="Toggle visibility">
                        {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        onClick={() => {
                          set("password", genPassword());
                          setShowPw(true);
                        }}
                        aria-label="Generate password"
                        title="Generate a strong password"
                        data-testid="button-generate-password"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {batch.length > 1 && (
                <div className="space-y-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy) void pickFiles(Array.from(e.dataTransfer.files || [])); }}>
                  <input ref={fileRef} type="file" className="hidden" multiple onChange={(e) => void pickFiles(Array.from(e.target.files || []))} data-testid="input-note-file" />
                  <div className="flex items-baseline justify-between gap-2">
                    <Label>{batch.length} attachments</Label>
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtBytes(batch.reduce((a, f) => a + f.size, 0))} total</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Each file becomes its own note, titled after the file. The notes, tags, board and color below are applied to all of them.</p>
                  <ul className="max-h-64 overflow-y-auto rounded-md border divide-y" data-testid="list-batch">
                    {batch.map((f, i) => {
                      const T = isAudioMime(f.type || guessMime(f.name)) ? Music : NOTE_TYPES.find((t) => t.type === detectType(f))?.icon || Upload;
                      const state = !batchStep ? null : i < batchStep.i ? "done" : i === batchStep.i ? "active" : "waiting";
                      return (
                        <li key={fileKey(f)} className="flex items-center gap-2 px-3 py-2 text-sm" data-testid={`row-batch-${i}`}>
                          <T className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate">{f.name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>
                          {state === "done" ? (
                            <Check className="h-4 w-4 text-primary" aria-label="Uploaded" />
                          ) : state === "active" ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Uploading" />
                          ) : state === "waiting" ? (
                            <span className="h-4 w-4" />
                          ) : (
                            <button type="button" onClick={() => removeFromBatch(fileKey(f))} className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted" aria-label={`Remove ${f.name}`} data-testid={`button-remove-batch-${i}`}>
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="button-add-more-files">
                    <Plus className="h-3.5 w-3.5" /> Add more files
                  </Button>
                  {!v.online && <p className="text-xs text-muted-foreground">Uploading attachments needs a connection.</p>}
                </div>
              )}

              {HAS_FILE(d.type) && batch.length < 2 && (
                <div className="space-y-1.5">
                  <Label>{d.type === "image" ? "Image" : d.type === "video" ? "Video" : "File"}</Label>
                  <input ref={fileRef} type="file" className="hidden" accept={d.type === "image" ? "image/*" : d.type === "video" ? "video/*,.mkv,.mov,.m4v" : undefined} multiple onChange={(e) => void pickFiles(Array.from(e.target.files || []))} data-testid="input-note-file" />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void pickFiles(Array.from(e.dataTransfer.files || []));
                    }}
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed p-5 text-sm text-muted-foreground hover:bg-muted/60"
                    data-testid="button-pick-file"
                  >
                    {preview || ((d.type === "image" || d.type === "video") && d.thumb) ? (
                      <img src={preview || d.thumb || ""} alt="" className="max-h-48 rounded" />
                    ) : (
                      <Upload className="h-5 w-5" />
                    )}
                    <span>
                      {d.file
                        ? `${d.file.name} · ${d.file.duration != null ? fmtDuration(d.file.duration) + " · " : ""}${fmtBytes(d.file.size)}`
                        : d.type === "video"
                          ? "Choose or drop a video (MP4 or WebM plays everywhere). It's encrypted before upload."
                          : "Choose or drop files. Each one is encrypted before upload; several files become several notes."}
                    </span>
                  </button>
                  {!v.online && <p className="text-xs text-muted-foreground">Uploading attachments needs a connection.</p>}
                  {extras.length > 0 && (
                    <div className="rounded-md border" data-testid="list-extras">
                      <p className="px-3 pt-2 text-xs text-muted-foreground">Also adding as separate notes ({extras.length}):</p>
                      <ul className="divide-y">
                        {extras.map((f, i) => (
                          <li key={fileKey(f)} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                            <span className="flex-1 truncate">{f.name}</span>
                            <span className="text-xs text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>
                            {batchStep ? (
                              i < batchStep.i ? <Check className="h-4 w-4 text-primary" /> : i === batchStep.i ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="h-4 w-4" />
                            ) : (
                              <button type="button" onClick={() => setExtras((x) => x.filter((y) => y !== f))} className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted" aria-label={`Remove ${f.name}`}>
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="n-text">{batch.length > 1 ? "Notes (added to each)" : d.type === "text" ? "Note" : "Notes"}</Label>
                  <div className="flex text-xs rounded-md border overflow-hidden">
                    {(["write", "preview"] as const).map((t) => (
                      <button key={t} type="button" onClick={() => setTextTab(t)} className={`px-2 py-0.5 capitalize ${textTab === t ? "bg-muted font-medium" : "text-muted-foreground"}`} data-testid={`button-text-${t}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                {textTab === "write" ? (
                  <Textarea id="n-text" rows={d.type === "text" ? 10 : 4} value={d.text} onChange={(e) => set("text", e.target.value)} placeholder="Markdown supported: **bold**, - [ ] checklists, `code`, links…" className="font-[inherit] text-sm leading-relaxed" data-testid="input-note-text" />
                ) : (
                  <div className="min-h-24 rounded-md border px-3 py-2">{d.text ? <Markdown src={d.text} /> : <p className="text-sm text-muted-foreground">Nothing to preview</p>}</div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="n-tags">Tags</Label>
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
                  {d.tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                      #{t}
                      <button type="button" onClick={() => set("tags", d.tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    id="n-tags"
                    className="flex-1 min-w-24 bg-transparent text-sm outline-none py-0.5"
                    placeholder={d.tags.length ? "" : "Add tags, press Enter"}
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value.replace(",", ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addTag(tagDraft);
                      } else if (e.key === "Backspace" && !tagDraft && d.tags.length) set("tags", d.tags.slice(0, -1));
                    }}
                    data-testid="input-note-tags"
                  />
                </div>
                {tagSuggestions.length > 0 && (
                  <div className="flex gap-1.5">
                    {tagSuggestions.map((t) => (
                      <button key={t} type="button" onClick={() => addTag(t)} className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted">
                        #{t}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Space</Label>
                  <Select value={spaceId} onValueChange={(s) => { setSpaceId(s); setBoardId(null); }}>
                    <SelectTrigger data-testid="select-note-space">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {writableSpaces.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.data.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Board</Label>
                  <Select value={boardId || "none"} onValueChange={(b) => setBoardId(b === "none" ? null : b)}>
                    <SelectTrigger data-testid="select-note-board">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No board</SelectItem>
                      {spaceBoards.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.data.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Color</Label>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => set("color", null)} className={`h-7 w-7 rounded-full border-2 bg-card ${!d.color ? "border-foreground" : "border-border"}`} aria-label="No color" data-testid="button-color-none" />
                  {NOTE_COLORS.map((c) => (
                    <button key={c.id} type="button" onClick={() => set("color", c.id)} className={`h-7 w-7 rounded-full border-2 ${d.color === c.id ? "border-foreground" : "border-transparent"}`} style={{ background: c.swatch }} aria-label={c.label} title={c.label} data-testid={`button-color-${c.id}`} />
                  ))}
                </div>
              </div>

              <DialogFooter className="gap-2 sm:gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => (existing ? setEditing(false) : onClose())} data-testid="button-cancel-note">
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !writable} data-testid="button-save-note">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? (batchStep ? `Uploading ${batchStep.i + 1} of ${batchStep.n}…` : "Encrypting…") : batch.length > 1 ? `Add ${batch.length} notes` : "Save"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {typeLabel.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>It will be removed from every device that shares this space. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={del} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-delete">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
