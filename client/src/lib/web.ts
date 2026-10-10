// Bookmarks: previews (image / video / page), duplicate detection and saved copies.
// The server only fetches bytes (POST /api/web/fetch); parsing, inlining and
// thumbnails happen here, and results are encrypted like any other note data.

import { API_BASE } from "./queryClient";
import { getToken, ApiError, NetworkError, api } from "./api";
import { embedFor, makeVideoPoster } from "./media";

export type LinkKind = "page" | "image" | "video" | "audio" | "file";

let features: string[] | null = null;
let featuresP: Promise<string[]> | null = null;
/** The server's optional features (from /api/health), fetched once. */
export async function serverFeatures(): Promise<string[]> {
  if (features) return features;
  featuresP ||= api<{ features: string[] }>("GET", "/api/health")
    .then((r) => (features = r.features || []))
    .catch(() => {
      featuresP = null;
      return [] as string[];
    });
  return featuresP;
}
/** What's known so far without waiting (null until /api/health answered). */
export const knownFeatures = () => features;
/** True when this server can fetch web pages (SCUTE_ARCHIVE not off). */
export async function webEnabled(): Promise<boolean> {
  return (await serverFeatures()).includes("web-archive");
}
/** True when this server can download videos (yt-dlp installed, SCUTE_MEDIA not off). */
export async function mediaEnabled(): Promise<boolean> {
  return (await serverFeatures()).includes("media-download");
}

export interface Fetched {
  bytes: Uint8Array;
  type: string; // upstream content type (lower case, no params)
  charset: string | null;
  finalUrl: string;
  status: number;
  total: number | null; // full size when known
  truncated: boolean;
}

