/**
 * The page at /shared/<name>/ for a shared saved copy of a bookmark (Scute 1.18.0).
 * Built into a single HTML file (dist/viewers/saved-copy.html). It loads
 * share.json, gets the key from the link (#…) or a password, decrypts the copy in
 * the browser and shows it: pages in a sandboxed frame without scripts, images,
 * video and audio in the browser's own players, anything else as a download.
 */
import { aesKey, unseal, unsealText, unwrapKey, type SavedHeader, type SavedManifest } from "./saved-crypto";

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false | undefined)[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) (el as any)[k] = v;
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
};
const root = document.getElementById("app")!;
const show = (...n: Node[]) => root.replaceChildren(...n);

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtDur = (s: number) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

const ICON: Record<string, string> = {
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  down: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};
const icon = (n: string, size = 16) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICON[n];
  return s;
};
const LOGO = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 32 32");
  s.setAttribute("width", "20");
  s.setAttribute("height", "20");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<path d="M16 3 27 9.5v13L16 29 5 22.5v-13z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M16 9.5 21.5 12.7v6.6L16 22.5l-5.5-3.2v-6.6z" fill="currentColor" opacity=".85"/>';
  return s;
};

function message(title: string, text: string, iconName = "alert") {
  show(
    $("main", { class: "center" }, $("div", { class: "card", "data-testid": "share-message" }, $("div", { class: "badge" }, icon(iconName, 22)), $("h1", {}, title), $("p", {}, text))),
  );
}

