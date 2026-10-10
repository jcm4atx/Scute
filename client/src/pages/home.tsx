import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import type { NoteType } from "@shared/schema";
import { canManage, canWrite, useVault, type Note } from "@/lib/vault";
import { idbGet, idbSet } from "@/lib/idb";
import { useTheme } from "@/lib/theme";
import { LogoMark } from "@/components/logo";
import { NoteCard, NOTE_TYPES } from "@/components/note-parts";
import { NoteEditor, type EditorTarget } from "@/components/note-editor";
import { SettingsDialog, SpaceDialog } from "@/components/dialogs";
import { JoplinBar, JoplinDialog, useJoplinResolver } from "@/components/joplin";
import { fetchResource } from "@/lib/joplin";
import { ResourceContext, type ResourceResolver } from "@/components/note-parts";
import {
  ArrowDownUp,
  Check,
  ChevronsUpDown,
  Cloud,
  CloudOff,
  Hash,
  LayoutGrid,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Users,
  X,
  Folder,
  FolderPlus,
  Globe2,
  Upload,
  GalleryHorizontalEnd,
  NotebookPen,
  Star,
} from "lucide-react";
import { Slideshow } from "@/components/slideshow";
import { BookmarkRuntime, BookmarkToolsDialog } from "@/components/bookmarks";
import { Bookmark } from "lucide-react";
import { isImageNote } from "@/lib/media";
import { emitPluginEvent, noteTypeOf, PluginIcon, PluginViewHost, runGuarded, setPluginBridge, toPlain, usePluginLoader, usePlugins, type Ctx, type MenuItem } from "@/lib/plugins";
import { PluginCommandsMenu, PluginDialogHost } from "@/components/plugin-ui";
import { Puzzle } from "lucide-react";
import { Eye, EyeOff } from "lucide-react";
import { RevealDialog } from "@/components/hidden-spaces";
import { DeleteNotesDialog, MoveDialog, NOTE_DRAG, SelectionBar, moveNotes, moveSummary } from "@/components/bulk";
import { CheckSquare } from "lucide-react";

type Sort = "modified" | "created" | "title";

const WELCOME = `Everything here is encrypted in your browser before it's sent to your server.

**Try it out**
- [ ] Add a bookmark, password, image or file with **New**
- [ ] Make a board to group related notes
- [ ] Invite someone to a space from **Space settings**
- [ ] Install Scute as an app from your browser menu

Notes support *Markdown*, including \`code\`, tables and checklists. Press **/** to search and **N** for a new note.`;

function parseRoute(loc: string) {
  const m = loc.match(/^\/s\/([0-9a-f-]{36})(?:\/b\/([0-9a-f-]{36}))?/i);
  return { spaceId: m?.[1] || null, boardId: m?.[2] || null };
}