/** Fetch a public URL through the Scute server. */
export async function webFetch(url: string, opts: { maxBytes?: number; partial?: boolean; accept?: string; signal?: AbortSignal; onProgress?: (got: number, total: number | null) => void } = {}): Promise<Fetched> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/web/fetch`, { method: "POST", headers, cache: "no-store", signal: opts.signal, body: JSON.stringify({ url, maxBytes: opts.maxBytes, partial: opts.partial, accept: opts.accept }) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new NetworkError((e as Error).message || "Network error");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).message || msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get("x-upstream-type") || "";
  const total = Number(res.headers.get("x-upstream-length") || 0) || null;
  const chunks: Uint8Array[] = [];
  let got = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    opts.onProgress?.(got, total);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  const status = Number(res.headers.get("x-upstream-status") || 0);
  let finalUrl = url;
  try {
    finalUrl = decodeURI(res.headers.get("x-final-url") || url);
  } catch {
    /* keep */
  }
  return {
    bytes,
    type: ct.split(";")[0].trim().toLowerCase(),
    charset: ct.match(/charset=["']?([\w-]+)/i)?.[1] || null,
    finalUrl,
    status,
    total,
    truncated: !!opts.maxBytes && got >= opts.maxBytes && (total == null || total > got),
  };
}

// ---------- duplicates ----------

const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|si|ref_src|ref_url|_hsenc|_hsmi|mkt_tok|yclid|spm|oly_anon_id|oly_enc_id|vero_id|__s)$/i;

/**
 * A comparison key for a URL: scheme and "www." ignored, host lower-cased,
 * default ports, tracking parameters, fragments (except #! routes) and
 * trailing slashes removed, remaining parameters sorted. YouTube and Vimeo
 * links collapse to their video id.
 */
export function urlKey(raw?: string | null): string {
  if (!raw) return "";
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  const e = embedFor(u.href);
  if (e && (e.kind === "youtube" || e.kind === "vimeo")) return `${e.kind}:${e.id}`;
  if (!/^https?:$/.test(u.protocol)) return u.href;
  const host = u.hostname.toLowerCase().replace(/^(www\d?|m|mobile)\./, "");
  const port = u.port && u.port !== "80" && u.port !== "443" ? ":" + u.port : "";
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  const q = params.length ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  let path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/(index\.(html?|php|aspx?))?$/i, "");
  try {
    path = decodeURI(path);
  } catch {
    /* keep */
  }
  const hash = u.hash.startsWith("#!") || u.hash.startsWith("#/") ? u.hash : "";
  return `${host}${port}${path}${q}${hash}`;
}

// ---------- previews ----------

export interface LinkPreview {
  kind: LinkKind;
  url: string; // final URL after redirects
  title?: string;
  description?: string;
  site?: string;
  image?: string; // absolute URL of a preview image
  mime?: string;
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|jfif|heic)(\?|#|$)/i;
const VID_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv)(\?|#|$)/i;
const AUD_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i;

/** What the URL looks like, without fetching anything. */
export function guessKind(url?: string | null): LinkKind | null {
  if (!url) return null;
  const e = embedFor(url);
  if (e) return e.kind === "direct" ? e.media : "video";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* raw */
  }
  if (/\/wiki\/[^/]+:/.test(path)) return null; // a wiki page about a file (Commons "File:x.jpg")
  if (IMG_EXT.test(path)) return "image";
  if (VID_EXT.test(path)) return "video";
  if (AUD_EXT.test(path)) return "audio";
  return null;
}

function kindOfMime(t: string): LinkKind | null {
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "text/html" || t === "application/xhtml+xml") return "page";
  if (t) return t.startsWith("text/") ? "page" : "file";
  return null;
}

export function decodeText(f: Pick<Fetched, "bytes" | "charset">): string {
  let cs = f.charset;
  if (!cs) {
    const head = new TextDecoder("latin1").decode(f.bytes.subarray(0, 4096));
    cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || "utf-8";
  }
  try {
    return new TextDecoder(cs).decode(f.bytes);
  } catch {
    return new TextDecoder("utf-8").decode(f.bytes);
  }
}

function meta(doc: Document, ...names: string[]) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const c = el?.getAttribute("content")?.trim();
    if (c) return c;
  }
  return undefined;
}
const abs = (u: string | undefined | null, base: string) => {
  if (!u) return undefined;
  try {
    return new URL(u, base).href;
  } catch {
    return undefined;
  }
};

/** Read title, description, preview image and kind from a page's HTML. */
/** Sites whose pages are mostly one picture (their og:image is the picture itself). */
const PHOTO_PAGE = [
  /(^|\.)imgur\.com$/,
  /(^|\.)flickr\.com$/,
  /(^|\.)unsplash\.com$/,
  /(^|\.)pexels\.com$/,
  /(^|\.)pixabay\.com$/,
  /(^|\.)deviantart\.com$/,
  /(^|\.)artstation\.com$/,
  /(^|\.)500px\.com$/,
  /(^|\.)ibb\.co$/,
  /(^|\.)imgbox\.com$/,
  /(^|\.)postimg\.cc$/,
  /(^|\.)gyazo\.com$/,
  /(^|\.)pinterest\.[a-z.]+$/,
];
const PHOTO_PATH = /\/(photos?|art|artwork|pin|gallery|image|images)\/[^/]/i;
const IMAGE_HOSTS = /(^|\.)(imgur\.com|ibb\.co|imgbox\.com|postimg\.cc|gyazo\.com)$/;
export function isPhotoPage(url: string, ogType = "", card = "") {
  if (/(^|[.:])(photo|image|picture)$/i.test(ogType) || card === "photo") return true;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "");
    if (/^commons\.wikimedia\.org$/.test(h)) return /^\/wiki\/File:.+\.(jpe?g|png|gif|webp|tiff?)$/i.test(decodeURIComponent(u.pathname));
    return PHOTO_PAGE.some((r) => r.test(h)) && (IMAGE_HOSTS.test(h) || PHOTO_PATH.test(u.pathname));
  } catch {
    return false;
  }
}

function isWikiMediaFile(url: string, ext: RegExp) {
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    return /\/wiki\/File:/.test(p) && ext.test(p);
  } catch {
    return false;
  }
}

export function pageInfo(html: string, base: string): Omit<LinkPreview, "url" | "kind"> & { video?: boolean; photo?: boolean } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const baseHref = abs(doc.querySelector("base[href]")?.getAttribute("href"), base) || base;
  const ogType = (meta(doc, "og:type") || "").toLowerCase();
  const video = ogType.startsWith("video") || !!meta(doc, "og:video", "og:video:url", "og:video:secure_url", "twitter:player") || meta(doc, "twitter:card") === "player" || isWikiMediaFile(base, /\.(webm|ogv|mp4|mov|mkv|ogg|oga|opus|mp3|wav|flac)$/i);
  let image = abs(meta(doc, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "thumbnailUrl", "image"), baseHref);
  if (!image) image = abs(doc.querySelector('link[rel="image_src"]')?.getAttribute("href"), baseHref);
  const title = (meta(doc, "og:title", "twitter:title") || doc.title || "").replace(/\s+/g, " ").trim().slice(0, 300) || undefined;
  const description = (meta(doc, "og:description", "twitter:description", "description") || "").replace(/\s+/g, " ").trim().slice(0, 500) || undefined;
  const site = meta(doc, "og:site_name", "application-name")?.slice(0, 100);
  const photo = !video && !!image && isPhotoPage(base, ogType, meta(doc, "twitter:card") || "");
  return { title, description, site, image, video, photo };
}

/** Look a link up: what it is (image, video, page…), its title and a preview image. */
export async function inspectLink(url: string, signal?: AbortSignal): Promise<LinkPreview> {
  const e = embedFor(url);
  if (e?.kind === "youtube") {
    const out: LinkPreview = { kind: "video", url, site: "YouTube", image: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` };
    try {
      const o = await webFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${e.id}`)}`, { maxBytes: 64 * 1024, signal });
      const j = JSON.parse(decodeText(o));
      out.title = j.title;
      if (j.author_name) out.description = `by ${j.author_name}`;
    } catch {
      /* private or deleted video: keep the id-based thumbnail */
    }
    return out;
  }
  if (e?.kind === "vimeo") {
    const out: LinkPreview = { kind: "video", url, site: "Vimeo" };
    try {
      const o = await webFetch(`https://vimeo.com/api/oembed.json?width=640&url=${encodeURIComponent(url)}`, { maxBytes: 64 * 1024, signal });
      const j = JSON.parse(decodeText(o));
      out.title = j.title;
      out.image = j.thumbnail_url;
      if (j.author_name) out.description = `by ${j.author_name}`;
    } catch {
      /* private video */
    }
    return out;
  }
  const guessed = guessKind(url);
  // media files: a small head is enough to confirm the type
  const f = await webFetch(url, { maxBytes: guessed && guessed !== "page" ? 64 * 1024 : 1024 * 1024, partial: true, signal });
  if (f.status >= 400) throw new Error(`The site answered ${f.status}`);
  const kind = kindOfMime(f.type) || guessed || "page";
  if (kind !== "page") {
    let title: string | undefined;
    try {
      title = decodeURIComponent(new URL(f.finalUrl).pathname.split("/").pop() || "") || undefined;
    } catch {
      /* no name */
    }
    return { kind, url: f.finalUrl, mime: f.type, title, image: kind === "image" ? f.finalUrl : undefined };
  }
  const info = pageInfo(decodeText(f), f.finalUrl);
  return { kind: info.video ? "video" : info.photo ? "image" : "page", url: f.finalUrl, title: info.title, description: info.description, site: info.site, image: info.image, mime: f.type };
}