async function fetchBytes(name: string, onChunk?: (n: number) => void): Promise<Uint8Array> {
  const r = await fetch(name, { cache: name === "share.json" ? "no-cache" : "default", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!r.ok) throw Object.assign(new Error(r.status === 410 ? "This share has expired." : r.status === 404 ? "Nothing is shared here any more." : `The server answered ${r.status}.`), { status: r.status });
  if (!onChunk || !r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function main() {
  if (!location.pathname.endsWith("/")) history.replaceState(null, "", location.pathname + "/" + location.search + location.hash);
  let head: SavedHeader;
  try {
    head = JSON.parse(new TextDecoder().decode(await fetchBytes("share.json")));
  } catch (e) {
    return message("Not available", (e as Error).message || "This share couldn't be loaded.");
  }
  if (head.kind !== "scute-saved-copy") return message("Not available", "This isn't a shared saved copy.");
  if (head.mode === "password") return askPassword(head);
  const k = location.hash.replace(/^#/, "").replace(/^k=/, "");
  if (!k) return message("The key is missing", "This link has to include everything after the # sign. Ask whoever shared it for the full link.", "lock");
  let key: CryptoKey;
  try {
    key = await aesKey(k);
    await open(head, key);
  } catch (e) {
    console.error(e);
    message("Can't open this", "The link isn't complete or isn't right. Copy the whole link, including the part after the # sign.", "lock");
  }
}

function askPassword(head: SavedHeader, wrong = false) {
  const input = $("input", { type: "password", autocomplete: "current-password", placeholder: "Password", required: true, "aria-label": "Password", "data-testid": "input-share-password" }) as HTMLInputElement;
  const btn = $("button", { type: "submit", class: "primary", "data-testid": "button-share-open" }, "Open");
  const err = $("p", { class: "err", role: "alert" }, wrong ? "That password isn't right." : "");
  const form = $(
    "form",
    {
      class: "card",
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        btn.setAttribute("disabled", "");
        btn.textContent = "Opening…";
        try {
          const key = await unwrapKey(head.wrap!, input.value);
          await open(head, key);
        } catch {
          askPassword(head, true);
        }
      },
    },
    $("div", { class: "badge" }, icon("lock", 22)),
    $("h1", {}, "This copy is protected"),
    $("p", {}, "Enter the password you were given. It never leaves this browser."),
    input,
    err,
    btn,
  );
  show($("main", { class: "center" }, form));
  input.focus();
}

async function open(head: SavedHeader, key: CryptoKey) {
  const m: SavedManifest = JSON.parse(await unsealText(key, await fetchBytes(head.manifest)));
  document.title = m.title || "Saved copy";
  // download and decrypt the pieces, with progress
  const bar = $("div", { class: "bar" }, $("span"));
  const label = $("p", { class: "muted" }, "Downloading…");
  show($("main", { class: "center" }, $("div", { class: "card", "data-testid": "share-loading" }, $("h1", {}, m.title || "Saved copy"), bar, label)));
  const total = m.size + m.parts.length * 28;
  let got = 0;
  const pieces: Uint8Array[] = [];
  for (const p of m.parts) {
    const enc = await fetchBytes(p, (n) => {
      got += n;
      (bar.firstChild as HTMLElement).style.width = `${Math.min(100, (got / total) * 100).toFixed(1)}%`;
      label.textContent = total > 2e6 ? `Downloading… ${fmtBytes(got)} of ${fmtBytes(total)}` : "Downloading…";
    });
    pieces.push(await unseal(key, enc));
  }
  const blob = new Blob(pieces as BlobPart[], { type: m.type || "application/octet-stream" });
  render(m, blob);
}

function render(m: SavedManifest, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const meta: (Node | string)[] = [];
  if (m.source?.url) {
    meta.push("Saved from ", $("a", { href: m.source.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "link-share-source" }, m.source.site || hostOf(m.source.url)));
    if (m.source.uploader) meta.push(` · by ${m.source.uploader}`);
    meta.push(` · ${fmtDate(m.savedAt)}`);
  } else meta.push(`Saved ${fmtDate(m.savedAt)}`);
  if (m.duration) meta.push(` · ${fmtDur(m.duration)}`);
  meta.push(` · ${fmtBytes(m.size)}`);
  const actions = $(
    "div",
    { class: "actions" },
    m.download ? $("a", { class: "btn", href: url, download: m.name || "copy", "data-testid": "button-share-download" }, icon("down"), $("span", {}, "Download")) : null,
    m.source?.url ? $("a", { class: "btn ghost", href: m.source.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "button-share-original" }, icon("ext"), $("span", {}, "Original")) : null,
  );
  const header = $(
    "header",
    { class: "top" },
    $("div", { class: "mark", title: "Shared from Scute" }, LOGO()),
    $("div", { class: "titles" }, $("h1", { "data-testid": "text-share-title" }, m.title || m.name || "Saved copy"), $("p", { class: "muted", "data-testid": "text-share-meta" }, ...meta)),
    actions,
  );
  let body: HTMLElement;
  if (m.kind === "page" && /html/.test(m.type)) {
    const frame = $("iframe", { title: m.title || "Saved page", sandbox: "allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer", "data-testid": "iframe-share-page" }) as HTMLIFrameElement;
    void blob.text().then((t) => (frame.srcdoc = t));
    body = $("div", { class: "stage page" }, frame);
  } else if (m.kind === "page" && /^text\//.test(m.type)) {
    const pre = $("pre", { class: "text" });
    void blob.text().then((t) => (pre.textContent = t));
    body = $("div", { class: "stage scroll" }, pre);
  } else if (m.kind === "image" || m.type.startsWith("image/")) {
    const img = $("img", { src: url, alt: m.title || "Image", "data-testid": "img-share" }) as HTMLImageElement;
    img.onclick = () => img.classList.toggle("actual");
    body = $("div", { class: "stage media" }, img);
  } else if (m.kind === "video" || m.type.startsWith("video/")) {
    body = $("div", { class: "stage media" }, $("video", { src: url, controls: true, playsInline: true, preload: "metadata", "data-testid": "video-share" }));
  } else if (m.kind === "audio" || m.type.startsWith("audio/")) {
    body = $("div", { class: "stage center" }, $("audio", { src: url, controls: true, preload: "metadata", "data-testid": "audio-share" }));
  } else {
    body = $(
      "div",
      { class: "stage center" },
      $("div", { class: "card" }, $("div", { class: "badge" }, icon("file", 22)), $("h1", {}, m.name), $("p", { class: "muted" }, `${m.type || "File"} · ${fmtBytes(m.size)}`), m.download ? $("a", { class: "btn primary", href: url, download: m.name }, icon("down"), $("span", {}, "Download")) : null),
    );
  }
  show(header, body, $("footer", { class: "foot" }, "Shared with Scute. Decrypted in your browser; the server only stores scrambled files."));
}

addEventListener("hashchange", () => location.reload());
void main();
