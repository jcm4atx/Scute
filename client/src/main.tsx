import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { APP_VERSION } from "@shared/version";

// PWA share-target / shortcut intents arrive as query params: ?new=link&url=…&title=…&text=…
try {
  const p = new URLSearchParams(window.location.search);
  if (p.has("new") || p.has("url") || p.has("text") || p.has("title")) {
    (window as any).__scuteIntent = Object.fromEntries(p.entries());
    history.replaceState(null, "", window.location.pathname + (window.location.hash || "#/"));
  }
} catch {
  /* ignore */
}

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);

// Register the service worker (skipped where unsupported, e.g. sandboxed previews)
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => {});
    // A new worker took over (after an upgrade): reload once so the new app code runs.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded || !hadController) return;
      reloaded = true;
      window.location.reload();
    });
    void checkVersion();
  });
}
const hadController = "serviceWorker" in navigator && !!navigator.serviceWorker.controller;

/** If the server runs a newer Scute than this cached page, drop the old caches and reload once. */
async function checkVersion() {
  try {
    const res = await fetch("./api/health", { cache: "no-store" });
    const { version } = await res.json();
    const key = "scute:version-reload";
    if (version && version !== APP_VERSION) {
      if (sessionStorage.getItem(key) === version) return; // already tried
      sessionStorage.setItem(key, version);
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
      window.location.reload();
    }
  } catch {
    /* offline or old server */
  }
}
