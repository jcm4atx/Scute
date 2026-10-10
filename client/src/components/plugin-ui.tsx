import { useEffect, useRef, useState } from "react";
import { Puzzle, Loader2, Upload, Trash2, RefreshCw, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { useVault, type Note } from "@/lib/vault";
import { closePluginDialog, keyLabel, PluginIcon, reloadPlugins, toPlain, usePlugins, type Ctx, type PluginInfo } from "@/lib/plugins";

/** Buttons plug-ins add to the note view (scute.noteActions.register). */
export function PluginNoteActions({ note }: { note: Note }) {
  const { reg } = usePlugins();
  const [busy, setBusy] = useState<string | null>(null);
  if (!reg.noteActions.length) return null;
  const actions = reg.noteActions.filter((a) => !a.when || a.when(toPlain(note, a.pluginId)));
  return (
    <>
      {actions.map((a) => (
        <Button
          key={a.uid}
          variant="outline"
          disabled={busy === a.uid}
          onClick={async () => {
            setBusy(a.uid);
            try {
              await a.run(toPlain(note, a.pluginId), { spaceId: note.spaceId, boardId: note.boardId, noteId: note.id });
            } finally {
              setBusy(null);
            }
          }}
          data-testid={`button-plugin-action-${a.pluginId}-${a.id}`}
        >
          {busy === a.uid ? <Loader2 className="h-4 w-4 animate-spin" /> : a.icon ? <PluginIcon icon={a.icon} /> : <Puzzle className="h-4 w-4" />}
          {a.title}
        </Button>
      ))}
    </>
  );
}

/** Header menu listing plug-in commands. Hidden when no plug-in added any. */
export function PluginCommandsMenu({ ctx }: { ctx: () => Ctx }) {
  const { reg } = usePlugins();
  if (!reg.commands.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Plug-in commands" title="Plug-in commands" data-testid="button-plugin-commands">
          <Puzzle className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Plug-in commands</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {reg.commands.map((c) => (
          <DropdownMenuItem key={c.uid} onSelect={() => c.run(ctx())} data-testid={`menu-plugin-command-${c.pluginId}-${c.id}`}>
            {c.icon ? <PluginIcon icon={c.icon} /> : <Puzzle className="h-4 w-4 text-muted-foreground" />}
            <span className="flex-1">{c.title}</span>
            {c.key && <DropdownMenuShortcut>{keyLabel(c.key)}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** alert / confirm / prompt dialogs requested by plug-ins. */
export function PluginDialogHost() {
  const { dialog } = usePlugins();
  const [value, setValue] = useState("");
  useEffect(() => setValue(dialog?.value ?? ""), [dialog]);
  if (!dialog) return null;
  const cancel = () => closePluginDialog(dialog.kind === "confirm" ? false : dialog.kind === "prompt" ? null : undefined);
  const ok = () => closePluginDialog(dialog.kind === "confirm" ? true : dialog.kind === "prompt" ? value : undefined);
  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="max-w-sm" data-testid="dialog-plugin">
        <DialogHeader>
          <DialogTitle>{dialog.title}</DialogTitle>
          {dialog.message && <DialogDescription className="whitespace-pre-wrap">{dialog.message}</DialogDescription>}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ok();
          }}
          className="space-y-4"
        >
          {dialog.kind === "prompt" && <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} data-testid="input-plugin-prompt" />}
          <DialogFooter className="gap-2">
            {dialog.kind !== "alert" && (
              <Button type="button" variant="ghost" onClick={cancel} data-testid="button-plugin-cancel">
                Cancel
              </Button>
            )}
            <Button type="submit" autoFocus={dialog.kind !== "prompt"} data-testid="button-plugin-ok">
              {dialog.okLabel || "OK"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const PERM_TEXT: Record<string, string> = {
  "notes:read": "Read your notes",
  "notes:write": "Create, change and delete notes",
  storage: "Save its own settings",
  network: "Talk to other websites",
  publish: "Publish pages at /shared/",
  drive: "Use your Scute Drive files",
  inbox: "Receive data other apps send to Scute (e.g. your location)",
  fediverse: "Use your Fediverse account: read and post as you, follow people",
};

/** Settings → Plug-ins tab. */
export function PluginsSettings() {
  const v = useVault();
  const { toast } = useToast();
  const { available, list, status } = usePlugins();
  const admin = !!v.user?.isAdmin;
  const [busy, setBusy] = useState<string | null>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const userOff = new Set(v.settings.pluginsOff || []);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast({ title: done });
      reloadPlugins();
    } catch (e) {
      toast({ title: "Something went wrong", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const setUserOff = (id: string, off: boolean) =>
    run(`user:${id}`, () => {
      const s = new Set(userOff);
      off ? s.add(id) : s.delete(id);
      return v.saveSettings({ pluginsOff: [...s] });
    });

  if (!available) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="text-plugins-off">
        Plug-ins are turned off on this server.
      </p>
    );
  }

  const visible = admin ? list : list.filter((p) => p.enabled);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Plug-ins add commands, note buttons, views and templates to Scute. They run inside the app with full access to what you can see, so only install ones you trust.
        {admin ? " As the server admin you choose which ones are available to everyone; each person can still switch them off for themselves." : " The server admin chooses which plug-ins are available."}
      </p>

      {admin && (
        <div className="flex flex-wrap gap-2">
          <input
            ref={zipRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            data-testid="input-plugin-zip"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              void run("zip", async () => {
                const p = await api<PluginInfo>("POST", "/api/plugins", undefined, f);
                toast({ title: `Installed ${p.name} ${p.version}`, description: "Turn on “Available to everyone” to use it." });
              });
            }}
          />
          <Button variant="outline" size="sm" onClick={() => zipRef.current?.click()} disabled={busy === "zip"} data-testid="button-install-plugin">
            {busy === "zip" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Install from .zip
          </Button>
          <Button variant="ghost" size="sm" onClick={() => reloadPlugins()} data-testid="button-reload-plugins">
            <RefreshCw className="h-4 w-4" />
            Reload plug-ins
          </Button>
        </div>
      )}

      {visible.length === 0 && (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground" data-testid="text-no-plugins">
          {admin ? "No plug-ins yet. Upload a .zip or copy a plug-in folder into the server's plugins directory." : "No plug-ins are available on this server."}
        </p>
      )}

      <ul className="space-y-3">
        {visible.map((p) => {
          const st = status[p.id];
          const err = p.error || (st?.state === "error" ? st.error : undefined);
          return (
            <li key={p.id} className="rounded-md border p-3 space-y-2" data-testid={`row-plugin-${p.id}`}>
              <div className="flex items-start gap-3">
                <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold">{p.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{p.version}</span>
                    {p.source === "bundled" && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">example</span>}
                    {st?.state === "active" && <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] text-accent-foreground" data-testid={`status-plugin-${p.id}`}>running</span>}
                  </div>
                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                  {(p.author || p.homepage) && (
                    <p className="text-xs text-muted-foreground">
                      {p.author}
                      {p.homepage && (
                        <a href={p.homepage} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline">
                          website <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </p>
                  )}
                  {p.permissions.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Can: {p.permissions.map((x) => PERM_TEXT[x] || x).join(" · ")}
                    </p>
                  )}
                </div>
              </div>
              {err && (
                <p className="flex items-start gap-1.5 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive" data-testid={`text-plugin-error-${p.id}`}>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {err}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pl-7">
                {admin && (
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={p.enabled}
                      disabled={!!p.error || busy === `admin:${p.id}`}
                      onCheckedChange={(on) => run(`admin:${p.id}`, () => api("PUT", `/api/plugins/${encodeURIComponent(p.id)}`, { enabled: on }))}
                      data-testid={`switch-plugin-enabled-${p.id}`}
                    />
                    Available to everyone
                  </label>
                )}
                {p.enabled && !p.error && (
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={!userOff.has(p.id)} disabled={busy === `user:${p.id}`} onCheckedChange={(on) => setUserOff(p.id, !on)} data-testid={`switch-plugin-mine-${p.id}`} />
                    Use it myself
                  </label>
                )}
                {admin && p.source === "installed" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 text-destructive hover:text-destructive"
                    disabled={busy === `rm:${p.id}`}
                    onClick={() => {
                      if (confirm(`Remove ${p.name} from the server?`)) void run(`rm:${p.id}`, () => api("DELETE", `/api/plugins/${encodeURIComponent(p.id)}`), `${p.name} removed`);
                    }}
                    data-testid={`button-remove-plugin-${p.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
