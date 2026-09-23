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
} from "lucide-react";
import { Slideshow } from "@/components/slideshow";
import { isImageNote } from "@/lib/media";

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
  const [spaceDlg, setSpaceDlg] = useState<{ open: boolean; create: boolean }>({ open: false, create: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const space = v.spaces.find((s) => s.id === route.spaceId) || v.spaces.find((s) => s.id === lastSpace) || v.spaces[0] || null;
  const board = route.boardId ? v.boards.find((b) => b.id === route.boardId) || null : null;
  const writable = canWrite(space?.role);

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
      } else if ((e.key === "n" || e.key === "N") && space && writable) {
        e.preventDefault();
        setEditor({ type: "text", spaceId: space.id, boardId: board?.id || null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [space?.id, board?.id, writable]); // eslint-disable-line

  const spaceBoards = useMemo(() => v.boards.filter((b) => b.spaceId === space?.id), [v.boards, space?.id]);
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
  // Slideshow = every still image in the current view, in view order. Videos are never included.
  const images = useMemo(() => visible.filter((n) => isImageNote(n.data) && (n.fileSize || n.data.thumb)), [visible]);

  const go = (spaceId: string, boardId?: string | null) => {
    navigate(boardId ? `/s/${spaceId}/b/${boardId}` : `/s/${spaceId}`);
    setTagFilter(null);
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
                {s.role !== "owner" && <span className="text-[10px] uppercase text-muted-foreground">{s.role}</span>}
                {s.id === space?.id && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSpaceDlg({ open: true, create: true })} data-testid="menu-new-space">
              <Plus className="h-4 w-4" /> New space
            </DropdownMenuItem>
            {space && (
              <DropdownMenuItem onClick={() => setSpaceDlg({ open: true, create: false })} data-testid="menu-space-settings">
                <Settings className="h-4 w-4" /> {canManage(space.role) ? "Space settings & sharing" : "Space members"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Boards and tags">
        <div className="space-y-0.5">
          <button onClick={() => space && go(space.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${!board ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60"}`} data-testid="link-all-notes">
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
                <div key={b.id} className={`group flex items-center rounded-md ${board?.id === b.id ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60"}`}>
                  <button onClick={() => go(b.spaceId, b.id)} className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-sm" data-testid={`link-board-${b.id}`}>
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
      </nav>

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
          {writable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="hidden sm:inline-flex" data-testid="button-new">
                  <Plus className="h-4 w-4" /> New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {NOTE_TYPES.map((t) => (
                  <DropdownMenuItem key={t.type} onClick={() => newNote(t.type)} data-testid={`menu-new-${t.type}`}>
                    <t.icon className="h-4 w-4" /> {t.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => uploadRef.current?.click()} data-testid="menu-upload-files">
                  <Upload className="h-4 w-4" /> Upload files…
                </DropdownMenuItem>
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
                  <NoteCard key={n.id} note={n} onOpen={() => setEditor({ note: n, spaceId: n.spaceId, boardId: n.boardId })} boardName={!board && n.boardId ? boardName.get(n.boardId) : undefined} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {writable && (
        <div className="sm:hidden fixed right-4 z-40" style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" className="h-14 w-14 rounded-full shadow-lg" aria-label="New" data-testid="button-fab-new">
              <Plus className="h-6 w-6" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-44">
            {NOTE_TYPES.map((t) => (
              <DropdownMenuItem key={t.type} onClick={() => newNote(t.type)}>
                <t.icon className="h-4 w-4" /> {t.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => uploadRef.current?.click()} data-testid="menu-upload-files-mobile">
              <Upload className="h-4 w-4" /> Upload files…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      )}

      <NoteEditor
        target={editor}
        onClose={() => setEditor(null)}
        onSlideshow={(n) => {
          const i = images.findIndex((x) => x.id === n.id);
          setEditor(null);
          setSlides({ notes: i >= 0 ? images : [n], start: Math.max(0, i) });
        }}
      />
      {slides && <Slideshow notes={slides.notes} start={slides.start} onClose={() => setSlides(null)} />}
      <SpaceDialog open={spaceDlg.open} onOpenChange={(o) => setSpaceDlg({ ...spaceDlg, open: o })} space={spaceDlg.create ? null : space} onCreated={(id) => go(id)} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
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
