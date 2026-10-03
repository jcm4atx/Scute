/**
 * Working on many notes at once: select them in the grid, then move them to another
 * board or space, or delete them.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { canWrite, useVault, type Board, type Note } from "@/lib/vault";
import { moveFromJoplin } from "@/components/note-editor";
import { CheckSquare, FolderInput, Loader2, Trash2, X } from "lucide-react";

type V = ReturnType<typeof useVault>;
export const NOTE_DRAG = "application/x-scute-notes";
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Boards of a space in tree order, with their depth (Joplin notebooks can be nested). */
export function boardTree(boards: Board[], spaceId: string) {
  const list = boards.filter((b) => b.spaceId === spaceId);
  const ids = new Set(list.map((b) => b.id));
  const kids = new Map<string, Board[]>();
  for (const b of list) {
    const p = b.data.parentId && ids.has(b.data.parentId) && b.data.parentId !== b.id ? b.data.parentId : "";
    kids.set(p, [...(kids.get(p) || []), b]);
  }
  const out: (Board & { depth: number })[] = [];
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
  for (const b of list) if (!seen.has(b.id)) out.push({ ...b, depth: 0 });
  return out;
}

export interface MoveResult {
  moved: number;
  skipped: number;
  failed: { title: string; error: string }[];
  copied: number;
  missing: number;
}

/**
 * Move notes to a board (null: no board) in a space. Notes already there are skipped.
 * Within a space only the board changes. Into another space a note's key is re-wrapped
 * for that space (its attachment goes with it); notes leaving a Joplin space get their
 * Joplin attachments copied into Scute first, as when moving one note in the editor.
 */
export async function moveNotes(v: V, notes: Note[], to: { spaceId: string; boardId: string | null }, onProgress?: (done: number, total: number) => void): Promise<MoveResult> {
  const r: MoveResult = { moved: 0, skipped: 0, failed: [], copied: 0, missing: 0 };
  const target = v.spaces.find((s) => s.id === to.spaceId);
  if (!target || !canWrite(target.role)) throw new Error("You can't add notes to that space");
  const todo = notes.filter((n) => {
    if (n.spaceId === to.spaceId && (n.boardId || null) === to.boardId) {
      r.skipped++;
      return false;
    }
    return true;
  });
  let done = 0;
  let next = 0;
  const one = async (n: Note) => {
    const from = v.spaces.find((s) => s.id === n.spaceId);
    try {
      if (!from || !canWrite(from.role)) throw new Error("read-only space");
      const data = { ...n.data, modified: Date.now() };
      if (n.spaceId === to.spaceId) {
        await v.saveNote({ id: n.id, spaceId: n.spaceId, boardId: to.boardId, data });
      } else if (from.data.kind === "joplin") {
        const m = await moveFromJoplin(v, n, to, data, null);
        r.copied += m.copied;
        r.missing += m.missing.length;
      } else {
        delete data.joplin; // new to the target space (and to its Joplin account, if any)
        await v.saveNote({ id: n.id, spaceId: to.spaceId, boardId: to.boardId, data });
      }
      r.moved++;
    } catch (e) {
      r.failed.push({ title: n.data.title || n.data.file?.name || "Untitled", error: (e as Error).message });
    }
    onProgress?.(++done, todo.length);
  };
  // Joplin copies talk to the Joplin Server: one at a time. Everything else: a few at once.
  const crossJoplin = todo.some((n) => n.spaceId !== to.spaceId && v.spaces.find((s) => s.id === n.spaceId)?.data.kind === "joplin");
  const worker = async () => {
    while (next < todo.length) await one(todo[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(crossJoplin ? 1 : 4, todo.length) }, worker));
  return r;
}

export function moveSummary(r: MoveResult, where: string) {
  const bits: string[] = [];
  if (r.skipped) bits.push(`${plural(r.skipped, "note was", "notes were")} already there.`);
  if (r.copied) bits.push(`Copied ${plural(r.copied, "attachment")} from Joplin.`);
  if (r.missing) bits.push(`${plural(r.missing, "attachment wasn't", "attachments weren't")} on the Joplin Server.`);
  if (r.failed.length) bits.push(`Couldn't move ${r.failed.slice(0, 3).map((f) => `“${f.title}” (${f.error})`).join(", ")}${r.failed.length > 3 ? ` and ${r.failed.length - 3} more` : ""}.`);
  return { title: r.moved ? `Moved ${plural(r.moved, "note")} to ${where}` : r.failed.length ? "Nothing was moved" : "Nothing to move", description: bits.join(" ") || undefined, error: !r.moved && r.failed.length > 0 };
}