async function thumbFromBlob(blob: Blob, max = 560): Promise<{ thumb: string; width: number; height: number } | null> {
  try {
    let bmp: ImageBitmap | HTMLImageElement;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      // SVG and a few others need an <img>
      const u = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = u;
        await img.decode();
        bmp = img;
      } finally {
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      }
    }
    const w = (bmp as ImageBitmap).width || (bmp as HTMLImageElement).naturalWidth;
    const h = (bmp as ImageBitmap).height || (bmp as HTMLImageElement).naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp as CanvasImageSource, 0, 0, c.width, c.height);
    return { thumb: c.toDataURL("image/jpeg", 0.74), width: w, height: h };
  } catch {
    return null;
  }
}

/** Small JPEG preview of a remote image, fetched through the server. */
export async function remoteThumb(imageUrl: string, signal?: AbortSignal) {
  const f = await webFetch(imageUrl, { maxBytes: 25 * 1024 * 1024, signal, accept: "image/avif,image/webp,image/*,*/*;q=0.5" });
  if (f.status >= 400 || f.truncated) return null;
  return thumbFromBlob(new Blob([f.bytes], { type: f.type.startsWith("image/") ? f.type : "image/jpeg" }));
}

/** First frame of a remote video file. Reads the first few MB; works for web-optimised MP4 and WebM. */
export async function remoteVideoPoster(videoUrl: string, signal?: AbortSignal) {
  for (const mb of [8, 40]) {
    const f = await webFetch(videoUrl, { maxBytes: mb * 1024 * 1024, partial: true, signal });
    if (f.status >= 400) return null;
    const p = await makeVideoPoster(new File([f.bytes], "v", { type: f.type.startsWith("video/") ? f.type : "video/mp4" }));
    if (p?.thumb) return { thumb: p.thumb, width: p.width, height: p.height, duration: f.truncated ? undefined : p.duration };
    if (!f.truncated) return null;
  }
  return null;
}

