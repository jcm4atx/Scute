// Share a bookmark's saved copy (page, picture, video or file) as a read-only
// page at /shared/<name>/ (Scute 1.18.0). The copy is encrypted in the browser;
// the key is in the link (#…) or behind a password, so the server can't read it.
import { useEffect, useMemo, useState } from "react";
import { Check, Copy as CopyIcon, ExternalLink, Link2, Loader2, Lock, RefreshCw, Share2, Trash2 } from "lucide-react";
import type { NoteData, SavedShare } from "@shared/schema";
import { useVault, type Note } from "@/lib/vault";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { checkShare, publishFiles, removeShare, setShareExpiry, shareUrl, type ShareInfo } from "@/lib/shares";
import { PART_BYTES, aesKey, newContentKey, seal, wrapKey, type SavedHeader, type SavedManifest } from "@/share/saved-crypto";
import { hostOf } from "@/components/note-parts";

export const SAVED_COPY_PLUGIN = "@scute/saved-copy";

const EXPIRY = [
  { v: "never", label: "Never", ms: null },
  { v: "1d", label: "In a day", ms: 86_400_000 },
  { v: "7d", label: "In a week", ms: 7 * 86_400_000 },
  { v: "30d", label: "In 30 days", ms: 30 * 86_400_000 },
] as const;

function slugify(s: string) {
  const base = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const tail = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
  return `${base || "copy"}-${tail}`;
}

export const linkFor = (s: SavedShare) => shareUrl(s.slug) + (s.mode === "link" ? `#${s.key}` : "");

