/**
 * Hidden spaces: kept out of sight on this account's devices, for when someone is
 * looking over your shoulder. Not a lock: the spaces still sync, stay shared, and are
 * in exports. Showing them can ask for the account password or a PIN.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useVault } from "@/lib/vault";
import * as C from "@/lib/crypto";
import type { UserSettings } from "@shared/schema";
import { Eye, EyeOff, Loader2 } from "lucide-react";

const PIN_ITER = 200_000;

async function pinHash(pin: string, salt: string, iter: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: C.fromB64(salt) as BufferSource, iterations: iter }, base, 256);
  return C.toB64(new Uint8Array(bits));
}
export async function makePin(pin: string): Promise<NonNullable<UserSettings["hiddenPin"]>> {
  const salt = C.toB64(C.randomBytes(16));
  return { salt, iter: PIN_ITER, hash: await pinHash(pin, salt, PIN_ITER) };
}
async function pinMatches(pin: string, p: UserSettings["hiddenPin"]) {
  if (!p) return false;
  const h = await pinHash(pin, p.salt, p.iter);
  // compare without an early exit
  let d = h.length ^ p.hash.length;
  for (let i = 0; i < Math.min(h.length, p.hash.length); i++) d |= h.charCodeAt(i) ^ p.hash.charCodeAt(i);
  return d === 0;
}

/** What "show" should ask for. A PIN setting without a stored PIN falls back to the password. */
export function askFor(s: UserSettings): "none" | "password" | "pin" {
  if (s.hiddenAsk === "pin") return s.hiddenPin ? "pin" : "password";
  return s.hiddenAsk || "none";
}

