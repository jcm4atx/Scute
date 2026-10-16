import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderTree, Link2, Loader2, NotebookPen, PauseCircle, RefreshCw, Settings2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { NotebookLinkConfig } from "@shared/schema";
import { api } from "@/lib/api";
import * as C from "@/lib/crypto";
import { canManage, useVault, type Space } from "@/lib/vault";

// Joplin notebook links (1.21.0): the server keeps an ordinary space and a Joplin notebook in sync.

export interface LinkStatus {
  phase: "starting" | "syncing" | "ok" | "error" | "paused";
  at?: number;
  okAt?: number;
  error?: string | null;
  code?: string;
  last?: { pulled: number; pushed: number; deleted: number; conflicts: number; files: number };
  lastAt?: number;
  notes?: number;
  boards?: number;
  files?: number;
  warnings?: string[];
}
export interface NotebookLink {
  id: string;
  spaceId: string;
  enabled: boolean;
  created: number;
  createdBy: string | null;
  running: boolean;
  status: LinkStatus;
  info: { url: string; email?: string; notebookId: string; notebookTitle: string; interval: number } | null;
}
interface Notebook {
  id: string;
  title: string;
  parentId: string;
  notes: number;
  total: number;
  taken: string | null;
}

const INTERVALS: [number, string][] = [
  [5, "Every 5 seconds"],
  [10, "Every 10 seconds"],
  [30, "Every 30 seconds"],
  [60, "Every minute"],
  [300, "Every 5 minutes"],
  [900, "Every 15 minutes"],
];
const normUrl = (u: string) => u.trim().replace(/\/+$/, "");

