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
import { isImageNote, audioDuration, describeFile, detectType, embedFor, fmtDuration, guessMime, isAudioMime, isVideoMime, makeThumb, makeVideoPoster } from "@/lib/media";
import { api } from "@/lib/api";
import { hexOf, resourceFile } from "@/lib/joplin";
import { joplinRefs } from "@/lib/markdown";
import { PluginNoteActions } from "@/components/plugin-ui";
import { afterBookmarkSave, ARCHIVE_PREF, archivePref, BookmarkView, DuplicateWarning } from "@/components/bookmarks";
import { buildPreview, canArchive, urlKey, webEnabled, type LinkPreview } from "@/lib/web";

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

/**
 * Move a note out of a Joplin space. Its photos and files live on the Joplin Server
 * (":/<resource id>" links), so they're copied into Scute first:
 *  - a note that is just one attachment (a photo note from Joplin mobile, say) becomes
 *    an image/video/file note with that attachment;
 *  - otherwise each attachment becomes its own note next to it, and the links in the
 *    text point at those notes, so the pictures still show inline.
 * The note gets a new id and the old one is deleted, so the next Joplin sync moves it to
 * Joplin's trash instead of leaving a copy behind (Scute ids double as Joplin ids).
 */
/** Connection settings of every Joplin space this user can see (for notes moved out earlier). */
function joplinConfigs(v: ReturnType<typeof useVault>) {
  if (!v.extras.includes("joplin")) return [];
  return v.spaces.filter((s) => s.data.kind === "joplin" && s.data.joplin?.url && s.data.joplin.email && s.data.joplin.password).map((s) => s.data.joplin!);
}

/** Joplin attachment links in a note outside Joplin spaces that nothing in Scute answers. */
function strandedRefs(v: ReturnType<typeof useVault>, n: Note | undefined) {
  if (!n || n.data.type !== "text" || !n.data.text) return [];
  if (v.spaces.find((s) => s.id === n.spaceId)?.data.kind === "joplin") return [];
  const local = new Set(v.notes.map((x) => hexOf(x.id)));
  return joplinRefs(n.data.text).filter((r) => !local.has(r.id));
}

export async function moveFromJoplin(
  v: ReturnType<typeof useVault>,
  existing: Note,
  to: { spaceId: string; boardId: string | null },
  input: NoteData,
  picked: File | null,
  keepId = false, // repair a note that was moved before attachments were copied
): Promise<{ id: string; copied: number; missing: string[] }> {
  const from = v.spaces.find((s) => s.id === existing.spaceId);
  const cfgs = keepId ? joplinConfigs(v) : from?.data.joplin ? [from.data.joplin] : [];
  const data: NoteData = { ...input };
  delete data.joplin;
  // the note's own Scute attachment (image/video/file notes, saved bookmark copies)
  let own: File | null = picked;
  if (!own && !keepId && existing.fileSize && data.file) own = new File([await v.fileBlob(existing)], data.file.name, { type: data.file.type });
  const noteIds = new Set(v.notes.filter((n) => (keepId ? true : n.spaceId === existing.spaceId)).map((n) => hexOf(n.id)));
  const refs = joplinRefs(data.text || "").filter((r) => r.id !== existing.data.joplin?.resId && !noteIds.has(r.id)); // skip links to other notes
  const files = new Map<string, File>();
  const missing: string[] = [];
  for (const r of refs) {
    if (!cfgs.length) throw new Error(keepId ? "None of your Joplin spaces is connected to a Joplin Server." : `Connect “${from?.data.title || "the Joplin space"}” to its Joplin Server first, so its attachments can be copied.`);
    try {
      let got: File | null = null, err: unknown = null;
      for (const cfg of cfgs) {
        try {
          got = await resourceFile(cfg, r.id);
          break;
        } catch (e) {
          if (!err || (err as { status?: number }).status === 404) err = e;
        }
      }
      if (!got) throw err;
      files.set(r.id, got);
    } catch (e) {
      // not on the server (never uploaded): nothing to copy. Anything else: stop, move nothing.
      if ((e as { status?: number }).status === 404) missing.push(r.name || r.id);
      else throw new Error(`Couldn't copy the attachment “${r.name || r.id}” from Joplin: ${(e as Error).message}. The note wasn't moved.`);
    }
  }
  const text = data.text || "";
  const refRe = (id: string) => new RegExp(`:\\/${id}`, "gi");
  const found = [...files.keys()];
  const only = !own && data.type === "text" && found.length === 1 && refs.length === 1;
  let stripped = "";
  if (only) {
    const id = found[0];
    stripped = text
      .replace(new RegExp(`!?\\[[^\\]]*\\]\\(\\s*<?:\\/${id}[^)]*\\)`, "gi"), "")
      .replace(new RegExp(`<img\\b[^>]*?\\bsrc\\s*=\\s*["']:\\/${id}[^>]*>`, "gi"), "")
      .replace(new RegExp(`<a\\b[^>]*?\\bhref\\s*=\\s*["']:\\/${id}[^>]*>[^<]*<\\/a>`, "gi"), "")
      .trim();
  }
  const newId = keepId ? existing.id : crypto.randomUUID();
  if (only && !/:\/[0-9a-fA-F]{32}/.test(stripped)) {
    // the note is the attachment: keep it as one image/video/file note
    const f = files.get(found[0])!;
    const info = await describeFile(f);
    await v.saveNote({ id: newId, spaceId: to.spaceId, boardId: to.boardId, data: { ...data, ...info, title: data.title || info.title, text: stripped }, file: f });
  } else {
    let out = text;
    for (const [rid, f] of files) {
      const info = await describeFile(f);
      const now = Date.now();
      const aid = crypto.randomUUID();
      await v.saveNote({ id: aid, spaceId: to.spaceId, boardId: to.boardId, data: { ...blank(info.type), ...info, tags: data.tags, created: now, modified: now }, file: f });
      out = out.replace(refRe(rid), `:/${hexOf(aid)}`);
    }
    await v.saveNote({ id: newId, spaceId: to.spaceId, boardId: to.boardId, data: { ...data, text: out }, file: own });
  }
  if (!keepId) await v.deleteNote(existing.id);
  return { id: newId, copied: files.size, missing };
}

