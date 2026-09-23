import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { APP_VERSION } from "@shared/version";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { Role } from "@shared/schema";
import { SPACE_COLORS, canManage, useVault, type Space } from "@/lib/vault";
import { api } from "@/lib/api";
import { Crown, Download, Loader2, LogOut, MonitorSmartphone, Trash2, Upload, UserPlus } from "lucide-react";

const ROLE_HELP: Record<Role, string> = {
  owner: "Full control",
  admin: "Can edit and invite",
  member: "Can add and edit",
  guest: "Read only",
};

// ---------------- Space dialog ----------------
export function SpaceDialog({
  open,
  onOpenChange,
  space,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  space: Space | null; // null = create
  onCreated?: (id: string) => void;
}) {
  const v = useVault();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [color, setColor] = useState(SPACE_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [invUser, setInvUser] = useState("");
  const [invRole, setInvRole] = useState<Role>("member");
  const [lastFp, setLastFp] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(space?.data.title || "");
    setColor(space?.data.color || SPACE_COLORS[(v.spaces.length + 1) % SPACE_COLORS.length]);
    setInvUser("");
    setLastFp(null);
    setConfirmDelete("");
  }, [open, space?.id]); // eslint-disable-line

  const live = space ? v.spaces.find((s) => s.id === space.id) || space : null;
  const manage = canManage(live?.role);
  const me = v.user?.id;

  async function saveMeta() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (live) {
        await v.updateSpace(live, { title: title.trim(), color });
        toast({ title: "Space updated" });
      } else {
        const id = await v.createSpace({ title: title.trim(), color });
        onCreated?.(id);
        onOpenChange(false);
      }
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!live || !invUser.trim()) return;
    setBusy(true);
    try {
      const fp = await v.inviteMember(live, invUser.trim(), invRole);
      setLastFp(`${invUser.trim()} · key fingerprint ${fp}`);
      setInvUser("");
      toast({ title: "Invite sent", description: "They'll see it the next time they open Scute." });
    } catch (e) {
      toast({ title: "Couldn't invite", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto" data-testid="dialog-space">
        <DialogHeader>
          <DialogTitle>{live ? "Space settings" : "New space"}</DialogTitle>
          <DialogDescription>
            {live ? "Spaces are the unit of sharing. Everyone in a space holds its key." : "Spaces keep separate collections apart, like Personal and Work."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sp-title">Name</Label>
            <Input id="sp-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!live && !manage} data-testid="input-space-title" />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex gap-2">
              {SPACE_COLORS.map((c) => (
                <button key={c} type="button" disabled={!!live && !manage} onClick={() => setColor(c)} className={`h-7 w-7 rounded-full border-2 ${color === c ? "border-foreground" : "border-transparent"}`} style={{ background: c }} aria-label={`Color ${c}`} data-testid={`button-space-color-${c.slice(1)}`} />
              ))}
            </div>
          </div>
          {(!live || manage) && (
            <div className="flex justify-end">
              <Button onClick={saveMeta} disabled={busy || !title.trim()} data-testid="button-save-space">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {live ? "Save" : "Create space"}
              </Button>
            </div>
          )}

          {live && (
            <>
              <div className="border-t pt-4 space-y-3">
                <h3 className="text-sm font-semibold">Members</h3>
                <ul className="divide-y rounded-md border" data-testid="list-members">
                  {live.members.map((m) => (
                    <li key={m.user_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold uppercase">{m.username.slice(0, 2)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium">
                          {m.username}
                          {m.user_id === me && <span className="text-muted-foreground font-normal"> (you)</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">{m.status === "pending" ? "Invite pending" : ROLE_HELP[m.role]}</div>
                      </div>
                      {m.role === "owner" ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Crown className="h-3.5 w-3.5" /> Owner
                        </span>
                      ) : manage && m.user_id !== me ? (
                        <>
                          <Select value={m.role} onValueChange={(r) => v.setMemberRole(live.id, m.user_id, r as Role).catch((e) => toast({ title: "Couldn't change role", description: e.message, variant: "destructive" }))}>
                            <SelectTrigger className="h-8 w-28" data-testid={`select-role-${m.user_id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {live.role === "owner" && <SelectItem value="admin">Admin</SelectItem>}
                              <SelectItem value="member">Member</SelectItem>
                              <SelectItem value="guest">Guest</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button size="icon" variant="ghost" aria-label={`Remove ${m.username}`} onClick={() => v.removeMember(live.id, m.user_id).catch((e) => toast({ title: "Couldn't remove", description: e.message, variant: "destructive" }))} data-testid={`button-remove-${m.user_id}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <span className="text-xs capitalize text-muted-foreground">{m.role}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {manage && (
                  <form onSubmit={invite} className="flex gap-2">
                    <Input placeholder="Username on this server" value={invUser} onChange={(e) => setInvUser(e.target.value)} autoCapitalize="none" data-testid="input-invite-username" />
                    <Select value={invRole} onValueChange={(r) => setInvRole(r as Role)}>
                      <SelectTrigger className="w-28" data-testid="select-invite-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {live.role === "owner" && <SelectItem value="admin">Admin</SelectItem>}
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="guest">Guest</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button type="submit" disabled={busy || !invUser.trim()} data-testid="button-invite">
                      <UserPlus className="h-4 w-4" />
                      Invite
                    </Button>
                  </form>
                )}
                {lastFp && <p className="text-xs text-muted-foreground font-mono break-all">{lastFp}</p>}
                <p className="text-xs text-muted-foreground">
                  The space key is sealed to the invitee's public key in your browser. The server can't read it. Removing someone stops future sync, but they may keep what they already downloaded.
                </p>
              </div>

              <div className="border-t pt-4">
                {live.role === "owner" ? (
                  <div className="space-y-2">
                    <Label htmlFor="sp-del" className="text-destructive">
                      Delete space
                    </Label>
                    <p className="text-xs text-muted-foreground">Deletes every note, board and file in it for all members. Type the space name to confirm.</p>
                    <div className="flex gap-2">
                      <Input id="sp-del" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={live.data.title} data-testid="input-confirm-delete-space" />
                      <Button
                        variant="destructive"
                        disabled={confirmDelete !== live.data.title || v.spaces.length <= 1}
                        onClick={async () => {
                          await v.deleteSpace(live.id);
                          onOpenChange(false);
                          toast({ title: "Space deleted" });
                        }}
                        data-testid="button-delete-space"
                      >
                        Delete
                      </Button>
                    </div>
                    {v.spaces.length <= 1 && <p className="text-xs text-muted-foreground">You need at least one space.</p>}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      await v.removeMember(live.id, me!);
                      onOpenChange(false);
                      toast({ title: "You left the space" });
                    }}
                    data-testid="button-leave-space"
                  >
                    <LogOut className="h-4 w-4" />
                    Leave space
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Settings dialog ----------------
interface SessionRow {
  id: string;
  label: string;
  created: number;
  lastSeen: number;
  current: boolean;
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const v = useVault();
  const { toast } = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [importTarget, setImportTarget] = useState<string>("new");
  const [progress, setProgress] = useState<string | null>(null);
  const [delPw, setDelPw] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSessions = () =>
    api<SessionRow[]>("GET", "/api/me/sessions")
      .then(setSessions)
      .catch(() => setSessions([]));

  useEffect(() => {
    if (open) {
      setCur("");
      setNext("");
      setNext2("");
      setDelPw("");
      setProgress(null);
      void loadSessions();
    }
  }, [open]);

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 10) return toast({ title: "Use at least 10 characters", variant: "destructive" });
    if (next !== next2) return toast({ title: "New passwords don't match", variant: "destructive" });
    setBusy(true);
    try {
      await v.changePassword(cur, next);
      toast({ title: "Password changed", description: "Other devices were signed out." });
      setCur("");
      setNext("");
      setNext2("");
      void loadSessions();
    } catch (e) {
      toast({ title: "Couldn't change password", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    setBusy(true);
    try {
      const data = await v.exportData(includeFiles);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `scute-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast({ title: "Export ready", description: "This file is NOT encrypted. Store it somewhere safe." });
    } catch (e) {
      toast({ title: "Export failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function doImport(f: File | null) {
    if (!f) return;
    setBusy(true);
    setProgress("Reading file…");
    try {
      const json = JSON.parse(await f.text());
      const n = await v.importData(json, importTarget === "new" ? null : importTarget, (d, t) => setProgress(`Encrypting ${d} of ${t}…`));
      toast({ title: `Imported ${n} items` });
      setProgress(null);
    } catch (e) {
      toast({ title: "Import failed", description: (e as Error).message, variant: "destructive" });
      setProgress(null);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto" data-testid="dialog-settings">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Signed in as <span className="font-medium text-foreground">{v.user?.username}</span>
            {v.user?.isAdmin && " · server admin"}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="account">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="account" data-testid="tab-account">Account</TabsTrigger>
            <TabsTrigger value="devices" data-testid="tab-devices">Devices</TabsTrigger>
            <TabsTrigger value="data" data-testid="tab-data">Data</TabsTrigger>
          </TabsList>

          <TabsContent value="account" className="space-y-6 pt-3">
            <form onSubmit={changePw} className="space-y-3">
              <h3 className="text-sm font-semibold">Change password</h3>
              <p className="text-xs text-muted-foreground">Your master key is re-wrapped with the new password. Notes don't need to be re-encrypted.</p>
              <Input type="password" placeholder="Current password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} data-testid="input-current-password" />
              <Input type="password" placeholder="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} data-testid="input-new-password" />
              <Input type="password" placeholder="Confirm new password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} data-testid="input-confirm-new-password" />
              <Button type="submit" disabled={busy || !cur || !next} data-testid="button-change-password">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Change password
              </Button>
            </form>
            <div className="border-t pt-4 space-y-2">
              <h3 className="text-sm font-semibold text-destructive">Delete account</h3>
              <p className="text-xs text-muted-foreground">Permanently deletes your account and every space you own, including shared ones.</p>
              <div className="flex gap-2">
                <Input type="password" placeholder="Password" value={delPw} onChange={(e) => setDelPw(e.target.value)} data-testid="input-delete-password" />
                <Button
                  variant="destructive"
                  disabled={!delPw || busy}
                  onClick={async () => {
                    try {
                      await v.deleteAccount(delPw);
                    } catch (e) {
                      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
                    }
                  }}
                  data-testid="button-delete-account"
                >
                  Delete
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="devices" className="space-y-3 pt-3">
            <p className="text-xs text-muted-foreground">Devices signed in to your account. Revoking a device signs it out on its next sync.</p>
            {!sessions ? (
              <div className="h-24 animate-pulse rounded-md bg-muted" />
            ) : (
              <ul className="divide-y rounded-md border">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{s.label || "Unknown device"}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.current ? "This device" : `Last active ${new Date(s.lastSeen).toLocaleDateString()}`}
                      </div>
                    </div>
                    {!s.current && (
                      <Button size="sm" variant="ghost" onClick={() => api("DELETE", `/api/me/sessions/${s.id}`).then(loadSessions)} data-testid={`button-revoke-${s.id}`}>
                        Revoke
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {sessions && sessions.length > 1 && (
              <Button variant="outline" size="sm" onClick={() => api("DELETE", "/api/me/sessions").then(loadSessions)} data-testid="button-revoke-all">
                Sign out all other devices
              </Button>
            )}
          </TabsContent>

          <TabsContent value="data" className="space-y-6 pt-3">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Export</h3>
              <p className="text-xs text-muted-foreground">Downloads everything you can access as decrypted JSON.</p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={includeFiles} onCheckedChange={(c) => setIncludeFiles(!!c)} data-testid="checkbox-include-files" />
                Include attachments
              </label>
              <Button variant="outline" onClick={doExport} disabled={busy} data-testid="button-export">
                <Download className="h-4 w-4" />
                Export JSON
              </Button>
            </div>
            <div className="border-t pt-4 space-y-2">
              <h3 className="text-sm font-semibold">Import</h3>
              <p className="text-xs text-muted-foreground">Accepts a Scute export or a Turtl JSON backup (best effort). Everything is encrypted on this device as it's imported.</p>
              <Select value={importTarget} onValueChange={setImportTarget}>
                <SelectTrigger data-testid="select-import-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">Recreate spaces from the file</SelectItem>
                  {v.spaces
                    .filter((s) => s.role !== "guest")
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        Into “{s.data.title}”
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => doImport(e.target.files?.[0] || null)} data-testid="input-import-file" />
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="button-import">
                {progress ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {progress || "Choose file"}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter className="sm:justify-start">
          <p className="text-xs text-muted-foreground" data-testid="text-app-version">
            Scute {APP_VERSION}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