/** Preview + thumbnail in one go: what the bookmark editor and the card auto-preview use. */
export async function buildPreview(url: string, signal?: AbortSignal): Promise<LinkPreview & { thumb: string | null; width?: number; height?: number; duration?: number }> {
  const p = await inspectLink(url, signal);
  let t: { thumb: string | null; width?: number; height?: number; duration?: number } | null = null;
  try {
    if (p.image) t = await remoteThumb(p.image, signal);
    const hosted = embedFor(url)?.kind;
    if (!t?.thumb && p.kind === "video" && hosted !== "youtube" && hosted !== "vimeo") t = await remoteVideoPoster(p.url, signal);
    if (!t?.thumb && p.kind === "video" && embedFor(url)?.kind === "youtube") t = await remoteThumb(p.image!.replace("hqdefault", "default"), signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
  }
  return { ...p, thumb: t?.thumb || null, width: t?.width, height: t?.height, duration: t?.duration };
}

// ---------- saved copies ----------

export interface Archived {
  file: File;
  kind: LinkKind;
  title?: string;
  url: string;
  resources: number; // inlined images/styles/fonts
  skipped: number; // resources that couldn't be saved
}

const PAGE_BUDGET = 60 * 1024 * 1024; // total inlined bytes per page
const RES_MAX = 12 * 1024 * 1024; // per resource

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function extMime(url: string) {
  const e = (url.split(/[?#]/)[0].split(".").pop() || "").toLowerCase();
  return (
    { css: "text/css", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject" } as Record<string, string>
  )[e] || "application/octet-stream";
}
function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "page";
}
const stamp = (d = new Date()) => d.toISOString().slice(0, 10);

/** Videos on YouTube, Vimeo and similar sites can only be saved when the server can download them (yt-dlp). */
export function hostedVideo(url?: string | null) {
  const k = embedFor(url)?.kind;
  return k === "youtube" || k === "vimeo";
}
/** Whether a copy can be saved at all. `media`: the server can download videos (defaults to what's known). */
export function canArchive(url?: string | null, media = knownFeatures()?.includes("media-download") ?? false) {
  return !!url && (media || !hostedVideo(url));
}

export type ArchiveAs = "auto" | "page" | "image" | "video";

export interface ArchivedMedia extends Archived {
  via?: "page" | "file" | "image" | "yt-dlp";
  duration?: number;
  width?: number;
  height?: number;
  uploader?: string;
  site?: string;
  description?: string;
  /** Set when the video or image couldn't be saved and the page was saved instead. */
  fallback?: string;
}

/**
 * Save a copy of what a bookmark points to, ArchiveBox-style:
 *  - a video page (YouTube, Vimeo, PeerTube… anything yt-dlp knows) → the video, downloaded by the server
 *  - a photo page (Flickr, Imgur…, or og:type photo) → the full-size picture
 *  - an image, video, audio or other file link → the file itself
 *  - any other page → a self-contained copy of the page
 * `as` forces one of them; `hint` is the bookmark's preview (kind and image) if known.
 */
export async function archiveLink(
  url: string,
  opts: { signal?: AbortSignal; onProgress?: (msg: string) => void; maxBytes?: number; as?: ArchiveAs; hint?: { kind?: LinkKind; image?: string } } = {},
): Promise<ArchivedMedia> {
  const as = opts.as || "auto";
  const media = await mediaEnabled();
  const hosted = hostedVideo(url);
  if (as === "video" || (as === "auto" && (hosted || (opts.hint?.kind === "video" && media)))) {
    if (!media) throw new Error(hosted ? "This server can't download videos (yt-dlp isn't installed), so Scute keeps the title and thumbnail." : "This server can't download videos (yt-dlp isn't installed).");
    try {
      return await downloadVideo(url, opts);
    } catch (e) {
      if ((e as Error).name === "AbortError" || as === "video" || hosted) throw e;
      const page = await archivePage(url, opts);
      return { ...page, fallback: `The video couldn't be downloaded (${(e as Error).message}), so the page was saved instead.` };
    }
  }
  if (as === "image" || (as === "auto" && opts.hint?.kind === "image" && opts.hint.image && guessKind(url) !== "image")) {
    try {
      return await savePicture(url, opts);
    } catch (e) {
      if ((e as Error).name === "AbortError" || as === "image") throw e;
      const page = await archivePage(url, opts);
      return { ...page, fallback: `The picture couldn't be saved (${(e as Error).message}), so the page was saved instead.` };
    }
  }
  return archivePage(url, opts);
}

/** The full-size picture of a photo page (its og:image), or the image itself for an image link. */
async function savePicture(url: string, opts: { signal?: AbortSignal; onProgress?: (msg: string) => void; maxBytes?: number; hint?: { image?: string } }): Promise<ArchivedMedia> {
  const { signal, onProgress } = opts;
  onProgress?.("Finding the picture…");
  let img = guessKind(url) === "image" ? url : undefined;
  let page = url;
  let title: string | undefined;
  let site: string | undefined;
  let description: string | undefined;
  if (!img) {
    const f = await webFetch(url, { maxBytes: 2 * 1024 * 1024, partial: true, signal });
    if (f.status >= 400) throw new Error(`The site answered ${f.status}`);
    if (kindOfMime(f.type) === "image") img = f.finalUrl;
    else {
      const info = pageInfo(decodeText(f), f.finalUrl);
      img = info.image || opts.hint?.image;
      page = f.finalUrl;
      title = info.title;
      site = info.site;
      description = info.description;
    }
  }
  if (!img) throw new Error("the page has no picture to save");
  onProgress?.("Downloading the picture…");
  const f = await webFetch(img, {
    maxBytes: opts.maxBytes,
    signal,
    accept: "image/avif,image/webp,image/*,*/*;q=0.5",
    onProgress: (g, t) => onProgress?.(t ? `Downloading the picture ${Math.round((g / t) * 100)}%…` : `Downloading the picture ${(g / 1048576).toFixed(1)} MB…`),
  });
  if (f.status >= 400) throw new Error(`the picture's server answered ${f.status}`);
  if (f.truncated) throw new Error("the picture is larger than this server saves");
  const type = f.type.startsWith("image/") ? f.type : extMime(f.finalUrl).startsWith("image/") ? extMime(f.finalUrl) : "";
  if (!type) throw new Error("what the page points to isn't a picture");
  const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" } as Record<string, string>)[type] || type.split("/")[1].replace(/\W.*/, "") || "img";
  const last = (() => {
    try {
      return decodeURIComponent(new URL(f.finalUrl).pathname.split("/").pop() || "");
    } catch {
      return "";
    }
  })();
  const base = title ? safeName(title) : last.replace(/\.[^.]+$/, "") || "picture";
  const dims = await imageSize(new Blob([f.bytes as BlobPart], { type }));
  return { file: new File([f.bytes as BlobPart], `${safeName(base)}.${ext}`, { type }), kind: "image", title, url: img === url ? f.finalUrl : page, resources: 0, skipped: 0, via: "image", site, description, ...dims };
}

async function imageSize(blob: Blob): Promise<{ width?: number; height?: number }> {
  try {
    const b = await createImageBitmap(blob);
    const r = { width: b.width, height: b.height };
    b.close();
    return r;
  } catch {
    return {};
  }
}

interface MediaJob {
  id: string;
  state: "running" | "done" | "error";
  phase: string;
  percent: number | null;
  bytes: number;
  total: number | null;
  error: string | null;
  info: { title?: string; uploader?: string; duration?: number; width?: number; height?: number; site?: string; webpage?: string; description?: string; ext?: string; type?: string; size?: number; audioOnly?: boolean } | null;
}

/** Have the server download the video on a page (yt-dlp), then fetch the file. */
export async function downloadVideo(url: string, opts: { signal?: AbortSignal; onProgress?: (msg: string) => void; maxBytes?: number } = {}): Promise<ArchivedMedia> {
  const { signal, onProgress } = opts;
  onProgress?.("Looking up the video…");
  let j = await api<MediaJob>("POST", "/api/web/media", { url });
  const cancel = () => void api("DELETE", `/api/web/media/${j.id}`).catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (j.state === "running") {
      await new Promise((r) => setTimeout(r, 1000));
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      j = await api<MediaJob>("GET", `/api/web/media/${j.id}`);
      if (j.state === "running")
        onProgress?.(j.percent != null ? `${j.phase} on the server, ${j.percent}%…` : j.bytes ? `${j.phase} on the server, ${(j.bytes / 1048576).toFixed(1)} MB…` : `${j.phase}…`);
    }
    if (j.state === "error") throw new Error(j.error || "The download failed");
    const info = j.info || {};
    if (opts.maxBytes && (info.size || 0) > opts.maxBytes) throw new Error(`The video is ${((info.size || 0) / 1048576).toFixed(0)} MB, over this server's upload limit`);
    // fetch the finished file (the server deletes it once sent)
    const headers: Record<string, string> = {};
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/web/media/${j.id}/file`, { headers, cache: "no-store", signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new NetworkError((e as Error).message || "Network error");
    }
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.message || res.statusText);
    const total = Number(res.headers.get("content-length") || 0) || info.size || 0;
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(total ? `Fetching the video ${Math.round((got / total) * 100)}%…` : `Fetching the video ${(got / 1048576).toFixed(1)} MB…`);
    }
    const type = res.headers.get("x-media-type") || info.type || "video/mp4";
    const ext = info.ext || type.split("/")[1] || "mp4";
    const name = `${safeName(info.title || "video")}.${ext}`;
    return {
      file: new File(chunks as BlobPart[], name, { type }),
      kind: info.audioOnly || type.startsWith("audio/") ? "audio" : "video",
      title: info.title || undefined,
      url: info.webpage || url,
      resources: 0,
      skipped: 0,
      via: "yt-dlp",
      duration: info.duration || undefined,
      width: info.width || undefined,
      height: info.height || undefined,
      uploader: info.uploader || undefined,
      site: info.site || undefined,
      description: info.description || undefined,
    };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * A self-contained copy of a page, in the spirit of ArchiveBox's SingleFile
 * output: scripts removed, stylesheets, images and fonts inlined as data: URIs,
 * links made absolute. Images, videos, audio and other files are saved as-is.
 */
export async function archivePage(url: string, opts: { signal?: AbortSignal; onProgress?: (msg: string) => void; maxBytes?: number } = {}): Promise<ArchivedMedia> {
  const { signal, onProgress } = opts;
  if (hostedVideo(url)) throw new Error("Pages on YouTube and Vimeo can't be saved; save the video instead.");
  onProgress?.("Fetching the page…");
  const main = await webFetch(url, { maxBytes: opts.maxBytes, signal, onProgress: (g, t) => onProgress?.(t ? `Downloading ${Math.round((g / t) * 100)}%…` : `Downloading ${(g / 1048576).toFixed(1)} MB…`) });
  if (main.status >= 400) throw new Error(`The site answered ${main.status}`);
  const kind = kindOfMime(main.type) || guessKind(main.finalUrl) || "page";
  const host = (() => {
    try {
      return new URL(main.finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "site";
    }
  })();
  if (kind !== "page" || (main.type && !/html|xml|text\/plain/.test(main.type))) {
    const last = decodeURIComponent(new URL(main.finalUrl).pathname.split("/").pop() || "") || host;
    const name = safeName(last.includes(".") ? last : `${last}.${(main.type.split("/")[1] || "bin").replace(/\W.*/, "")}`);
    const file = new File([main.bytes as BlobPart], name, { type: main.type || "application/octet-stream" });
    const dims = kind === "image" ? await imageSize(file) : {};
    return { file, kind: kind === "page" ? "file" : kind, url: main.finalUrl, resources: 0, skipped: 0, via: "file", ...dims };
  }
  if (main.type === "text/plain") {
    return { file: new File([main.bytes as BlobPart], `${safeName(host)} ${stamp()}.txt`, { type: "text/plain" }), kind: "page", url: main.finalUrl, resources: 0, skipped: 0, via: "page" };
  }

  const html = decodeText(main);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = abs(doc.querySelector("base[href]")?.getAttribute("href"), main.finalUrl) || main.finalUrl;
  let used = 0;
  let resources = 0;
  let skipped = 0;
  const cache = new Map<string, Promise<string | null>>();
  let active = 0;
  const waiters: (() => void)[] = [];
  const slot = async () => {
    if (active >= 6) await new Promise<void>((r) => waiters.push(r));
    active++;
  };
  const release = () => {
    active--;
    waiters.shift()?.();
  };

  /** Fetch a resource and return it as a data: URI (or null to leave the remote URL). */
  const dataUri = (u: string, as: "css" | "bin" = "bin"): Promise<string | null> => {
    if (!/^https?:/i.test(u)) return Promise.resolve(null);
    const k = as + " " + u;
    if (!cache.has(k))
      cache.set(
        k,
        (async () => {
          if (used > PAGE_BUDGET) {
            skipped++;
            return null;
          }
          await slot();
          try {
            const f = await webFetch(u, { maxBytes: RES_MAX, signal, accept: as === "css" ? "text/css,*/*;q=0.1" : undefined });
            if (f.status >= 400 || f.truncated) {
              skipped++;
              return null;
            }
            used += f.bytes.length;
            resources++;
            if (resources % 10 === 0) onProgress?.(`Saving images and styles (${resources})…`);
            if (as === "css") {
              const css = await inlineCss(decodeText(f), f.finalUrl, 0);
              return "data:text/css;charset=utf-8;base64," + b64(new TextEncoder().encode(css));
            }
            const type = f.type && f.type !== "application/octet-stream" && !f.type.startsWith("text/html") ? f.type : extMime(f.finalUrl);
            return `data:${type};base64,${b64(f.bytes)}`;
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            skipped++;
            return null;
          } finally {
            release();
          }
        })(),
      );
    return cache.get(k)!;
  };

  /** Inline url(...) and @import in a stylesheet. */
  async function inlineCss(css: string, cssBase: string, depth: number): Promise<string> {
    const imports: { full: string; url: string }[] = [];
    css.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?([^;]*);/gi, (full, u) => {
      imports.push({ full, url: abs(u, cssBase) || u });
      return full;
    });
    for (const im of imports) {
      let inner = "";
      if (depth < 3) {
        try {
          const f = await webFetch(im.url, { maxBytes: RES_MAX, signal, accept: "text/css,*/*;q=0.1" });
          if (f.status < 400) inner = await inlineCss(decodeText(f), f.finalUrl, depth + 1);
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
        }
      }
      const media = im.full.replace(/@import\s+(?:url\(\s*)?["']?[^"')\s;]+["']?\s*\)?/i, "").replace(/;$/, "").trim();
      css = css.replace(im.full, media ? `@media ${media}{${inner}}` : inner);
    }
    const urls = new Set<string>();
    css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_m, _q, u) => {
      if (!/^(data:|#|about:)/i.test(u.trim())) urls.add(u.trim());
      return _m;
    });
    const map = new Map<string, string>();
    await Promise.all(
      [...urls].map(async (u) => {
        const a = abs(u, cssBase);
        if (!a) return;
        const d = await dataUri(a);
        map.set(u, d || a);
      }),
    );
    return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, u) => (map.has(u.trim()) ? `url("${map.get(u.trim())}")` : m));
  }

  // 1. strip active content
  doc.querySelectorAll("script, template[shadowrootmode] ~ script, link[rel~=preload], link[rel~=prefetch], link[rel~=modulepreload], link[rel~=preconnect], link[rel~=dns-prefetch], link[rel=manifest], link[rel=serviceworker], meta[http-equiv], base, object, embed, applet, portal").forEach((el) => el.remove());
  // noscript content is what a browser without JavaScript shows: keep it
  doc.querySelectorAll("noscript").forEach((el) => {
    el.querySelectorAll("iframe, link, style, meta").forEach((x) => x.remove());
    const prev = el.previousElementSibling;
    // <img data-src=…><noscript><img src=…></noscript>: the lazy image is used below
    if (prev?.tagName === "IMG" && el.querySelector("img") && !el.textContent?.trim()) return el.remove();
    el.replaceWith(...Array.from(el.childNodes));
  });
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || n === "nonce" || n === "integrity" || n === "srcdoc" || n === "ping") el.removeAttribute(a.name);
      else if (/^\s*(javascript|vbscript):/i.test(a.value) && ["href", "src", "action", "formaction", "xlink:href", "data"].includes(n)) el.setAttribute(a.name, "#");
    }
  });
  doc.querySelectorAll("form").forEach((f) => f.setAttribute("action", "#"));

  // 2. lazy-loaded images
  doc.querySelectorAll<HTMLElement>("img, source, iframe, video").forEach((el) => {
    for (const k of ["data-src", "data-lazy-src", "data-original", "data-url", "data-hi-res-src", "data-lazy"]) {
      const v = el.getAttribute(k);
      if (v && !/^data:/.test(v)) {
        el.setAttribute(el.tagName === "SOURCE" && !el.closest("video,audio") ? "srcset" : "src", v);
        break;
      }
    }
    const ss = el.getAttribute("data-srcset") || el.getAttribute("data-lazy-srcset");
    if (ss) el.setAttribute("srcset", ss);
    el.removeAttribute("loading");
  });

  const pickSrcset = (ss: string, b: string) => {
    let best: { u: string; w: number } | null = null;
    for (const part of ss.split(/,\s+(?=\S)/)) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const w = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 1;
      if (!best || (w > best.w && w <= 2400) || (best.w > 2400 && w < best.w)) best = { u, w };
    }
    return best ? abs(best.u, b) : undefined;
  };

  const jobs: Promise<void>[] = [];
  // 3. stylesheets
  doc.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet][href]").forEach((l) => {
    const href = abs(l.getAttribute("href"), base);
    if (!href) return l.remove();
    jobs.push(
      (async () => {
        const d = await dataUri(href, "css");
        if (!d) return void l.setAttribute("href", href);
        const st = doc.createElement("style");
        const media = l.getAttribute("media");
        if (media) st.setAttribute("media", media);
        st.textContent = new TextDecoder().decode(Uint8Array.from(atob(d.split(",")[1]), (c) => c.charCodeAt(0)));
        l.replaceWith(st);
      })(),
    );
  });
  doc.querySelectorAll("style").forEach((st) => jobs.push(inlineCss(st.textContent || "", base, 0).then((c) => void (st.textContent = c))));
  doc.querySelectorAll<HTMLElement>("[style*='url(']").forEach((el) => jobs.push(inlineCss(el.getAttribute("style") || "", base, 0).then((c) => el.setAttribute("style", c))));

  // 4. images and icons
  doc.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const ss = img.getAttribute("srcset");
    const src = (ss && pickSrcset(ss, base)) || abs(img.getAttribute("src"), base);
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    if (!src) return;
    img.setAttribute("src", src);
    jobs.push(dataUri(src).then((d) => void (d && img.setAttribute("src", d))));
  });
  doc.querySelectorAll("picture source").forEach((s) => s.remove());
  doc.querySelectorAll<HTMLElement>("video[poster], input[type=image][src]").forEach((el) => {
    const attr = el.tagName === "VIDEO" ? "poster" : "src";
    const u = abs(el.getAttribute(attr), base);
    if (u) jobs.push(dataUri(u).then((d) => void el.setAttribute(attr, d || u)));
  });
  doc.querySelectorAll("image, use").forEach((el) => {
    for (const attr of ["href", "xlink:href"]) {
      const v = el.getAttribute(attr);
      if (!v || v.startsWith("#") || v.startsWith("data:")) continue;
      const u = abs(v, base);
      if (u) jobs.push(dataUri(u).then((d) => void el.setAttribute(attr, d || u)));
    }
  });
  doc.querySelectorAll<HTMLLinkElement>("link[rel~=icon][href], link[rel~=apple-touch-icon][href]").forEach((l, i) => {
    const u = abs(l.getAttribute("href"), base);
    if (!u || i > 1) return l.remove();
    jobs.push(dataUri(u).then((d) => void l.setAttribute("href", d || u)));
  });

  // 5. everything else just points back at the live site
  doc.querySelectorAll<HTMLElement>("a[href], area[href]").forEach((a) => {
    const h = a.getAttribute("href")!;
    if (h.startsWith("#")) return;
    const u = abs(h, base);
    if (u) a.setAttribute("href", u);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
  doc.querySelectorAll<HTMLElement>("iframe[src], video[src], audio[src], video source[src], audio source[src], track[src]").forEach((el) => {
    const u = abs(el.getAttribute("src"), base);
    if (u) el.setAttribute("src", u);
  });

  await Promise.all(jobs);
  onProgress?.("Packing…");

  // lock the copy down: no scripts, no network except images/media already absolute
  const head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", "default-src 'none'; img-src data: https: http:; media-src data: https: http:; style-src 'unsafe-inline' data:; font-src data:; frame-src https: http:");
  head.prepend(csp);
  const cs = doc.createElement("meta");
  cs.setAttribute("charset", "utf-8");
  head.prepend(cs);
  const when = new Date();
  const title = (doc.title || "").replace(/\s+/g, " ").trim() || undefined;
  const out = `<!DOCTYPE html>\n<!--\n Saved by Scute from ${main.finalUrl.replace(/--/g, "%2D%2D")}\n on ${when.toISOString()}\n-->\n${doc.documentElement.outerHTML}`;
  return {
    file: new File([out], `${safeName(title || host)} ${stamp(when)}.html`, { type: "text/html" }),
    kind: "page",
    title,
    url: main.finalUrl,
    resources,
    skipped,
    via: "page",
  };
}