const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;


export function NoteEditor({ target, onClose, onSlideshow, onOpenNote }: { target: EditorTarget | null; onClose: () => void; onSlideshow?: (note: Note) => void; onOpenNote?: (note: Note) => void }) {
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

  // bookmarks: live preview while typing the URL, and the "save a copy" option
  const [saveCopy, setSaveCopy] = useState(archivePref);
  const [lp, setLp] = useState<(LinkPreview & { thumb: string | null; forUrl: string }) | null>(null);
  const [lpBusy, setLpBusy] = useState(false);
  const [webOn, setWebOn] = useState(false);
  const titleTouched = useRef(false);
  useEffect(() => {
    void webEnabled().then(setWebOn);
  }, []);
  useEffect(() => {
    setLp(null);
    titleTouched.current = false;
  }, [target]);
  const normUrl = (u?: string) => (u && !/^[a-z][a-z0-9+.-]*:/i.test(u.trim()) ? "https://" + u.trim() : u?.trim() || "");
  useEffect(() => {
    if (!editing || d.type !== "link" || !webOn || !v.online) return;
    const u = normUrl(d.url);
    if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(u) || lp?.forUrl === u) return;
    if (existing && urlKey(existing.data.url) === urlKey(u) && existing.data.preview) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setLpBusy(true);
      buildPreview(u, ac.signal)
        .then((p) => {
          setLp({ ...p, forUrl: u });
          if (p.title && !titleTouched.current) setD((x) => (x.title ? x : { ...x, title: p.title! }));
        })
        .catch(() => undefined)
        .finally(() => !ac.signal.aborted && setLpBusy(false));
    }, 700);
    return () => {
      clearTimeout(t);
      ac.abort();
      setLpBusy(false);
    };
  }, [d.url, d.type, editing, webOn, v.online]); // eslint-disable-line
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
      let data: NoteData = { ...d, url, tags: tagDraft.trim() ? [...new Set([...d.tags, tagDraft.trim().toLowerCase()])] : d.tags, modified: Date.now() };
      let bm: { preview: boolean; archive: boolean } | null = null;
      if (data.type === "link") {
        // a copy may have been saved in the background while this was open
        const cur = existing ? v.notes.find((n) => n.id === existing.id)?.data : undefined;
        const same = !!existing && urlKey(existing.data.url) === urlKey(url);
        data = { ...data, file: cur?.file ?? data.file, archive: cur?.archive ?? data.archive };
        if (lp && lp.forUrl === url) data = { ...data, thumb: lp.thumb || null, preview: { kind: lp.kind, site: lp.site, description: lp.description, image: lp.image, checked: Date.now() } };
        else if (same) data = { ...data, thumb: cur?.thumb ?? data.thumb, preview: cur?.preview ?? data.preview };
        else data = { ...data, thumb: null, preview: undefined };
        bm = { preview: !data.preview, archive: webOn && saveCopy && (!same || !data.archive) };
      }
      const toBoard = spaceBoards.some((b) => b.id === boardId) ? boardId : null;
      const fromJoplin = !!existing && existing.spaceId !== spaceId && v.spaces.find((s) => s.id === existing.spaceId)?.data.kind === "joplin";
      let moved: Awaited<ReturnType<typeof moveFromJoplin>> | null = null;
      if (existing && existing.spaceId !== spaceId) delete data.joplin; // new to the target space (and to its Joplin account, if any)
      if (fromJoplin) moved = await moveFromJoplin(v, existing!, { spaceId, boardId: toBoard }, data, file);
      const savedId = moved ? moved.id : await v.saveNote({ id: existing?.id, spaceId, boardId: toBoard, data, file });
      if (moved && !extras.length) {
        toast({
          title: "Moved",
          description:
            (moved.copied ? `Copied ${moved.copied} attachment${moved.copied > 1 ? "s" : ""} from Joplin. ` : "") +
            (moved.missing.length ? `${moved.missing.length} attachment${moved.missing.length > 1 ? "s weren't" : " wasn't"} on the Joplin Server (${moved.missing.slice(0, 3).join(", ")}). ` : "") +
            "The next Joplin sync moves the old copy to Joplin's trash.",
        });
        onClose();
        return;
      }
      if (bm && (bm.preview || bm.archive) && webOn) afterBookmarkSave(savedId, bm);
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

  const stranded = useMemo(() => strandedRefs(v, existing ? v.notes.find((n) => n.id === existing.id) || existing : undefined), [v.notes, v.spaces, existing]); // eslint-disable-line

  async function repairStranded() {
    const cur = existing && (v.notes.find((n) => n.id === existing.id) || existing);
    if (!cur) return;
    setBusy(true);
    try {
      const r = await moveFromJoplin(v, cur, { spaceId: cur.spaceId, boardId: cur.boardId }, { ...cur.data, modified: Date.now() }, null, true);
      toast({
        title: r.copied ? `Copied ${r.copied} attachment${r.copied > 1 ? "s" : ""} into Scute` : "Nothing copied",
        description: r.missing.length ? `Not found on your Joplin Server${r.missing.length > 1 ? "s" : ""}: ${r.missing.slice(0, 3).join(", ")}` : undefined,
        variant: r.copied ? undefined : "destructive",
      });
      if (r.copied) onClose();
    } catch (e) {
      toast({ title: "Couldn't copy the attachments", description: (e as Error).message, variant: "destructive" });
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
              {d.type === "text" && embed && <EmbedPlayer key={d.url} embed={embed} />}
              {d.type === "link" && <BookmarkView noteId={existing.id} writable={writable} />}
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
              {d.text ? <Markdown src={d.text} noteId={existing.id} /> : null}
              {writable && stranded.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" role="status" data-testid="banner-joplin-stranded">
                  <span className="flex-1 min-w-48">
                    {stranded.length === 1 ? "An attachment in this note is" : `${stranded.length} attachments in this note are`} still on a Joplin Server. Copy {stranded.length === 1 ? "it" : "them"} into Scute so {stranded.length === 1 ? "it stays" : "they stay"} with the note.
                  </span>
                  <Button size="sm" variant="outline" onClick={repairStranded} disabled={busy} data-testid="button-copy-joplin-attachments">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    Copy into Scute
                  </Button>
                </div>
              )}
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
                    <PluginNoteActions note={existing} />
                    <div className="flex-1" />
                    <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDel(true)} data-testid="button-delete-note">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </>
                )}
                {!writable && (
                  <>
                    <PluginNoteActions note={existing} />
                    <p className="text-xs text-muted-foreground">You have read-only access to this space.</p>
                  </>
                )}
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
                  {d.type === "link" && (
                    <>
                      <DuplicateWarning
                        url={normUrl(d.url)}
                        exceptId={existing?.id}
                        onOpen={
                          onOpenNote
                            ? (n) => {
                                onClose();
                                setTimeout(() => onOpenNote(n), 0);
                              }
                            : undefined
                        }
                      />
                      {(lpBusy || (lp && lp.forUrl === normUrl(d.url))) && (
                        <div className="flex items-center gap-2.5 rounded-md border px-2 py-1.5 text-xs" data-testid="panel-link-preview">
                          {lpBusy ? (
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking up the link…
                            </span>
                          ) : (
                            lp && (
                              <>
                                {lp.thumb ? <img src={lp.thumb} alt="" className="h-10 w-14 shrink-0 rounded object-cover bg-muted" /> : null}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium">{lp.title || lp.url}</span>
                                  <span className="block truncate text-muted-foreground" data-testid="text-link-kind">
                                    {{ page: "Web page", image: "Image", video: "Video", audio: "Audio", file: "File" }[lp.kind]}
                                    {lp.site ? ` · ${lp.site}` : ""}
                                  </span>
                                </span>
                              </>
                            )
                          )}
                        </div>
                      )}
                      {webOn && canArchive(normUrl(d.url) || "https://x.invalid/") && (
                        <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-sm">
                          <input
                            type="checkbox"
                            checked={saveCopy}
                            onChange={(e) => {
                              setSaveCopy(e.target.checked);
                              localStorage.setItem(ARCHIVE_PREF, e.target.checked ? "on" : "off");
                            }}
                            className="h-4 w-4 accent-[hsl(var(--primary))]"
                            data-testid="checkbox-save-copy"
                          />
                          {existing?.data.archive ? "Save a fresh copy if the URL changes" : `Save a copy of the ${{ page: "page", image: "image", video: "video", audio: "audio", file: "file" }[(lp && lp.forUrl === normUrl(d.url) && lp.kind) || existing?.data.preview?.kind || "page"]}`}
                          <span className="text-xs text-muted-foreground">(encrypted, kept even if the site disappears)</span>
                        </label>
                      )}
                    </>
                  )}
                </div>
              )}

              {batch.length < 2 && <div className="space-y-1.5">
                <Label htmlFor="n-title">Title</Label>
                <Input id="n-title" value={d.title} onChange={(e) => ((titleTouched.current = true), set("title", e.target.value))} autoFocus={d.type === "text"} data-testid="input-note-title" />
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
