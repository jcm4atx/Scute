import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LogoMark } from "@/components/logo";
import { useVault } from "@/lib/vault";
import { api } from "@/lib/api";
import { KeyRound, Loader2, Lock, ServerCog, ShieldCheck, WifiOff } from "lucide-react";

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}
const LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"];

export default function AuthPage() {
  const v = useVault();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{ registration: string; hasUsers: boolean } | null>(null);
  const [offline, setOffline] = useState(false);
  const secure = typeof window !== "undefined" && !!window.crypto?.subtle;

  useEffect(() => {
    api("GET", "/api/health")
      .then((h) => {
        setHealth(h);
        if (!h.hasUsers) setMode("register");
      })
      .catch(() => setOffline(true));
  }, []);

  const canRegister = !health || health.registration === "open";
  const st = strength(password);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "register") {
      if (password.length < 10) return setError("Use at least 10 characters. Your password is your encryption key.");
      if (password !== confirm) return setError("Passwords don't match");
    }
    setBusy(true);
    try {
      if (mode === "login") await v.login(username.trim(), password, remember);
      else await v.register(username.trim(), password, remember);
    } catch (err) {
      const msg = (err as Error).message || "Something went wrong";
      setError(/decrypt|operation/i.test(msg) ? "Wrong username or password" : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh grid lg:grid-cols-[1.05fr_1fr] bg-background">
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-primary text-primary-foreground p-12">
        <div className="absolute inset-0 opacity-[0.12]" aria-hidden>
          <HexField />
        </div>
        <div className="relative flex items-center gap-3">
          <LogoMark className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">Scute</span>
        </div>
        <div className="relative max-w-md space-y-6">
          <h1 className="text-xl font-semibold leading-snug">
            A hard shell for the things you keep. Notes, bookmarks, passwords and files, encrypted before they leave your device.
          </h1>
          <ul className="space-y-3 text-sm opacity-90">
            <li className="flex gap-3">
              <ShieldCheck className="h-5 w-5 shrink-0" />
              <span>End-to-end encrypted with AES-256-GCM. Your server stores ciphertext only.</span>
            </li>
            <li className="flex gap-3">
              <ServerCog className="h-5 w-5 shrink-0" />
              <span>Self-hosted: one small Node process and a SQLite file.</span>
            </li>
            <li className="flex gap-3">
              <WifiOff className="h-5 w-5 shrink-0" />
              <span>Installable PWA that keeps working offline and syncs when you're back.</span>
            </li>
          </ul>
        </div>
        <p className="relative text-xs opacity-70">In the spirit of Turtl. Your password never leaves this browser.</p>
      </aside>

      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8 flex items-center gap-2 text-primary">
            <LogoMark className="h-8 w-8" />
            <span className="text-lg font-semibold text-foreground">Scute</span>
          </div>

          <div className="mb-6">
            <h2 className="text-xl font-semibold" data-testid="text-auth-title">
              {mode === "login" ? "Unlock your vault" : health && !health.hasUsers ? "Set up this server" : "Create an account"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {mode === "login"
                ? "Sign in to decrypt your notes on this device."
                : health && !health.hasUsers
                  ? "The first account becomes the server admin."
                  : "Pick a username and a strong password."}
            </p>
          </div>

          {!secure && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="status-insecure">
              This page isn't in a secure context, so the browser won't allow encryption. Serve Scute over HTTPS or open it at
              http://localhost.
            </div>
          )}
          {offline && (
            <div className="mb-4 rounded-md border bg-muted p-3 text-sm text-muted-foreground" data-testid="status-offline">
              Can't reach the Scute server. Signing in requires a connection the first time.
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                data-testid="input-username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                data-testid="input-password"
              />
              {mode === "register" && password && (
                <div className="flex items-center gap-2 pt-1" aria-live="polite">
                  <div className="flex flex-1 gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className={`h-1 flex-1 rounded-full ${i < st ? (st >= 3 ? "bg-primary" : "bg-chart-2") : "bg-muted"}`} />
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground w-16 text-right">{LABELS[st]}</span>
                </div>
              )}
            </div>
            {mode === "register" && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  data-testid="input-confirm"
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <Checkbox checked={remember} onCheckedChange={(c) => setRemember(!!c)} data-testid="checkbox-remember" />
              Stay unlocked on this device
            </label>

            {mode === "register" && (
              <div className="flex gap-2 rounded-md bg-accent p-3 text-xs text-accent-foreground">
                <KeyRound className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  There is no password reset. Your password derives the key that unlocks your data, so if it's lost, the data is too.
                </span>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" role="alert" data-testid="text-auth-error">
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={busy || !secure} data-testid="button-submit-auth">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              {busy ? (mode === "login" ? "Deriving keys…" : "Generating keys…") : mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>

          {canRegister && health?.hasUsers !== false && (
            <p className="mt-6 text-sm text-muted-foreground text-center">
              {mode === "login" ? "New here? " : "Already have an account? "}
              <button
                type="button"
                className="text-primary font-medium hover:underline"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
                data-testid="button-toggle-auth-mode"
              >
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
          )}
          {!canRegister && mode === "login" && (
            <p className="mt-6 text-xs text-muted-foreground text-center">Registration is closed on this server.</p>
          )}
        </div>
      </main>
    </div>
  );
}

function HexField() {
  const hexes: JSX.Element[] = [];
  const r = 44;
  const w = Math.sqrt(3) * r;
  for (let row = 0; row < 14; row++) {
    for (let col = 0; col < 10; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0);
      const cy = row * r * 1.5;
      const pts = [0, 1, 2, 3, 4, 5]
        .map((i) => {
          const a = (Math.PI / 180) * (60 * i - 90);
          return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
        })
        .join(" ");
      hexes.push(<polygon key={`${row}-${col}`} points={pts} />);
    }
  }
  return (
    <svg className="h-full w-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 700 900">
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        {hexes}
      </g>
    </svg>
  );
}