/** Encrypt the copy and upload it as a share; returns what to keep in the note. */
async function publish(
  v: ReturnType<typeof useVault>,
  note: Note,
  o: { slug: string; mode: "link" | "password"; password?: string; expires: number | null; source: boolean; download: boolean; prev?: SavedShare | null },
  onProgress: (msg: string) => void,
): Promise<{ share: SavedShare; info: ShareInfo }> {
  const d = note.data;
  const a = d.archive!;
  // keep the key only for the same address and protection; anything else gets a new key, so
  // whoever had the old link or password can't open the new version
  const same = !!o.prev && o.prev.slug === o.slug && o.prev.mode === o.mode && !o.password;
  const key = same ? o.prev!.key : newContentKey();
  const wrap = o.mode === "password" ? (o.password ? await wrapKey(key, o.password) : same && o.prev!.wrap ? o.prev!.wrap : null) : undefined;
  if (o.mode === "password" && !wrap) throw new Error("Enter a password");
  const k = await aesKey(key);
  onProgress("Decrypting the copy…");
  const url = await v.getFileUrl(note, (f) => onProgress(`Decrypting the copy ${Math.round(f * 100)}%…`));
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const n = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
  // the same copy keeps the same piece names, so updating only the details doesn't upload it again
  const tag = `${a.at.toString(36)}${key.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
  const parts = Array.from({ length: n }, (_, i) => `c${tag}-${i}.bin`);
  const manifest: SavedManifest = {
    v: 1,
    title: d.title || a.title || hostOf(d.url) || "Saved copy",
    kind: a.kind,
    name: d.file?.name || "copy",
    type: d.file?.type || "application/octet-stream",
    size: bytes.length,
    parts,
    savedAt: a.at,
    sharedAt: Date.now(),
    source: o.source ? { url: a.url || d.url || "", site: a.site || d.preview?.site, uploader: a.uploader } : undefined,
    duration: a.duration || d.file?.duration,
    width: d.file?.width,
    height: d.file?.height,
    download: o.download,
  };
  const mName = `m${Date.now().toString(36)}.bin`;
  const head: SavedHeader = { v: 1, kind: "scute-saved-copy", mode: o.mode, ...(wrap ? { wrap } : {}), manifest: mName };
  const files = ["share.json", mName, ...parts];
  const info = await publishFiles(SAVED_COPY_PLUGIN, o.slug, {
    files,
    expires: o.expires,
    produce: async (f) => {
      if (f === "share.json") return JSON.stringify(head);
      if (f === mName) return seal(k, JSON.stringify(manifest));
      const i = parts.indexOf(f);
      return seal(k, bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
    },
    onProgress: (done, total) => onProgress(total > 1 ? `Encrypting and uploading ${Math.round((done / total) * 100)}%…` : "Encrypting and uploading…"),
  });
  return {
    share: { slug: o.slug, mode: o.mode, key, ...(wrap ? { wrap } : {}), at: Date.now(), copyAt: a.at, expires: info.expires, source: o.source, download: o.download },
    info,
  };
}

async function saveShare(v: ReturnType<typeof useVault>, note: Note, share: SavedShare | null) {
  const n = v.notes.find((x) => x.id === note.id) || note;
  const data: NoteData = { ...n.data, archive: n.data.archive ? { ...n.data.archive, share } : n.data.archive };
  await v.saveNote({ id: n.id, spaceId: n.spaceId, boardId: n.boardId, data });
}

export function ShareCopyDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const v = useVault();
  const live = v.notes.find((n) => n.id === note.id) || note;
  const a = live.data.archive!;
  const s = a.share || null;
  const [editing, setEditing] = useState(!s);
  const [slug, setSlug] = useState(() => s?.slug || slugify(live.data.title || a.title || hostOf(live.data.url) || "copy"));
  const [mode, setMode] = useState<"link" | "password">(s?.mode || "link");
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<string>("never");
  const [source, setSource] = useState(s?.source ?? true);
  const [download, setDownload] = useState(s?.download ?? true);
  const [busy, setBusy] = useState<string | null>(null);
  const [avail, setAvail] = useState<{ slug: string; ok: boolean; msg?: string } | null>(null);
  const [remote, setRemote] = useState<ShareInfo | null | "gone">(null);
  const [copied, setCopied] = useState(false);

  // is the published share still there (it may have expired or been removed)?
  useEffect(() => {
    if (!s) return;
    let on = true;
    checkShare(s.slug)
      .then((r) => on && setRemote(r.mine && r.share ? r.share : "gone"))
      .catch(() => on && setRemote(null));
    return () => {
      on = false;
    };
  }, [s?.slug, s?.at]); // eslint-disable-line

  // is the address free?
  useEffect(() => {
    if (!editing) return;
    const want = slug.trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(want)) {
      setAvail({ slug: want, ok: false, msg: "Lowercase letters, digits and dashes (up to 64)" });
      return;
    }
    let on = true;
    const t = setTimeout(() => {
      checkShare(want)
        .then((r) => on && setAvail({ slug: want, ok: r.valid && (r.available || (r.mine && r.share?.plugin === SAVED_COPY_PLUGIN && want === s?.slug)), msg: r.available ? undefined : r.mine ? (want === s?.slug ? undefined : "You already use this address for something else") : "Someone already uses this address" }))
        .catch(() => on && setAvail(null));
    }, 300);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [slug, editing]); // eslint-disable-line

  const link = s ? linkFor(s) : "";
  const stale = !!s && a.at > s.copyAt;
  const gone = remote === "gone";
  const expiresAt = remote && remote !== "gone" ? remote.expires : s?.expires;
  const passwordNeeded = mode === "password" && !(s?.mode === "password" && s.wrap && slug === s.slug);
  const canGo = !busy && !!avail?.ok && avail.slug === slug.trim() && (!passwordNeeded || password.length >= 4) && (mode !== "password" || !password || password.length >= 4);

  async function go(prevOverride?: SavedShare | null) {
    setBusy("Starting…");
    try {
      const ex = EXPIRY.find((e) => e.v === expiry)!;
      const keepExpiry = !editing && s ? (remote && remote !== "gone" ? remote.expires : s.expires) ?? null : ex.ms ? Date.now() + ex.ms : null;
      const prev = prevOverride === undefined ? s : prevOverride;
      const want = editing ? slug.trim() : s!.slug;
      const { share } = await publish(v, live, { slug: want, mode: editing ? mode : s!.mode, password: editing ? password : undefined, expires: keepExpiry, source, download, prev }, setBusy);
      // moved to a new address: take the old one down
      if (s && s.slug !== want) await removeShare(s.slug).catch(() => undefined);
      await saveShare(v, live, share);
      setEditing(false);
      setPassword("");
      setRemote(null);
      toast({ title: s ? "Shared copy updated" : "Shared", description: shareUrl(share.slug) });
    } catch (e) {
      toast({ title: "Couldn't share the copy", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    if (!s) return;
    setBusy("Removing…");
    try {
      await removeShare(s.slug).catch((e) => {
        if (!/404|not found|gone/i.test((e as Error).message)) throw e;
      });
      await saveShare(v, live, null);
      toast({ title: "No longer shared", description: `${shareUrl(s.slug)} is gone.` });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't stop sharing", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function changeExpiry(val: string) {
    if (!s) return;
    const ex = EXPIRY.find((e) => e.v === val)!;
    const at = ex.ms ? Date.now() + ex.ms : null;
    try {
      const info = await setShareExpiry(s.slug, at);
      setRemote(info);
      await saveShare(v, live, { ...s, expires: info.expires });
    } catch (e) {
      toast({ title: "Couldn't change it", description: (e as Error).message, variant: "destructive" });
    }
  }

  const what = useMemo(() => (a.kind === "page" ? "page" : a.kind === "image" ? "picture" : a.kind === "video" ? "video" : a.kind === "audio" ? "audio" : "file"), [a.kind]);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg" data-testid="dialog-share-copy">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" /> Share the saved {what}
          </DialogTitle>
          <DialogDescription>
            Anyone with the link {mode === "password" || s?.mode === "password" ? "and the password " : ""}can see this copy, without signing in. It's encrypted in your browser; the server only stores scrambled files.
          </DialogDescription>
        </DialogHeader>

        {s && !editing ? (
          <div className="space-y-4">
            {gone ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="text-share-gone">
                This share isn't online any more (it expired or was removed). Share it again to put it back.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label>{s.mode === "password" ? "Link (needs the password)" : "Secret link"}</Label>
                <div className="flex gap-2">
                  <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" data-testid="input-share-link" />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label="Copy the link"
                    onClick={async () => {
                      await navigator.clipboard.writeText(link).catch(() => undefined);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    data-testid="button-copy-share-link"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="icon" asChild aria-label="Open">
                    <a href={link} target="_blank" rel="noopener noreferrer" data-testid="link-open-share">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {s.mode === "password" ? <Lock className="mr-1 inline h-3 w-3" /> : <Link2 className="mr-1 inline h-3 w-3" />}
                  {s.mode === "password" ? "Protected with a password." : "The key is the part after #; anyone with the whole link can open it."} Shared {new Date(s.at).toLocaleString()}.
                  {s.source ? " Shows where it came from." : ""}
                  {s.download ? " Allows downloading." : ""}
                </p>
              </div>
            )}
            {stale && !gone && (
              <p className="rounded-md border px-3 py-2 text-sm" data-testid="text-share-stale">
                You saved a newer copy since this was shared. Update the shared copy to publish it.
              </p>
            )}
            {!gone && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0">Stops working</Label>
                <Select value="" onValueChange={changeExpiry}>
                  <SelectTrigger className="h-8" data-testid="select-share-expiry">
                    <SelectValue placeholder={expiresAt ? new Date(expiresAt).toLocaleString() : "Never"} />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((e) => (
                      <SelectItem key={e.v} value={e.v}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-share">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy}
              </p>
            )}
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" className="text-destructive" disabled={!!busy} onClick={stop} data-testid="button-stop-share">
                <Trash2 className="h-4 w-4" /> Stop sharing
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" disabled={!!busy} onClick={() => setEditing(true)} data-testid="button-edit-share">
                  Change…
                </Button>
                {(stale || gone) && (
                  <Button disabled={!!busy} onClick={() => go()} data-testid="button-update-share">
                    <RefreshCw className="h-4 w-4" /> {gone ? "Share again" : "Update shared copy"}
                  </Button>
                )}
              </div>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canGo) void go();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="share-slug">Address</Label>
              <div className="flex items-center rounded-md border bg-muted/40 pl-2 text-xs text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
                <span className="max-w-[55%] truncate" title={shareUrl("")}>{shareUrl("").replace(/^https?:\/\//, "").replace(/\/$/, "")}/</span>
                <Input id="share-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className="h-9 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0" data-testid="input-share-slug" />
              </div>
              <p className={`text-xs ${avail && !avail.ok ? "text-destructive" : "text-muted-foreground"}`} data-testid="text-share-slug">
                {avail && avail.slug === slug.trim() ? (avail.ok ? "Available." : avail.msg || "Not available.") : "Checking…"}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Who can open it</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["link", "password"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${mode === m ? "border-primary bg-primary/5" : "hover:bg-muted/60"}`}
                    aria-pressed={mode === m}
                    data-testid={`button-share-mode-${m}`}
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {m === "link" ? <Link2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                      {m === "link" ? "Anyone with the link" : "Password"}
                    </span>
                    <span className="block text-xs text-muted-foreground">{m === "link" ? "The key is part of the link" : "The link alone isn't enough"}</span>
                  </button>
                ))}
              </div>
              {mode === "password" && (
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={passwordNeeded ? "Password (4+ characters)" : "New password (leave empty to keep it)"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-share-password"
                />
              )}
            </div>
            {!s && (
              <div className="flex items-center gap-3">
                <Label className="shrink-0">Stops working</Label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger className="h-8" data-testid="select-share-expiry-new">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((e) => (
                      <SelectItem key={e.v} value={e.v}>
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2.5">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Show where it came from
                  <span className="block text-xs text-muted-foreground">The original address{a.uploader ? " and who posted it" : ""}</span>
                </span>
                <Switch checked={source} onCheckedChange={setSource} data-testid="switch-share-source" />
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Allow downloading
                  <span className="block text-xs text-muted-foreground">A download button for the {what}</span>
                </span>
                <Switch checked={download} onCheckedChange={setDownload} data-testid="switch-share-download" />
              </label>
            </div>
            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="status-share">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy}
              </p>
            )}
            <DialogFooter className="gap-2">
              {s && (
                <Button type="button" variant="ghost" disabled={!!busy} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
              <Button type="submit" disabled={!canGo} data-testid="button-publish-share">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />} {s ? "Update" : "Share"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