function ago(t: number | null | undefined, now: number) {
  if (!t) return "never";
  const s = Math.round((now - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function summary(l: LinkStatus["last"]) {
  if (!l) return "Up to date";
  const parts: string[] = [];
  if (l.pulled) parts.push(`${l.pulled} from Joplin`);
  if (l.pushed) parts.push(`${l.pushed} to Joplin`);
  if (l.files) parts.push(`${l.files} attachment${l.files === 1 ? "" : "s"}`);
  if (l.deleted) parts.push(`${l.deleted} removed`);
  if (l.conflicts) parts.push(`${l.conflicts} conflict${l.conflicts === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Up to date";
}

/** Links for the spaces this user is in; refreshed when the server says one changed. */
export function useNotebookLinks(enabled: boolean) {
  const [links, setLinks] = useState<NotebookLink[]>([]);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    try {
      setLinks((await api<{ links: NotebookLink[] }>("GET", "/api/links")).links);
    } catch {
      /* keep what we have */
    } finally {
      busy.current = false;
    }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return setLinks([]);
    void load();
    const on = () => void load();
    window.addEventListener("scute:links", on);
    const t = window.setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => {
      window.removeEventListener("scute:links", on);
      window.clearInterval(t);
    };
  }, [enabled, load]);
  // while a link is busy, look again shortly (in case change notifications don't get through a proxy)
  const busyLink = links.some((l) => l.enabled && (l.running || l.status.phase === "starting" || l.status.phase === "syncing"));
  useEffect(() => {
    if (!busyLink) return;
    const t = window.setTimeout(() => void load(), 2500);
    return () => window.clearTimeout(t);
  }, [busyLink, links, load]);
  return { links, reload: load };
}

// ------------------------------------------------------------------ status bar
export function NotebookLinkBar({ space, link, onSettings, onChanged }: { space: Space; link: NotebookLink; onSettings: () => void; onChanged: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  const st = link.status;
  const manage = canManage(space.role);
  const syncing = busy || link.running || st.phase === "syncing" || st.phase === "starting";

  async function syncNow() {
    const force = st.code === "mass-delete";
    if (force && !manage) return toast({ title: "An admin of this space needs to confirm this" });
    setBusy(true);
    try {
      const r = await api<{ status: LinkStatus }>("POST", `/api/links/${link.id}/run`, { force });
      if (r.status.phase === "error" || r.status.phase === "paused") toast({ title: "Joplin sync didn't finish", description: r.status.error || "", variant: "destructive" });
      else toast({ title: "Synced with Joplin", description: summary(r.status.last) });
    } catch (e) {
      toast({ title: "Couldn't sync", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const text = !link.enabled
    ? "Paused"
    : syncing
      ? "Syncing…"
      : st.phase === "ok"
        ? st.lastAt && now - st.lastAt < 90_000
          ? `${summary(st.last)} · ${ago(st.lastAt, now)}`
          : `Up to date · checked ${ago(st.okAt, now)}`
        : st.phase === "paused"
          ? "Paused"
          : `Last synced ${ago(st.okAt, now)}`;
  const problem = link.enabled && (st.phase === "error" || st.phase === "paused") && st.error;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-2 text-sm" data-testid="bar-notebook-link">
      <NotebookPen className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground sm:hidden">Joplin · </span>
        <span className="hidden text-muted-foreground sm:inline">Synced with Joplin notebook </span>
        <span className="font-medium" data-testid="text-link-notebook">{link.info?.notebookTitle || "…"}</span>
        {link.info && <span className="hidden text-muted-foreground sm:inline"> · {link.info.url.replace(/^https?:\/\//, "")}</span>}
      </span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-link-status" aria-live="polite">
        {!link.enabled ? <PauseCircle className="h-3.5 w-3.5" /> : st.phase === "ok" && !syncing ? <CheckCircle2 className="h-3.5 w-3.5 text-primary" /> : null}
        {text}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing || !link.enabled || !v.online} data-testid="button-link-sync">
          <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} /> Sync now
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onSettings} aria-label="Notebook link settings" data-testid="button-link-settings">
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
      {problem && (
        <p className="basis-full flex gap-1.5 text-xs text-destructive" data-testid="text-link-error">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {st.error}
          {st.code === "auth" && manage ? " Enter the new password in the link settings." : ""}
        </p>
      )}
      {!problem && link.enabled && st.warnings && st.warnings.length > 0 && (
        <p className="basis-full flex gap-1.5 text-xs text-muted-foreground" data-testid="text-link-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {st.warnings[0]}
          {st.warnings.length > 1 ? ` (+${st.warnings.length - 1} more)` : ""}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ set-up / settings dialog
export function NotebookLinkDialog({ space, link, open, onOpenChange, onChanged }: { space: Space; link: NotebookLink | null; open: boolean; onOpenChange: (o: boolean) => void; onChanged: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto" data-testid="dialog-notebook-link">
        {open && (link ? <LinkSettings space={space} link={link} onClose={() => onOpenChange(false)} onChanged={onChanged} /> : <LinkSetup space={space} onClose={() => onOpenChange(false)} onChanged={onChanged} />)}
      </DialogContent>
    </Dialog>
  );
}

function LinkSetup({ space, onClose, onChanged }: { space: Space; onClose: () => void; onChanged: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  // start from a Joplin account this person already uses in Scute, if any
  const known = useMemo(() => v.allSpaces.map((s) => s.data.joplin).find((c) => c?.url && c.email), [v.allSpaces]);
  const [url, setUrl] = useState(known?.url || "");
  const [email, setEmail] = useState(known?.email || "");
  const [password, setPassword] = useState(known?.password || "");
  const [scan, setScan] = useState<{ id: string; phase: string; fetched: number; total: number } | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [interval, setIntervalSec] = useState(10);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const valid = /^https?:\/\/[^\s/]+/i.test(url.trim()) && email.trim() && password;
  const sameAccountSpace = v.allSpaces.find((s) => s.data.kind === "joplin" && s.data.joplin && normUrl(s.data.joplin.url) === normUrl(url) && s.data.joplin.email.toLowerCase() === email.trim().toLowerCase());

  async function find(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setError(null);
    setNotebooks(null);
    setPick(null);
    try {
      const { id } = await api<{ id: string }>("POST", "/api/links/scan", { url: normUrl(url), email: email.trim(), password });
      setScan({ id, phase: "Signing in…", fetched: 0, total: 0 });
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        if (!alive.current) return;
        const s = await api<{ done: boolean; phase: string; fetched: number; total: number; error: string | null; notebooks: Notebook[] | null }>("GET", `/api/links/scan/${id}`);
        setScan({ id, phase: s.phase, fetched: s.fetched, total: s.total });
        if (!s.done) continue;
        if (s.error) throw new Error(s.error);
        setNotebooks(s.notebooks || []);
        setScanId(id);
        break;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScan(null);
    }
  }

  // notebooks as a tree, parents first
  const tree = useMemo(() => {
    if (!notebooks) return [];
    const kids = new Map<string, Notebook[]>();
    const ids = new Set(notebooks.map((n) => n.id));
    for (const n of notebooks) {
      const p = n.parentId && ids.has(n.parentId) ? n.parentId : "";
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(n);
    }
    const out: { nb: Notebook; depth: number }[] = [];
    const walk = (p: string, depth: number) => {
      for (const n of (kids.get(p) || []).sort((a, b) => a.title.localeCompare(b.title))) {
        out.push({ nb: n, depth });
        if (depth < 12) walk(n.id, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [notebooks]);
  const chosen = notebooks?.find((n) => n.id === pick) || null;

  async function start() {
    if (!chosen || !scanId) return;
    setSaving(true);
    try {
      const { publicKey } = await api<{ publicKey: string }>("GET", "/api/links/key");
      const cfg: NotebookLinkConfig = { url: normUrl(url), email: email.trim(), password, notebookId: chosen.id, notebookTitle: chosen.title, interval };
      await api("POST", "/api/links", { spaceId: space.id, sealedKey: await C.sealKey(publicKey, space.key), config: await C.encryptJson(space.key, cfg), scanId });
      toast({ title: "Syncing with Joplin", description: `“${space.data.title}” and the notebook “${chosen.title}” are now kept in sync.` });
      onChanged();
      onClose();
    } catch (err) {
      toast({ title: "Couldn't link the notebook", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" /> Sync with a Joplin notebook
        </DialogTitle>
        <DialogDescription>
          Keep “{space.data.title}” and one notebook on your Joplin Server in sync, both ways, all the time. Sub-notebooks become boards and tags stay tags.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={find} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="nl-url">Joplin Server URL</Label>
          <Input id="nl-url" type="url" inputMode="url" placeholder="https://joplin.example.com" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" data-testid="input-link-url" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="nl-email">Email</Label>
            <Input id="nl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" data-testid="input-link-email" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nl-pass">Password</Label>
            <Input id="nl-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-testid="input-link-password" />
          </div>
        </div>
        <Button type="submit" variant={notebooks ? "outline" : "default"} disabled={!valid || !!scan} className="w-full sm:w-auto" data-testid="button-link-find">
          {scan ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderTree className="h-4 w-4" />} {notebooks ? "Look again" : "Find notebooks"}
        </Button>
        {scan && (
          <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="text-link-scan">
            {scan.phase} {scan.total ? `${scan.fetched} of ${scan.total}` : ""}
          </p>
        )}
        {error && (
          <p className="flex gap-1.5 text-sm text-destructive" data-testid="text-link-scan-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
      </form>

      {notebooks && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Notebook</Label>
            {tree.length === 0 ? (
              <p className="text-sm text-muted-foreground">This Joplin account has no notebooks yet. Make one in Joplin and look again.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-md border p-1" role="radiogroup" aria-label="Notebook" data-testid="list-link-notebooks">
                {tree.map(({ nb, depth }) => (
                  <button
                    key={nb.id}
                    type="button"
                    role="radio"
                    aria-checked={pick === nb.id}
                    disabled={!!nb.taken}
                    onClick={() => setPick(nb.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${pick === nb.id ? "bg-primary/10 ring-1 ring-primary" : "hover:bg-muted"} disabled:cursor-not-allowed disabled:opacity-50`}
                    style={{ paddingLeft: 8 + depth * 18 }}
                    data-testid={`option-notebook-${nb.id}`}
                  >
                    <NotebookPen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{nb.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{nb.taken ? "linked to another space" : `${nb.total} note${nb.total === 1 ? "" : "s"}`}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Check Joplin for changes</Label>
            <Select value={String(interval)} onValueChange={(x) => setIntervalSec(Number(x))}>
              <SelectTrigger data-testid="select-link-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map(([s, label]) => (
                  <SelectItem key={s} value={String(s)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Changes made in Scute go to Joplin within a couple of seconds either way.</p>
          </div>
          {chosen && (
            <div className="space-y-2 rounded-md bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground" data-testid="text-link-explain">
              <p>
                Notes already in “{space.data.title}” are added to “{chosen.title}”, and the notebook's {chosen.total} note{chosen.total === 1 ? "" : "s"} (with sub-notebooks and attachments) are added here. When a note is
                changed in both places at once, Joplin's version wins and yours is kept as a “(conflict copy)”.
              </p>
              <p>
                To sync while nobody is signed in, this Scute server keeps a copy of this space's key, so the server can read this space (other spaces stay end-to-end encrypted). Stopping the sync
                deletes the server's copy.
              </p>
              {sameAccountSpace && <p className="text-destructive">You also have the Joplin space “{sameAccountSpace.data.title}” for this account. Notes that are in both are left out here.</p>}
            </div>
          )}
        </div>
      )}
      <DialogFooter className="gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={start} disabled={!chosen || saving} data-testid="button-link-start">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Start syncing
        </Button>
      </DialogFooter>
    </>
  );
}

function LinkSettings({ space, link, onClose, onChanged }: { space: Space; link: NotebookLink; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const manage = canManage(space.role);
  const [password, setPassword] = useState("");
  const [interval, setIntervalSec] = useState(link.info?.interval || 10);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const st = link.status;

  async function patch(body: Record<string, unknown>, done: string) {
    setSaving(true);
    try {
      await api("PATCH", `/api/links/${link.id}`, body);
      toast({ title: done });
      onChanged();
      return true;
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (password) body.password = password;
    if (interval !== link.info?.interval) body.interval = interval;
    if (!Object.keys(body).length) return onClose();
    if (await patch(body, "Notebook link saved")) onClose();
  }
  async function unlink() {
    try {
      await api("DELETE", `/api/links/${link.id}`);
      toast({ title: "Stopped syncing", description: "Notes stay where they are, in Scute and in Joplin." });
      onChanged();
      onClose();
    } catch (e) {
      toast({ title: "Couldn't stop syncing", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <NotebookPen className="h-4 w-4 text-primary" /> Joplin notebook link
        </DialogTitle>
        <DialogDescription>
          “{space.data.title}” is kept in sync with the notebook “{link.info?.notebookTitle}”{link.createdBy ? `, set up by ${link.createdBy}` : ""}.
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm" data-testid="list-link-info">
        <dt className="text-muted-foreground">Server</dt>
        <dd className="min-w-0 truncate">{link.info?.url}</dd>
        {link.info?.email && (
          <>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="min-w-0 truncate">{link.info.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">In sync</dt>
        <dd>
          {st.notes ?? 0} note{st.notes === 1 ? "" : "s"}, {st.boards ?? 0} board{st.boards === 1 ? "" : "s"}, {st.files ?? 0} attachment{st.files === 1 ? "" : "s"}
        </dd>
      </dl>
      {st.error && link.enabled && (
        <p className="flex gap-1.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {st.error}
        </p>
      )}
      {manage ? (
        <form onSubmit={save} className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div>
              <Label htmlFor="nl-on">Keep syncing</Label>
              <p className="text-xs text-muted-foreground">Pause to stop all changes in both directions for now.</p>
            </div>
            <Switch id="nl-on" checked={link.enabled} disabled={saving} onCheckedChange={(on) => void patch({ enabled: on }, on ? "Syncing again" : "Sync paused")} data-testid="switch-link-enabled" />
          </div>
          <div className="space-y-1.5">
            <Label>Check Joplin for changes</Label>
            <Select value={String(interval)} onValueChange={(x) => setIntervalSec(Number(x))}>
              <SelectTrigger data-testid="select-link-interval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTERVALS.map(([s, label]) => (
                  <SelectItem key={s} value={String(s)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nl-newpass">New Joplin password</Label>
            <Input id="nl-newpass" type="password" placeholder="Leave empty to keep the current one" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-testid="input-link-newpassword" />
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm(true)} data-testid="button-link-unlink">
              <Unlink className="h-4 w-4" /> Stop syncing
            </Button>
            <Button type="submit" disabled={saving} data-testid="button-link-save">
              Save
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">Only owners and admins of this space can change or stop the sync.</p>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop syncing with “{link.info?.notebookTitle}”?</AlertDialogTitle>
            <AlertDialogDescription>Nothing is deleted: the notes stay in this space and in Joplin, they just stop following each other. The server deletes its copy of this space's key.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep syncing</AlertDialogCancel>
            <AlertDialogAction onClick={unlink} data-testid="button-link-unlink-confirm">
              Stop syncing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
