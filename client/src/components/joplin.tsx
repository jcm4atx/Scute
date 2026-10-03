import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, NotebookPen, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { JoplinConfig } from "@shared/schema";
import { canManage, canWrite, useVault, type Space } from "@/lib/vault";
import { idbGet, idbSet } from "@/lib/idb";
import { fetchResource, forgetCache, hashBoard, noteChanged, normUrl, syncableNote, syncJoplinSpace, testConnection, type SyncResult } from "@/lib/joplin";
import type { ResourceResolver } from "@/components/note-parts";

const AUTO_EVERY = 5 * 60_000;
const AFTER_EDIT = 15_000;

function ago(t: number | null | undefined) {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function summary(r: SyncResult) {
  const parts: string[] = [];
  if (r.pulled) parts.push(`${r.pulled} from Joplin`);
  if (r.pushed) parts.push(`${r.pushed} to Joplin`);
  if (r.deletedLocal + r.deletedRemote) parts.push(`${r.deletedLocal + r.deletedRemote} deleted`);
  if (r.conflicts) parts.push(`${r.conflicts} conflict${r.conflicts > 1 ? "s" : ""}`);
  return parts.length ? parts.join(" · ") : "Up to date";
}

/** Resolver for ":/<id>" links in Markdown, bound to a Joplin space's connection. */
export function useJoplinResolver(space: Space | null, enabled: boolean): ResourceResolver | null {
  const cfg = space?.data.joplin;
  const url = cfg?.url, email = cfg?.email, password = cfg?.password;
  return useMemo(() => (enabled && url && email && password ? (id: string) => fetchResource({ url, email, password }, id) : null), [enabled, url, email, password]);
}

// ------------------------------------------------------------------ connection dialog
export function JoplinDialog({ space, open, onOpenChange, onSaved }: { space: Space; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  const cfg = space.data.joplin;
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const manage = canManage(space.role);

  useEffect(() => {
    if (!open) return;
    setUrl(cfg?.url || "");
    setEmail(cfg?.email || "");
    setPassword(cfg?.password || "");
    setAuto(cfg?.autoSync !== false);
    setTest(null);
  }, [open, space.id]); // eslint-disable-line

  const next = (): JoplinConfig => ({ url: normUrl(url), email: email.trim(), password, autoSync: auto });
  const valid = /^https?:\/\/[^\s/]+/i.test(url.trim()) && email.trim() && password;

  async function runTest() {
    if (!valid) return;
    setBusy("test");
    setTest(null);
    try {
      const r = await testConnection(next());
      setTest({ ok: true, msg: r.fresh ? "Connected. This Joplin account is empty, so Scute will set it up on the first sync." : `Connected. Found ${r.items >= 100 ? "100+" : r.items} item${r.items === 1 ? "" : "s"} on the server.` });
    } catch (e) {
      setTest({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !manage) return;
    setBusy("save");
    try {
      const n = next();
      const live = v.spaces.find((s) => s.id === space.id) || space;
      const changedAccount = !cfg || normUrl(cfg.url) !== n.url || cfg.email.toLowerCase() !== n.email.toLowerCase();
      await v.updateSpace(live, { ...live.data, joplin: n });
      if (changedAccount && v.user) await forgetCache(v.user.id, space.id);
      toast({ title: "Joplin connection saved" });
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      toast({ title: "Couldn't save", description: (err as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[92dvh] overflow-y-auto" data-testid="dialog-joplin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NotebookPen className="h-4 w-4 text-primary" /> Joplin Server connection
          </DialogTitle>
          <DialogDescription>Scute syncs this space with a Joplin Server account, the same way the Joplin desktop and mobile apps do.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="jp-url">Server URL</Label>
            <Input id="jp-url" type="url" inputMode="url" placeholder="https://joplin.example.com" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!manage} autoComplete="off" data-testid="input-joplin-url" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jp-email">Email</Label>
            <Input id="jp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!manage} autoComplete="off" data-testid="input-joplin-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="jp-pass">Password</Label>
            <Input id="jp-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!manage} autoComplete="new-password" data-testid="input-joplin-password" />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Sync automatically
              <span className="block text-xs text-muted-foreground">Every 5 minutes and shortly after you make changes, while this space is open.</span>
            </span>
            <Switch checked={auto} onCheckedChange={setAuto} disabled={!manage} data-testid="switch-joplin-auto" />
          </label>

          {test && (
            <p className={`flex gap-2 rounded-md border px-3 py-2 text-xs ${test.ok ? "border-primary/30 bg-accent" : "border-destructive/40 text-destructive"}`} role="status" data-testid="text-joplin-test">
              {test.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span>{test.msg}</span>
            </p>
          )}

          <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground space-y-1">
            <p>Joplin Server stores notes without Scute's encryption, so anything in this space is readable by whoever runs that server. Password notes are never sent.</p>
            <p>The connection details are saved encrypted inside the space, so other members of this space can sync too.</p>
            {!manage && <p className="font-medium text-foreground">Only the space owner or an admin can change these settings.</p>}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={runTest} disabled={!valid || !!busy} data-testid="button-joplin-test">
              {busy === "test" && <Loader2 className="h-4 w-4 animate-spin" />} Test connection
            </Button>
            <Button type="submit" disabled={!valid || !manage || !!busy} data-testid="button-joplin-save">
              {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ status bar + sync loop
export function JoplinBar({ space, onSettings }: { space: Space; onSettings: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  const vr = useRef(v);
  vr.current = v;
  const cfg = space.data.joplin;
  const configured = !!(cfg?.url && cfg.email && cfg.password);
  const writable = canWrite(space.role);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [last, setLast] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastKey = v.user ? `joplin-last:${v.user.id}:${space.id}` : "";

  useEffect(() => {
    setLast(null);
    setError(null);
    if (lastKey) idbGet<SyncResult>(lastKey).then((r) => r && setLast(r));
  }, [lastKey]);

  const run = useCallback(
    async (manual: boolean) => {
      const vv = vr.current;
      const sp = vv.spaces.find((s) => s.id === space.id);
      if (!sp?.data.joplin || !vv.user || !canWrite(sp.role)) return;
      if (!vv.online) {
        if (manual) toast({ title: "You're offline", description: "Joplin sync needs a connection." });
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const r = await syncJoplinSpace({
          userId: vv.user.id,
          space: sp,
          boards: vv.boards.filter((b) => b.spaceId === sp.id),
          notes: vv.notes.filter((n) => n.spaceId === sp.id),
          tombstones: () => vr.current.tombstones(sp.id),
          saveBoard: (...a) => vr.current.saveBoard(...a),
          deleteBoard: (id) => vr.current.deleteBoard(id),
          saveNotesBulk: (sid, items) => vr.current.saveNotesBulk(sid, items),
          deleteNote: (id) => vr.current.deleteNote(id),
          fileBlob: (n) => vr.current.fileBlob(n),
          liveSpaceOf: (id) => vr.current.notes.find((n) => n.id === id)?.spaceId ?? null,
          onProgress: setProgress,
        });
        setLast(r);
        if (lastKey) void idbSet(lastKey, r);
        if (r.errors.length) setError(r.errors.slice(0, 3).join(" · ") + (r.errors.length > 3 ? ` (+${r.errors.length - 3} more)` : ""));
        if (manual) toast({ title: "Joplin sync finished", description: summary(r) });
        else if (r.conflicts) toast({ title: "Joplin sync: conflicts", description: `${r.conflicts} note${r.conflicts > 1 ? "s were" : " was"} changed in both places. Your version was kept as a "(conflict copy)" note.` });
      } catch (e) {
        setError((e as Error).message);
        if (manual) toast({ title: "Joplin sync failed", description: (e as Error).message, variant: "destructive" });
      } finally {
        setBusy(false);
        setProgress("");
      }
    },
    [space.id, lastKey, toast],
  );

  // auto-sync: on open, every few minutes, and shortly after local edits
  const auto = configured && writable && cfg?.autoSync !== false;
  const cfgSig = `${cfg?.url}|${cfg?.email}|${cfg?.password}`;
  useEffect(() => {
    if (!auto) return;
    const first = window.setTimeout(() => void run(false), 1200);
    const t = window.setInterval(() => document.visibilityState === "visible" && void run(false), AUTO_EVERY);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [auto, cfgSig, run]);

  const spaceNotes = v.notes.filter((n) => n.spaceId === space.id);
  const spaceBoards = v.boards.filter((b) => b.spaceId === space.id);
  const changedIds =
    spaceNotes.filter((n) => syncableNote(n) && !n.pending && noteChanged(n)).map((n) => n.id).join(",") +
    "|" +
    spaceBoards.filter((b) => !b.data.joplin || hashBoard(b.data) !== b.data.joplin.hash).map((b) => b.id).join(",");
  const count = spaceNotes.length + spaceBoards.length;
  const prev = useRef({ changedIds, count });
  const editTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const p = prev.current;
    prev.current = { changedIds, count };
    // something was edited locally, or something was deleted
    const edited = changedIds !== "|" && changedIds !== p.changedIds;
    const deleted = count < p.count;
    if (!auto || !(edited || deleted)) return;
    window.clearTimeout(editTimer.current);
    editTimer.current = window.setTimeout(() => void run(false), AFTER_EDIT);
  }, [changedIds, count, auto, run]);
  useEffect(() => () => window.clearTimeout(editTimer.current), [space.id]);

  const localOnly = spaceNotes.filter((n) => !syncableNote(n)).length;

  if (!configured)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm" data-testid="bar-joplin">
        <NotebookPen className="h-4 w-4 text-primary" />
        <span className="flex-1 min-w-48">This space isn't connected to a Joplin Server yet.</span>
        <Button size="sm" onClick={onSettings} data-testid="button-joplin-connect">
          Connect
        </Button>
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2 text-sm" data-testid="bar-joplin">
      <NotebookPen className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Joplin</span>
        <span className="text-muted-foreground"> · {cfg!.url.replace(/^https?:\/\//, "")}</span>
      </span>
      <span className="text-xs text-muted-foreground" data-testid="text-joplin-status" aria-live="polite">
        {busy ? progress || "Syncing…" : !writable ? "Read-only: only members who can edit can sync" : last ? `${summary(last)} · ${ago(last.at)}` : "Not synced yet"}
      </span>
      {localOnly > 0 && !busy && <span className="text-xs text-muted-foreground" title="Password notes and special items stay in Scute only">{localOnly} Scute-only</span>}
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={() => run(true)} disabled={busy || !writable || !v.online} data-testid="button-joplin-sync">
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Sync now
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onSettings} aria-label="Joplin connection settings" data-testid="button-joplin-settings">
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
      {error && (
        <p className="basis-full flex gap-1.5 text-xs text-destructive" data-testid="text-joplin-error">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}