function relTime(t: number | null) {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const v = useVault();
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();
  const [loc, navigate] = useLocation();
  const route = parseRoute(loc);
  const [lastSpace, setLastSpace] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [allSpaces, setAllSpaces] = useState(false);
  const [typeFilter, setTypeFilter] = useState<NoteType | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("modified");
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [ptab, setPtab] = useState<{ spaceId: string; tab: string } | null>(null); // plug-in space kind tab
  const [spaceDlg, setSpaceDlg] = useState<{ open: boolean; create: boolean }>({ open: false, create: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  /** Selected note ids; null when not selecting. */
  const [sel, setSel] = useState<Set<string> | null>(null);
  const selAnchor = useRef<string | null>(null);
  const [moving, setMoving] = useState<Note[] | null>(null);
  const [deleting, setDeleting] = useState<Note[] | null>(null);
  const [dropBoard, setDropBoard] = useState<string | null>(null); // board (or "__all") a drag is over
  const joplinPrompted = useRef<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [newBoard, setNewBoard] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [, tick] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const onboarded = useRef(false);
  const intentHandled = useRef(false);

  useEffect(() => {
    idbGet<string>(`u:${v.user?.id}:lastSpace`).then((s) => s && setLastSpace(s));
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, [v.user?.id]);

  const space =
    v.spaces.find((s) => s.id === route.spaceId) ||
    v.spaces.find((s) => s.id === v.settings.defaultSpaceId) ||
    v.spaces.find((s) => s.id === lastSpace) ||
    v.spaces[0] ||
    null;
  // hidden spaces: step out of one that was just hidden, and Ctrl+Alt+H to show or hide them
  const hiddenIds = v.settings.hiddenSpaces || [];
  const hiddenAway = hiddenIds.some((id) => !v.spaces.some((s) => s.id === id));
  useEffect(() => {
    if (route.spaceId && !v.spaces.some((s) => s.id === route.spaceId) && v.allSpaces.some((s) => s.id === route.spaceId)) navigate("/", { replace: true });
  }, [route.spaceId, v.spaces]); // eslint-disable-line
  useEffect(() => {
    if (editor?.note && hiddenIds.includes(editor.note.spaceId) && !v.spaces.some((s) => s.id === editor.note!.spaceId)) setEditor(null);
  }, [v.spaces]); // eslint-disable-line
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === "KeyH")) return;
      e.preventDefault();
      if (v.revealed) v.conceal();
      else if (hiddenAway) setRevealOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [v.revealed, v.conceal, hiddenAway]);
  const board = route.boardId ? v.boards.find((b) => b.id === route.boardId) || null : null;
  const writable = canWrite(space?.role);
  const kind = space?.data.kind || "notes";
  // ---------- plug-ins ----------
  usePluginLoader();
  const plugins = usePlugins();
  const pk = kind !== "notes" ? plugins.reg.spaceKinds.find((k) => k.id === kind) || null : null; // plug-in space kind
  const full = pk?.layout === "full";
  const tabId = pk?.tabs?.length ? (ptab && ptab.spaceId === space?.id && pk.tabs.some((t) => t.id === ptab.tab) ? ptab.tab : pk.tabs[0].id) : null;
  const curTab = pk?.tabs?.find((t) => t.id === tabId) || null;
  const tabView = useMemo(() => (pk && curTab?.mount ? { id: curTab.id, title: curTab.title, mount: curTab.mount, pluginId: pk.pluginId, uid: `${pk.uid}:${curTab.id}` } : null), [pk, curTab]);
  const fullView = useMemo(() => (pk && full && pk.mount ? { id: pk.id, title: pk.title, mount: pk.mount, pluginId: pk.pluginId, uid: pk.uid } : null), [pk, full]);
  const joplin = kind === "joplin" && v.extras.includes("joplin");
  const [joplinDlg, setJoplinDlg] = useState(false);
  const [bmTools, setBmTools] = useState(false);
  const joplinResolver = useJoplinResolver(space, joplin);
  // ":/<id>" links can also point at another Scute note's attachment (a note with several
  // photos moved out of a Joplin space keeps them as notes of their own).
  const notesRef = useRef(v.notes);
  notesRef.current = v.notes;
  const resolver = useMemo<ResourceResolver>(
    () => async (rid: string) => {
      const h = rid.toLowerCase();
      const n = notesRef.current.find((x) => x.fileSize && x.data.file && x.id.replace(/-/g, "") === h);
      if (n) return { url: await v.getFileUrl(n), mime: n.data.file!.type || "application/octet-stream", name: n.data.file!.name };
      if (joplinResolver) return joplinResolver(rid);
      // a note moved out of a Joplin space before its attachments were copied: try the Joplin spaces
      const cfgs = v.extras.includes("joplin") ? v.spaces.filter((s) => s.data.kind === "joplin" && s.data.joplin?.url && s.data.joplin.email && s.data.joplin.password).map((s) => s.data.joplin!) : [];
      for (const c of cfgs) {
        try {
          return await fetchResource(c, rid);
        } catch {
          /* try the next one */
        }
      }
      throw new Error(cfgs.length ? "it isn't on your Joplin Servers" : "the attachment isn't in this space");
    },
    [joplinResolver, v.spaces, v.extras], // eslint-disable-line
  );
  const openNote = (n: Note) => {
    const pt = noteTypeOf(n.data.type);
    if (pt?.open) pt.open(toPlain(n, pt.pluginId), { ...pctx.current, spaceId: n.spaceId });
    else setEditor({ note: n, spaceId: n.spaceId, boardId: n.boardId });
  };
  const [pview, setPview] = useState<{ pluginId: string; viewId: string } | null>(null);
  const activeView = pview ? plugins.reg.views.find((x) => x.pluginId === pview.pluginId && x.id === pview.viewId) || null : null;
  const pctx = useRef<Ctx>({ spaceId: null, boardId: null, noteId: null });
  pctx.current = { spaceId: space?.id || null, boardId: board?.id || null, noteId: editor?.note?.id || null };
  const vNotes = useRef(v.notes);
  vNotes.current = v.notes;
  setPluginBridge({
    ctx: () => ({ ...pctx.current }),
    openNote: (id) => {
      const n = vNotes.current.find((x) => x.id === id);
      if (!n) return toast({ title: "That note isn't here yet", description: "It may still be syncing.", variant: "destructive" });
      if (n.spaceId !== pctx.current.spaceId) navigate(`/s/${n.spaceId}`);
      openNote(n);
    },
    openView: (pluginId, viewId) => {
      setPview({ pluginId, viewId });
      setNavOpen(false);
      setEditor(null); // a note action that opens a view (Share to Fediverse) shouldn't leave the note on top
    },
    openSpace: (spaceId, tab) => {
      // No membership check here: a space a plug-in just created may not be in
      // this render's list yet. Unknown ids fall back like any other bad URL.
      if (typeof spaceId !== "string" || !/^[0-9a-f-]{36}$/i.test(spaceId)) return;
      go(spaceId);
      if (tab) setPtab({ spaceId, tab });
    },
  });
  useEffect(() => {
    if (editor?.note) emitPluginEvent("note:open", toPlain(editor.note));
  }, [editor?.note?.id]); // eslint-disable-line
  useEffect(() => {
    if (space) emitPluginEvent("space:change", { id: space.id, title: space.data.title });
  }, [space?.id, plugins.rev > 0]); // eslint-disable-line
  const useTemplate = async (t: (typeof plugins.reg.templates)[number]) => {
    if (!space) return;
    const ctx = { ...pctx.current };
    const out = await Promise.resolve(runGuarded(t.pluginId, `template "${t.title}"`, () => t.create(ctx)) as any).catch(() => null);
    if (!out) return;
    const prefill: Record<string, unknown> = {};
    for (const k of ["title", "text", "url", "tags", "color", "pinned"]) if (out[k] !== undefined) prefill[k] = out[k];
    if (out.data !== undefined) prefill.ext = { [t.pluginId]: out.data };
    setEditor({ type: out.type === "link" ? "link" : "text", spaceId: space.id, boardId: out.boardId !== undefined ? out.boardId : board?.id || null, prefill: prefill as any });
  };
  const templateItems = (suffix: string) =>
    plugins.reg.templates.length > 0 && (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Templates</DropdownMenuLabel>
        {plugins.reg.templates.map((t) => (
          <DropdownMenuItem key={t.uid} onClick={() => void useTemplate(t)} data-testid={`menu-template-${t.pluginId}-${t.id}${suffix}`}>
            <Puzzle className="h-4 w-4" /> {t.title}
          </DropdownMenuItem>
        ))}
      </>
    );

  useEffect(() => {
    if (space && v.user) void idbSet(`u:${v.user.id}:lastSpace`, space.id);
  }, [space?.id]); // eslint-disable-line

  // first run: make a Personal space with a welcome note
  useEffect(() => {
    if (!v.firstSyncDone || onboarded.current) return;
    onboarded.current = true;
    if (v.spaces.length === 0 && v.invites.length === 0) {
      (async () => {
        const id = await v.createSpace({ title: "Personal", color: "#2f6f5e" });
        await v.saveNote({
          spaceId: id,
          boardId: null,
          data: { type: "text", title: "Welcome to Scute", text: WELCOME, tags: ["start-here"], color: "sage", pinned: true, created: Date.now(), modified: Date.now() },
        });
        navigate(`/s/${id}`);
      })().catch((e) => toast({ title: "Setup failed", description: e.message, variant: "destructive" }));
    }
  }, [v.firstSyncDone]); // eslint-disable-line

  // PWA share target / shortcuts: ?new=link&url=...&title=...&text=...
  useEffect(() => {
    if (intentHandled.current || !space || !writable) return;
    const intent = (window as any).__scuteIntent as Record<string, string> | undefined;
    if (!intent) return;
    intentHandled.current = true;
    (window as any).__scuteIntent = undefined;
    const urlInText = intent.text?.match(/https?:\/\/\S+/)?.[0];
    const url = intent.url || urlInText || "";
    const type = (intent.new as NoteType) || (url ? "link" : "text");
    setEditor({
      type,
      spaceId: space.id,
      boardId: board?.id || null,
      prefill: { title: intent.title || "", url, text: urlInText ? intent.text.replace(urlInText, "").trim() : intent.text || "" },
    });
  }, [space?.id, writable]); // eslint-disable-line

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.key === "n" || e.key === "N") && space && writable && !full) {
        e.preventDefault();
        setEditor({ type: "text", spaceId: space.id, boardId: board?.id || null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [space?.id, board?.id, writable, full]); // eslint-disable-line

  // boards in tree order (Joplin notebooks can be nested); depth is used for indentation
  const spaceBoards = useMemo(() => {
    const list = v.boards.filter((b) => b.spaceId === space?.id);
    if (!list.some((b) => b.data.parentId)) return list.map((b) => ({ ...b, depth: 0 }));
    const ids = new Set(list.map((b) => b.id));
    const kids = new Map<string, typeof list>();
    for (const b of list) {
      const p = b.data.parentId && ids.has(b.data.parentId) && b.data.parentId !== b.id ? b.data.parentId : "";
      kids.set(p, [...(kids.get(p) || []), b]);
    }
    const out: ((typeof list)[number] & { depth: number })[] = [];
    const seen = new Set<string>();
    const walk = (p: string, depth: number) => {
      for (const b of (kids.get(p) || []).sort((a, c) => a.data.title.localeCompare(c.data.title))) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push({ ...b, depth });
        walk(b.id, depth + 1);
      }
    };
    walk("", 0);
    for (const b of list) if (!seen.has(b.id)) out.push({ ...b, depth: 0 }); // cycles
    return out;
  }, [v.boards, space?.id]);

  // open the connection dialog the first time an unconfigured Joplin space is shown
  useEffect(() => {
    if (!joplin || !space || space.data.joplin || !canManage(space.role) || joplinPrompted.current === space.id) return;
    joplinPrompted.current = space.id;
    setJoplinDlg(true);
  }, [joplin, space?.id, space?.data.joplin]); // eslint-disable-line
  const boardName = useMemo(() => new Map(v.boards.map((b) => [b.id, b.data.title])), [v.boards]);
  const spaceNotes = useMemo(() => v.notes.filter((n) => n.spaceId === space?.id), [v.notes, space?.id]);

  const tags = useMemo(() => {
    const src = board ? spaceNotes.filter((n) => n.boardId === board.id) : spaceNotes;
    const m = new Map<string, number>();
    src.forEach((n) => n.data.tags.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [spaceNotes, board]);

  const [slides, setSlides] = useState<{ notes: Note[]; start: number } | null>(null);
  const visible = useMemo(() => {
    const searching = q.trim().length > 0;
    let list: Note[] = searching && allSpaces ? v.notes : spaceNotes;
    if (board && !(searching && allSpaces)) list = list.filter((n) => n.boardId === board.id);
    if (typeFilter !== "all") list = list.filter((n) => n.data.type === typeFilter);
    if (tagFilter) list = list.filter((n) => n.data.tags.includes(tagFilter));
    if (searching) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((n) => {
        const d = n.data;
        const hay = [d.title, d.text, d.url, d.username, d.file?.name, ...d.tags.map((t) => "#" + t)].join(" ").toLowerCase();
        return terms.every((t) => (t.startsWith("type:") ? d.type === t.slice(5) : hay.includes(t)));
      });
    }
    const sorted = [...list].sort((a, b) => {
      if (!!b.data.pinned !== !!a.data.pinned) return b.data.pinned ? 1 : -1;
      if (sort === "title") return (a.data.title || "").localeCompare(b.data.title || "");
      if (sort === "created") return b.data.created - a.data.created;
      return b.data.modified - a.data.modified;
    });
    return sorted;
  }, [v.notes, spaceNotes, board, typeFilter, tagFilter, q, allSpaces, sort]);

  // ---------- selecting notes ----------
  useEffect(() => setSel(null), [space?.id]);
  const selected = useMemo(() => (sel ? visible.filter((n) => sel.has(n.id)) : []), [sel, visible]);
  const selWritable = selected.length > 0 && selected.every((n) => canWrite(v.spaces.find((s) => s.id === n.spaceId)?.role));
  const toggleSel = (n: Note, shift: boolean) => {
    const anchor = selAnchor.current; // read now: the update below runs later
    selAnchor.current = n.id;
    setSel((cur) => {
      const next = new Set(cur || []);
      if (shift && anchor && cur) {
        const a = visible.findIndex((x) => x.id === anchor);
        const b = visible.findIndex((x) => x.id === n.id);
        if (a >= 0 && b >= 0) {
          const on = !next.has(n.id) || next.has(anchor);
          for (let k = Math.min(a, b); k <= Math.max(a, b); k++) on ? next.add(visible[k].id) : next.delete(visible[k].id);
          return next;
        }
      }
      next.has(n.id) ? next.delete(n.id) : next.add(n.id);
      return next;
    });
  };
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role=dialog], [role=alertdialog]")) return;
      if (e.key === "Escape") setSel(null);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSel(new Set(visible.map((n) => n.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, visible]);
  /** Dragging a card (all selected cards, if it's one of them) onto a board in the sidebar moves them. */
  const dragNotes = (n: Note) => (e: React.DragEvent) => {
    const ids = sel?.has(n.id) ? selected.map((x) => x.id) : [n.id];
    e.dataTransfer.setData(NOTE_DRAG, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    if (ids.length > 1) {
      const g = document.createElement("div");
      g.textContent = `${ids.length} notes`;
      g.style.cssText = "position:fixed;top:-100px;left:0;padding:6px 10px;border-radius:8px;font:600 13px system-ui;background:#2f6f5e;color:#fff";
      document.body.appendChild(g);
      e.dataTransfer.setDragImage(g, 10, 10);
      setTimeout(() => g.remove(), 0);
    }
  };
  const dropTarget = (key: string, boardId: string | null, title: string) =>
    writable
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes(NOTE_DRAG)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropBoard !== key) setDropBoard(key);
          },
          onDragLeave: () => setDropBoard((d) => (d === key ? null : d)),
          onDrop: async (e: React.DragEvent) => {
            const raw = e.dataTransfer.getData(NOTE_DRAG);
            setDropBoard(null);
            if (!raw || !space) return;
            e.preventDefault();
            const ids = new Set<string>(JSON.parse(raw));
            const notes = v.notes.filter((n) => ids.has(n.id));
            try {
              const r = await moveNotes(v, notes, { spaceId: space.id, boardId });
              const m = moveSummary(r, title);
              toast({ title: m.title, description: m.description, variant: m.error ? "destructive" : undefined });
              if (r.moved) setSel(null);
            } catch (err) {
              toast({ title: "Couldn't move", description: (err as Error).message, variant: "destructive" });
            }
          },
        }
      : {};
  // Slideshow = every still image in the current view, in view order. Videos are never included.
  const images = useMemo(() => visible.filter((n) => isImageNote(n.data) && (n.fileSize || n.data.thumb)), [visible]);

  const go = (spaceId: string, boardId?: string | null) => {
    navigate(boardId ? `/s/${spaceId}/b/${boardId}` : `/s/${spaceId}`);
    setTagFilter(null);
    setPview(null);
    setNavOpen(false);
  };

  async function addBoard(e: React.FormEvent) {
    e.preventDefault();
    if (!space || !newBoard?.trim()) return setNewBoard(null);
    const id = await v.saveBoard(space.id, { title: newBoard.trim() });
    setNewBoard(null);
    go(space.id, id);
  }

  const newNote = (type: NoteType) => space && setEditor({ type, spaceId: space.id, boardId: board?.id || null });
  const runItem = (m: MenuItem) => m.run({ ...pctx.current });
  const kindNewItems = (suffix = "") =>
    pk?.newItems?.length ? (
      <>
        {pk.newItems.map((m) => (
          <DropdownMenuItem key={m.id} onClick={() => runItem(m)} data-testid={`menu-${m.id}${suffix}`}>
            <PluginIcon icon={m.icon} /> {m.title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
      </>
    ) : null;
  const uploadRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const openUpload = (files: File[]) => {
    if (!space || !writable || files.length === 0) return;
    setEditor({ type: "file", spaceId: space.id, boardId: board?.id || null, files });
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 h-14 shrink-0 text-primary">
        <LogoMark className="h-6 w-6" />
        <span className="text-base font-semibold tracking-tight text-foreground">Scute</span>
      </div>

      <div className="px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm hover:bg-muted/60" data-testid="button-space-switcher">
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: space?.data.color }} />
              <span className="flex-1 truncate font-medium">{space?.data.title || "…"}</span>
              {space && space.members.length > 1 && <Users className="h-3.5 w-3.5 text-muted-foreground" />}
              <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Spaces</DropdownMenuLabel>
            {v.spaces.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => go(s.id)} data-testid={`menu-space-${s.id}`}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.data.color }} />
                <span className="flex-1 truncate">{s.data.title}</span>
                {hiddenIds.includes(s.id) && <EyeOff className="h-3 w-3 text-muted-foreground" aria-label="Hidden space" />}
                {s.id === v.settings.defaultSpaceId && <Star className="h-3 w-3 fill-current text-muted-foreground" aria-label="Default space" />}
                {s.role !== "owner" && <span className="text-[10px] uppercase text-muted-foreground">{s.role}</span>}
                {s.id === space?.id && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSpaceDlg({ open: true, create: true })} data-testid="menu-new-space">
              <Plus className="h-4 w-4" /> New space
            </DropdownMenuItem>
            {v.revealed && hiddenIds.length > 0 ? (
              <DropdownMenuItem onClick={v.conceal} data-testid="menu-conceal-spaces">
                <EyeOff className="h-4 w-4" /> Hide hidden spaces
              </DropdownMenuItem>
            ) : (
              hiddenAway &&
              !v.settings.hiddenQuiet && (
                <DropdownMenuItem onClick={() => setRevealOpen(true)} data-testid="menu-reveal-spaces">
                  <Eye className="h-4 w-4" /> Show hidden spaces…
                </DropdownMenuItem>
              )
            )}
            {space && !hiddenIds.includes(space.id) && (
              <DropdownMenuItem
                onClick={() =>
                  v
                    .setSpaceHidden(space.id, true)
                    .then(() => toast({ title: "Space hidden", description: "Show hidden spaces from the space menu or Settings, or with Ctrl+Alt+H." }))
                    .catch((e) => toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }))
                }
                data-testid="menu-hide-space"
              >
                <EyeOff className="h-4 w-4" /> Hide this space
              </DropdownMenuItem>
            )}
            {space && v.settings.defaultSpaceId !== space.id && (
              <DropdownMenuItem
                onClick={() =>
                  v
                    .saveSettings({ defaultSpaceId: space.id })
                    .then(() => toast({ title: "Default space set", description: `Scute will open ${space.data.title} when it starts.` }))
                    .catch((e) => toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }))
                }
                data-testid="menu-make-default"
              >
                <Star className="h-4 w-4" /> Make default space
              </DropdownMenuItem>
            )}
            {plugins.reg.menus
              .filter((m) => m.location === "spaces" && (!m.when || m.when({ ...pctx.current })))
              .map((m) => (
                <DropdownMenuItem key={m.uid} onClick={() => runItem(m)} data-testid={`menu-${m.id}`}>
                  <PluginIcon icon={m.icon} /> {m.title}
                </DropdownMenuItem>
              ))}
            {space &&
              pk?.menuItems?.map((m) => (
                <DropdownMenuItem key={m.id} onClick={() => runItem(m)} data-testid={`menu-${m.id}`}>
                  <PluginIcon icon={m.icon} /> {m.title}
                </DropdownMenuItem>
              ))}
            {space && !full && (
              <DropdownMenuItem onClick={() => setBmTools(true)} data-testid="menu-bookmark-tools">
                <Bookmark className="h-4 w-4" /> Bookmark tools…
              </DropdownMenuItem>
            )}
            {joplin && space && (
              <DropdownMenuItem onClick={() => setJoplinDlg(true)} data-testid="menu-joplin-connection">
                <NotebookPen className="h-4 w-4" /> Joplin connection…
              </DropdownMenuItem>
            )}
            {space && (
              <DropdownMenuItem onClick={() => setSpaceDlg({ open: true, create: false })} data-testid="menu-space-settings">
                <Settings className="h-4 w-4" /> {canManage(space.role) ? "Space settings & sharing" : "Space members"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {full ? <div className="flex-1" /> : (
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Boards and tags">
        <div className="space-y-0.5">
          <button onClick={() => space && go(space.id)} {...dropTarget("__all", null, "no board")} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${dropBoard === "__all" ? "ring-2 ring-primary bg-primary/10" : !board && !activeView ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60"}`} data-testid="link-all-notes">
            <LayoutGrid className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-left">All notes</span>
            <span className="text-xs text-muted-foreground tabular-nums">{spaceNotes.length}</span>
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Boards</span>
            {writable && (
              <button onClick={() => setNewBoard("")} className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" aria-label="New board" data-testid="button-new-board">
                <FolderPlus className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="space-y-0.5">
            {spaceBoards.map((b) => {
              const count = spaceNotes.filter((n) => n.boardId === b.id).length;
              if (renaming?.id === b.id)
                return (
                  <form
                    key={b.id}
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (renaming.title.trim()) await v.saveBoard(b.spaceId, { ...b.data, title: renaming.title.trim() }, b.id);
                      setRenaming(null);
                    }}
                  >
                    <Input autoFocus className="h-8" value={renaming.title} onChange={(e) => setRenaming({ ...renaming, title: e.target.value })} onBlur={() => setRenaming(null)} data-testid="input-rename-board" />
                  </form>
                );
              return (
                <div key={b.id} {...dropTarget(b.id, b.id, `“${b.data.title}”`)} className={`group flex items-center rounded-md ${dropBoard === b.id ? "ring-2 ring-primary bg-primary/10" : board?.id === b.id && !activeView ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60"}`}>
                  <button onClick={() => go(b.spaceId, b.id)} className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-sm" style={b.depth ? { paddingLeft: `${0.5 + Math.min(b.depth, 4) * 0.85}rem` } : undefined} data-testid={`link-board-${b.id}`}>
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-left">{b.data.title}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                  </button>
                  {writable && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="mr-1 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-background" aria-label={`Board options for ${b.data.title}`} data-testid={`button-board-menu-${b.id}`}>
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setRenaming({ id: b.id, title: b.data.title })}>Rename</DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={async () => {
                            await v.deleteBoard(b.id);
                            if (board?.id === b.id && space) go(space.id);
                            toast({ title: "Board deleted", description: "Its notes were kept and moved to All notes." });
                          }}
                        >
                          Delete board
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            })}
            {newBoard !== null && (
              <form onSubmit={addBoard}>
                <Input autoFocus className="h-8" placeholder="Board name" value={newBoard} onChange={(e) => setNewBoard(e.target.value)} onBlur={(e) => (e.target.value.trim() ? addBoard(e as any) : setNewBoard(null))} data-testid="input-new-board" />
              </form>
            )}
            {spaceBoards.length === 0 && newBoard === null && <p className="px-2 py-1 text-xs text-muted-foreground">No boards yet</p>}
          </div>
        </div>

        {tags.length > 0 && (
          <div>
            <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tags</div>
            <div className="flex flex-wrap gap-1 px-1">
              {tags.slice(0, 40).map(([t, c]) => (
                <button
                  key={t}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${tagFilter === t ? "bg-primary text-primary-foreground" : "bg-sidebar-accent/70 text-sidebar-foreground hover:bg-sidebar-accent"}`}
                  data-testid={`button-tag-${t}`}
                >
                  #{t}
                  <span className="opacity-60 tabular-nums">{c}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {plugins.reg.views.length > 0 && (
          <div>
            <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Plug-ins</div>
            <div className="space-y-0.5">
              {plugins.reg.views.map((pv) => (
                <button
                  key={pv.uid}
                  onClick={() => {
                    setPview({ pluginId: pv.pluginId, viewId: pv.id });
                    setNavOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${activeView?.uid === pv.uid ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60"}`}
                  data-testid={`link-plugin-view-${pv.pluginId}-${pv.id}`}
                >
                  {pv.icon ? <PluginIcon icon={pv.icon} className="h-4 w-4 text-muted-foreground" /> : <Puzzle className="h-4 w-4 text-muted-foreground" />}
                  <span className="flex-1 truncate text-left">{pv.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>
      )}

      <div className="border-t px-3 py-3 space-y-2 safe-bottom">
        <button onClick={() => v.sync()} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent/60" data-testid="button-sync-status" title="Sync now">
          {v.syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : v.online ? <Cloud className="h-3.5 w-3.5 text-primary" /> : <CloudOff className="h-3.5 w-3.5" />}
          <span className="flex-1 text-left" data-testid="text-sync-status">
            {!v.online ? `Offline${v.pending ? ` · ${v.pending} waiting` : ""}` : v.pending ? `Syncing ${v.pending}…` : `Synced ${relTime(v.lastSync)}`}
          </span>
          <RefreshCw className="h-3 w-3" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent/60" data-testid="button-user-menu">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold uppercase">{v.user?.username.slice(0, 2)}</div>
              <span className="flex-1 truncate text-left">{v.user?.username}</span>
              <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuItem onClick={() => setSettingsOpen(true)} data-testid="menu-settings">
              <Settings className="h-4 w-4" /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(t) => setTheme(t as any)}>
              <DropdownMenuRadioItem value="light"><Sun className="h-4 w-4 mr-2" />Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon className="h-4 w-4 mr-2" />Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system"><Monitor className="h-4 w-4 mr-2" />System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => v.logout(true)} data-testid="menu-logout">
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const heading = q.trim() && allSpaces ? "Search all spaces" : board ? board.data.title : "All notes";

  return (
    <ResourceContext.Provider value={resolver}>
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">{sidebar}</aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-72 p-0 bg-sidebar">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="flex flex-1 min-w-0 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-5">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation" data-testid="button-open-nav">
            <Menu className="h-5 w-5" />
          </Button>
          <div className="relative flex-1 max-w-xl">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQ(""), (e.target as HTMLInputElement).blur())}
              placeholder="Search notes"
              className="pl-8 pr-20 h-9"
              aria-label="Search notes"
              data-testid="input-search"
            />
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {q && (
                <button onClick={() => setAllSpaces(!allSpaces)} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${allSpaces ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`} title="Search every space" data-testid="button-search-all">
                  <Globe2 className="h-3 w-3" /> All
                </button>
              )}
              {!q && <kbd className="hidden sm:inline rounded border px-1.5 text-[10px] text-muted-foreground">/</kbd>}
            </div>
          </div>
          <div className="flex-1 hidden lg:block" />
          {!full && (<>
          <Button
            variant="ghost"
            size="icon"
            aria-label={images.length ? `Slideshow of ${images.length} images` : "Slideshow (no images in this view)"}
            title={images.length ? `Slideshow · ${images.length} image${images.length > 1 ? "s" : ""}` : "No images in this view"}
            disabled={!images.length}
            onClick={() => setSlides({ notes: images, start: 0 })}
            data-testid="button-slideshow"
          >
            <GalleryHorizontalEnd className="h-4 w-4" />
          </Button>
          <Button
            variant={sel ? "secondary" : "ghost"}
            size="icon"
            aria-label={sel ? "Stop selecting" : "Select notes"}
            aria-pressed={!!sel}
            title={sel ? "Stop selecting (Esc)" : "Select notes (or Ctrl+click a note)"}
            disabled={!visible.length && !sel}
            onClick={() => setSel(sel ? null : new Set())}
            data-testid="button-select-notes"
          >
            <CheckSquare className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Sort" data-testid="button-sort">
                <ArrowDownUp className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(s) => setSort(s as Sort)}>
                <DropdownMenuRadioItem value="modified">Last edited</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="created">Date added</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="title">Title</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          </>)}
          <PluginCommandsMenu ctx={() => ({ ...pctx.current })} />
          {writable && !full && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="hidden sm:inline-flex" data-testid="button-new">
                  <Plus className="h-4 w-4" /> New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {kindNewItems()}
                {NOTE_TYPES.map((t) => (
                  <DropdownMenuItem key={t.type} onClick={() => newNote(t.type)} data-testid={`menu-new-${t.type}`}>
                    <t.icon className="h-4 w-4" /> {t.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => uploadRef.current?.click()} data-testid="menu-upload-files">
                  <Upload className="h-4 w-4" /> Upload files…
                </DropdownMenuItem>
                {templateItems("")}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </header>

        <input
          ref={uploadRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            openUpload(Array.from(e.target.files || []));
            e.target.value = "";
          }}
          data-testid="input-upload-files"
        />
        <div
          className="relative flex-1 overflow-y-auto"
          onDragEnter={(e) => {
            if (writable && !editor && e.dataTransfer.types.includes("Files")) setDropping(true);
          }}
          onDragOver={(e) => {
            if (writable && !editor && e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files?.length) return;
            e.preventDefault();
            setDropping(false);
            openUpload(Array.from(e.dataTransfer.files));
          }}
        >
          {dropping && (
            <div className="pointer-events-none sticky top-0 z-30 h-0" data-testid="overlay-drop">
              <div className="absolute inset-x-3 top-3 flex h-[calc(100dvh-5.5rem)] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/85 text-sm backdrop-blur-sm">
                <Upload className="h-7 w-7 text-primary" />
                <span className="font-medium">Drop to add as notes</span>
                <span className="text-xs text-muted-foreground">Each file becomes its own encrypted note in {board ? board.data.title : space?.data.title}</span>
              </div>
            </div>
          )}
          <div className="mx-auto max-w-[1600px] px-3 sm:px-5 py-5 space-y-4">
            {v.invites.map((iv) => (
              <div key={iv.spaceId} className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-accent px-4 py-3 text-sm" data-testid={`banner-invite-${iv.spaceId}`}>
                <Users className="h-4 w-4 text-primary" />
                <span className="flex-1 min-w-48">
                  <span className="font-medium">{iv.invitedBy || "Someone"}</span> invited you to <span className="font-medium">{iv.data.title}</span> as {iv.role}.
                </span>
                <Button size="sm" onClick={() => v.acceptInvite(iv.spaceId).then(() => go(iv.spaceId))} data-testid={`button-accept-${iv.spaceId}`}>
                  Accept
                </Button>
                <Button size="sm" variant="ghost" onClick={() => v.declineInvite(iv.spaceId)} data-testid={`button-decline-${iv.spaceId}`}>
                  Decline
                </Button>
              </div>
            ))}

            {activeView ? (
              <section className="space-y-4" aria-label={activeView.title}>
                <div className="flex items-center gap-2">
                  <h1 className="text-base font-semibold" data-testid="text-view-title">{activeView.title}</h1>
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setPview(null)} data-testid="button-close-plugin-view">
                    <X className="h-4 w-4" /> Close
                  </Button>
                </div>
                <PluginViewHost key={activeView.uid} view={activeView} ctx={pctx.current} />
              </section>
            ) : fullView && space ? (
              <PluginViewHost key={fullView.uid} view={fullView} ctx={pctx.current} />
            ) : (<>
            {joplin && space && <JoplinBar key={space.id} space={space} onSettings={() => setJoplinDlg(true)} />}
            {kind !== "notes" && !pk && !joplin && (
              <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground" data-testid="text-kind-disabled">This space's special view is turned off on this server, so its items are shown as plain notes.</p>
            )}
            {pk && space && pk.tabs && pk.tabs.length > 1 && !(q.trim() && allSpaces) && (
              <div className="inline-flex rounded-md border p-0.5 text-sm" role="tablist" aria-label={`${pk.title} view`}>
                {pk.tabs.map((t) => (
                  <button key={t.id} role="tab" aria-selected={tabId === t.id} type="button" onClick={() => setPtab({ spaceId: space.id, tab: t.id })} className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 ${tabId === t.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`} data-testid={`tab-${pk.id}-${t.id}`}>
                    <PluginIcon icon={t.icon} className="h-3.5 w-3.5" /> {t.title}
                  </button>
                ))}
              </div>
            )}
            {tabView && space && !(q.trim() && allSpaces) ? (
              <PluginViewHost key={`${tabView.uid}:${space.id}`} view={tabView} ctx={pctx.current} />
            ) : (<>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold mr-2" data-testid="text-view-title">
                {heading}
              </h1>
              <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Filter by type">
                {[{ type: "all" as const, label: "All", icon: null }, ...NOTE_TYPES].map((t) => (
                  <button
                    key={t.type}
                    role="tab"
                    aria-selected={typeFilter === t.type}
                    onClick={() => setTypeFilter(t.type)}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${typeFilter === t.type ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"}`}
                    data-testid={`filter-type-${t.type}`}
                  >
                    {t.icon && <t.icon className="h-3 w-3" />}
                    {t.label}
                  </button>
                ))}
              </div>
              {tagFilter && (
                <button onClick={() => setTagFilter(null)} className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground" data-testid="button-clear-tag">
                  <Hash className="h-3 w-3" />
                  {tagFilter}
                  <X className="h-3 w-3" />
                </button>
              )}
              <span className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="text-count">
                {visible.length} {visible.length === 1 ? "item" : "items"}
              </span>
            </div>

            {v.status === "ready" && !v.firstSyncDone && v.notes.length === 0 ? (
              <div className="masonry">
                {[180, 120, 220, 140, 160, 200].map((h, i) => (
                  <div key={i} className="rounded-lg border bg-card animate-pulse" style={{ height: h }} />
                ))}
              </div>
            ) : visible.length === 0 ? (
              <EmptyState searching={!!q || !!tagFilter || typeFilter !== "all"} writable={writable} onNew={() => newNote("text")} boardName={board?.data.title} />
            ) : (
              <div className="masonry" data-testid="grid-notes">
                {visible.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    onOpen={() => openNote(n)}
                    boardName={!board && n.boardId ? boardName.get(n.boardId) : undefined}
                    selecting={!!sel}
                    selected={!!sel?.has(n.id)}
                    onSelect={({ shiftKey }) => toggleSel(n, shiftKey)}
                    onDragStart={writable ? dragNotes(n) : undefined}
                  />
                ))}
              </div>
            )}
            </>)}
            </>)}
          </div>
        </div>
      </main>

      {writable && !full && !sel && (
        <div className="sm:hidden fixed right-4 z-40" style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" className="h-14 w-14 rounded-full shadow-lg" aria-label="New" data-testid="button-fab-new">
              <Plus className="h-6 w-6" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-44">
                {kindNewItems("-mobile")}
            {NOTE_TYPES.map((t) => (
              <DropdownMenuItem key={t.type} onClick={() => newNote(t.type)}>
                <t.icon className="h-4 w-4" /> {t.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => uploadRef.current?.click()} data-testid="menu-upload-files-mobile">
              <Upload className="h-4 w-4" /> Upload files…
            </DropdownMenuItem>
            {templateItems("-mobile")}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      )}

      {sel && (
        <SelectionBar
          count={selected.length}
          total={visible.length}
          writable={selWritable}
          onAll={() => setSel(new Set(visible.map((n) => n.id)))}
          onNone={() => setSel(new Set())}
          onMove={() => setMoving(selected)}
          onDelete={() => setDeleting(selected)}
          onExit={() => setSel(null)}
        />
      )}
      <MoveDialog notes={moving} spaceId={space?.id || null} onClose={() => setMoving(null)} onDone={() => (setMoving(null), setSel(null))} />
      <DeleteNotesDialog notes={deleting} onClose={() => setDeleting(null)} onDone={() => (setDeleting(null), setSel(null))} />
      <BookmarkRuntime />
      <BookmarkToolsDialog
        open={bmTools}
        onClose={() => setBmTools(false)}
        spaceId={space?.id || null}
        onOpen={(n) => {
          setBmTools(false);
          openNote(n);
        }}
      />
      <NoteEditor
        target={editor}
        onClose={() => setEditor(null)}
        onOpenNote={openNote}
        onSlideshow={(n) => {
          const i = images.findIndex((x) => x.id === n.id);
          setEditor(null);
          setSlides({ notes: i >= 0 ? images : [n], start: Math.max(0, i) });
        }}
      />
      {slides && <Slideshow notes={slides.notes} start={slides.start} onClose={() => setSlides(null)} />}
      <SpaceDialog open={spaceDlg.open} onOpenChange={(o) => setSpaceDlg({ ...spaceDlg, open: o })} space={spaceDlg.create ? null : space} onCreated={(id) => go(id)} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onReveal={() => setRevealOpen(true)} />
      <RevealDialog open={revealOpen} onOpenChange={setRevealOpen} />
      <PluginDialogHost />
      {joplin && space && <JoplinDialog space={space} open={joplinDlg} onOpenChange={setJoplinDlg} />}
    </div>
    </ResourceContext.Provider>
  );
}

function EmptyState({ searching, writable, onNew, boardName }: { searching: boolean; writable: boolean; onNew: () => void; boardName?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 px-6 text-center shell-pattern" data-testid="empty-state">
      <LogoMark className="h-10 w-10 text-primary/60" />
      <h2 className="mt-4 text-base font-semibold">{searching ? "Nothing matches" : boardName ? `${boardName} is empty` : "Nothing here yet"}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {searching ? "Try a different word, remove a filter, or search all spaces." : "Notes, bookmarks, passwords and files you add are encrypted on this device before syncing."}
      </p>
      {!searching && writable && (
        <Button className="mt-5" onClick={onNew} data-testid="button-empty-new">
          <Plus className="h-4 w-4" /> Add a note
        </Button>
      )}
    </div>
  );
}