/** Asks for the password or PIN if one is set, then shows hidden spaces. */
export function RevealDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const v = useVault();
  const ask = askFor(v.settings);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVal("");
    setWrong(false);
    if (ask === "none") {
      v.reveal();
      onOpenChange(false);
    }
  }, [open]); // eslint-disable-line

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!val || busy) return;
    setBusy(true);
    setWrong(false);
    try {
      const ok = (ask === "pin" && (await pinMatches(val, v.settings.hiddenPin))) || (await v.checkPassword(val));
      if (!ok) {
        await new Promise((r) => setTimeout(r, 700));
        setWrong(true);
        setVal("");
        return;
      }
      v.reveal();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  if (ask === "none") return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="dialog-reveal">
        <DialogHeader>
          <DialogTitle>Show hidden spaces</DialogTitle>
          <DialogDescription>{ask === "pin" ? "Enter your PIN." : "Enter your account password."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <Input
            type="password"
            autoFocus
            autoComplete={ask === "pin" ? "off" : "current-password"}
            inputMode={ask === "pin" ? "numeric" : undefined}
            placeholder={ask === "pin" ? "PIN" : "Password"}
            value={val}
            onChange={(e) => {
              setVal(e.target.value);
              setWrong(false);
            }}
            data-testid="input-reveal"
          />
          {wrong && (
            <p className="text-xs text-destructive" data-testid="text-reveal-wrong">
              That isn't it.
            </p>
          )}
          {ask === "pin" && <p className="text-xs text-muted-foreground">Forgot the PIN? Your account password works too.</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!val || busy} data-testid="button-reveal">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Show
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → Account → Hidden spaces. */
export function HiddenSpacesSettings({ onReveal }: { onReveal: () => void }) {
  const v = useVault();
  const { toast } = useToast();
  const hidden = v.settings.hiddenSpaces || [];
  const away = hidden.filter((id) => !v.spaces.some((s) => s.id === id)).length; // hidden right now
  const locked = away > 0; // the options wait until hidden spaces are on show
  const ask = v.settings.hiddenAsk || "none";
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [pinMode, setPinMode] = useState(false);

  const save = async (p: Partial<UserSettings>, msg?: string) => {
    try {
      await v.saveSettings(p);
      if (msg) toast({ title: msg });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    }
  };

  async function savePin() {
    if (!/^\d{4,12}$/.test(pin)) return toast({ title: "Use 4 to 12 digits", variant: "destructive" });
    if (pin !== pin2) return toast({ title: "The PINs don't match", variant: "destructive" });
    setBusy(true);
    try {
      await save({ hiddenAsk: "pin", hiddenPin: await makePin(pin) }, "PIN saved");
      setPinMode(false);
      setPin("");
      setPin2("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="section-hidden-spaces">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Hidden spaces</h3>
        <p className="text-xs text-muted-foreground">
          Keep spaces out of sight on your devices, for when someone's looking at your screen. Their notes are left out of lists, search and plug-ins too. Hidden spaces still sync, stay shared with their members and are included in exports; this isn't a lock.
        </p>
      </div>

      {locked ? (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-muted-foreground" data-testid="text-hidden-count">
            <EyeOff className="h-4 w-4" /> {away === 1 ? "1 space is hidden" : `${away} spaces are hidden`}
          </span>
          <Button size="sm" variant="outline" onClick={onReveal} data-testid="button-settings-reveal">
            <Eye className="h-4 w-4" /> Show
          </Button>
        </div>
      ) : (
        <>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-md border" data-testid="list-hidden-spaces">
            {v.spaces.map((s) => (
              <li key={s.id} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.data.color }} />
                <span className="flex-1 truncate">{s.data.title}</span>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={hidden.includes(s.id)}
                    onCheckedChange={(c) =>
                      save({ hiddenSpaces: c ? [...new Set([...hidden, s.id])] : hidden.filter((x) => x !== s.id), ...(c && v.settings.defaultSpaceId === s.id ? { defaultSpaceId: null } : {}) })
                    }
                    data-testid={`check-hide-space-${s.id}`}
                  />
                  Hidden
                </label>
              </li>
            ))}
          </ul>
          {v.revealed && hidden.length > 0 && (
            <Button size="sm" variant="outline" onClick={v.conceal} data-testid="button-settings-conceal">
              <EyeOff className="h-4 w-4" /> Hide them again
            </Button>
          )}
          <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
            <span className="text-xs text-muted-foreground">To show hidden spaces, ask for</span>
            <Select
              value={pinMode ? "pin" : ask}
              onValueChange={(a) => {
                if (a === "pin") {
                  setPinMode(true);
                  if (v.settings.hiddenPin) void save({ hiddenAsk: "pin" }, "Saved");
                } else {
                  setPinMode(false);
                  void save({ hiddenAsk: a as UserSettings["hiddenAsk"], hiddenPin: undefined }, "Saved");
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-hidden-ask">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nothing</SelectItem>
                <SelectItem value="password">My account password</SelectItem>
                <SelectItem value="pin">A PIN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(pinMode || ask === "pin") && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input type="password" inputMode="numeric" autoComplete="off" placeholder={v.settings.hiddenPin ? "New PIN" : "PIN (4–12 digits)"} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))} data-testid="input-hidden-pin" />
                <Input type="password" inputMode="numeric" autoComplete="off" placeholder="Again" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 12))} data-testid="input-hidden-pin2" />
                <Button size="sm" className="h-9" onClick={savePin} disabled={busy || !pin} data-testid="button-save-pin">
                  {v.settings.hiddenPin ? "Change" : "Save PIN"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{v.settings.hiddenPin ? "A PIN is set. Your account password also works, in case you forget it." : "Until a PIN is saved, your account password is asked for."}</p>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={!!v.settings.hiddenQuiet} onCheckedChange={(c) => save({ hiddenQuiet: !!c })} data-testid="check-hidden-quiet" />
            Leave "Show hidden spaces" out of the space menu
          </label>
          <p className="text-xs text-muted-foreground">
            Either way, Ctrl+Alt+H shows or hides them, and so does this page. Once shown, they're put away again when Scute reloads, after five minutes in the background, or when you hide a space from its menu.
          </p>
        </>
      )}
    </div>
  );
}