/** Pick a space and board, then move the notes there. */
export function MoveDialog({ notes, spaceId, onClose, onDone }: { notes: Note[] | null; spaceId: string | null; onClose: () => void; onDone: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  const spaces = v.spaces.filter((s) => canWrite(s.role));
  const [to, setTo] = useState<string>("");
  const [board, setBoard] = useState<string>("__none");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!notes) return;
    setTo(spaceId && spaces.some((s) => s.id === spaceId) ? spaceId : spaces[0]?.id || "");
    setBoard("__none");
    setNewName("");
  }, [notes]); // eslint-disable-line

  const boards = useMemo(() => (to ? boardTree(v.boards, to) : []), [v.boards, to]);
  const sp = v.spaces.find((s) => s.id === to);
  const leavingJoplin = !!notes?.some((n) => n.spaceId !== to && v.spaces.find((s) => s.id === n.spaceId)?.data.kind === "joplin");
  const intoJoplin = sp?.data.kind === "joplin" && !!notes?.some((n) => n.spaceId !== to);

  async function go() {
    if (!notes || !sp) return;
    setBusy({ done: 0, total: notes.length });
    try {
      let boardId: string | null = board === "__none" || board === "__new" ? null : board;
      let where = boardId ? `“${boards.find((b) => b.id === boardId)?.data.title}”` : "no board";
      if (board === "__new") {
        const t = newName.trim();
        if (!t) throw new Error("Name the new board");
        boardId = await v.saveBoard(sp.id, { title: t });
        where = `“${t}”`;
      }
      if (sp.id !== spaceId) where += ` in ${sp.data.title}`;
      const r = await moveNotes(v, notes, { spaceId: sp.id, boardId }, (done, total) => setBusy({ done, total }));
      const s = moveSummary(r, where);
      toast({ title: s.title, description: s.description, variant: s.error ? "destructive" : undefined });
      onDone();
    } catch (e) {
      toast({ title: "Couldn't move", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={!!notes} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md" data-testid="dialog-move-notes">
        <DialogHeader>
          <DialogTitle>Move {plural(notes?.length || 0, "note")}</DialogTitle>
          <DialogDescription>Choose where they should go.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Space</Label>
            <Select value={to} onValueChange={(x) => (setTo(x), setBoard("__none"))} disabled={!!busy}>
              <SelectTrigger data-testid="select-move-space">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.data.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Board</Label>
            <Select value={board} onValueChange={setBoard} disabled={!!busy}>
              <SelectTrigger data-testid="select-move-board">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">No board (All notes)</SelectItem>
                {boards.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    <span style={b.depth ? { paddingLeft: `${Math.min(b.depth, 4) * 0.85}rem` } : undefined}>{b.data.title}</span>
                  </SelectItem>
                ))}
                <SelectItem value="__new">New board…</SelectItem>
              </SelectContent>
            </Select>
            {board === "__new" && <Input autoFocus placeholder="Board name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} data-testid="input-move-new-board" />}
          </div>
          {leavingJoplin && <p className="text-xs text-muted-foreground">Notes leaving a Joplin space have their attachments copied into Scute first, and the next Joplin sync moves the old copies to Joplin's trash.</p>}
          {intoJoplin && <p className="text-xs text-muted-foreground">They'll be added to this space's Joplin account on the next sync.</p>}
          {busy && busy.total > 1 && (
            <div className="space-y-1" data-testid="move-progress">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Moving…</span>
                <span className="tabular-nums">
                  {busy.done} of {busy.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(busy.done / busy.total) * 100}%` }} />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button onClick={go} disabled={!!busy || !sp || (board === "__new" && !newName.trim())} data-testid="button-move-notes">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />} Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The bar shown while notes are being selected. */
export function SelectionBar({
  count,
  total,
  writable,
  onAll,
  onNone,
  onMove,
  onDelete,
  onExit,
}: {
  count: number;
  total: number;
  writable: boolean;
  onAll: () => void;
  onNone: () => void;
  onMove: () => void;
  onDelete: () => void;
  onExit: () => void;
}) {
  return (
    <div className="fixed inset-x-0 z-40 flex justify-center px-3" style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
      <div className="flex max-w-full items-center gap-1 rounded-xl border bg-popover px-2 py-1.5 text-sm text-popover-foreground shadow-lg" role="toolbar" aria-label="Selected notes" data-testid="bar-selection">
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onExit} aria-label="Stop selecting" title="Stop selecting (Esc)" data-testid="button-selection-exit">
          <X className="h-4 w-4" />
        </Button>
        <span className="whitespace-nowrap px-1 font-medium tabular-nums" data-testid="text-selection-count">
          {count} selected
        </span>
        {count < total ? (
          <Button size="sm" variant="ghost" onClick={onAll} data-testid="button-select-all">
            <CheckSquare className="h-4 w-4" /> All {total}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onNone} data-testid="button-select-none">
            None
          </Button>
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" onClick={onMove} disabled={!count || !writable} data-testid="button-selection-move">
          <FolderInput className="h-4 w-4" /> Move…
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={!count || !writable} aria-label="Delete" data-testid="button-selection-delete">
          <Trash2 className="h-4 w-4" /> <span className="hidden sm:inline">Delete</span>
        </Button>
      </div>
    </div>
  );
}

export function DeleteNotesDialog({ notes, onClose, onDone }: { notes: Note[] | null; onClose: () => void; onDone: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const joplin = !!notes?.some((n) => v.spaces.find((s) => s.id === n.spaceId)?.data.kind === "joplin");
  async function go() {
    if (!notes) return;
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const n of notes) {
      try {
        if (!canWrite(v.spaces.find((s) => s.id === n.spaceId)?.role)) throw new Error("read-only");
        await v.deleteNote(n.id);
        ok++;
      } catch {
        failed.push(n.data.title || "Untitled");
      }
    }
    setBusy(false);
    toast({ title: ok ? `Deleted ${plural(ok, "note")}` : "Nothing was deleted", description: failed.length ? `Couldn't delete ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}.` : undefined, variant: ok ? undefined : "destructive" });
    onDone();
  }
  return (
    <AlertDialog open={!!notes} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent data-testid="dialog-delete-notes">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {plural(notes?.length || 0, "note")}?</AlertDialogTitle>
          <AlertDialogDescription>
            They're removed for everyone in the space, with their attachments. This can't be undone.{joplin ? " Notes in Joplin spaces go to Joplin's trash on the next sync." : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void go();
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="button-confirm-delete-notes"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
