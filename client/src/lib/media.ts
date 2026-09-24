// Helpers for video/audio: poster frames, embeddable links, formatting.

export type Embed =
  | { kind: "youtube"; id: string; src: string; label: string }
  | { kind: "vimeo"; id: string; src: string; label: string }
  | { kind: "direct"; media: "video" | "audio"; src: string; label: string };

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i;

function ytStart(u: URL): number {
  const t = u.searchParams.get("t") || u.searchParams.get("start") || "";
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

/** Recognise links that can be played inside Scute. */
export function embedFor(raw?: string | null): Embed | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, "");

  let yt: string | null = null;
  if (host === "youtu.be") yt = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") yt = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
      if (m) yt = m[1];
    }
  }
  if (yt && /^[\w-]{6,20}$/.test(yt)) {
    const start = ytStart(u);
    return {
      kind: "youtube",
      id: yt,
      src: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`,
      label: "YouTube",
    };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = u.pathname.match(/(?:^|\/)(\d{5,})(?:\/([0-9a-f]{6,}))?/);
    if (m) {
      const h = m[2] || u.searchParams.get("h");
      return { kind: "vimeo", id: m[1], src: `https://player.vimeo.com/video/${m[1]}?autoplay=1&dnt=1${h ? `&h=${h}` : ""}`, label: "Vimeo" };
    }
  }

  if (VIDEO_EXT.test(u.pathname)) return { kind: "direct", media: "video", src: u.href, label: u.hostname };
  if (AUDIO_EXT.test(u.pathname)) return { kind: "direct", media: "audio", src: u.href, label: u.hostname };
  return null;
}

export const isVideoMime = (t?: string | null) => !!t && t.startsWith("video/");
export const isAudioMime = (t?: string | null) => !!t && t.startsWith("audio/");

export function fmtDuration(sec?: number | null) {
  if (sec == null || !isFinite(sec)) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function waitFor(el: HTMLMediaElement, ev: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error("unsupported"));
    };
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(ev, ok);
      el.removeEventListener("error", bad);
    };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

/**
 * Grab a poster frame (JPEG data URL, max 640px) plus dimensions and duration from a local video file.
 * Returns partial info (or null) if the browser can't decode the format — the file can still be stored.
 */
export async function makeVideoPoster(src: File | string): Promise<{ thumb: string | null; width?: number; height?: number; duration?: number } | null> {
  const own = typeof src !== "string";
  const url = own ? URL.createObjectURL(src) : src;
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  try {
    v.src = url;
    await waitFor(v, "loadedmetadata", 15_000);
    const duration = isFinite(v.duration) ? v.duration : undefined;
    const width = v.videoWidth || undefined;
    const height = v.videoHeight || undefined;
    if (!width || !height) return { thumb: null, duration };
    const at = duration ? Math.min(1.5, duration * 0.1) : 0;
    if (at > 0) {
      const seeked = waitFor(v, "seeked", 6_000);
      v.currentTime = at;
      await seeked;
    }
    if (v.readyState < 2) await waitFor(v, "loadeddata", 4_000);
    return { thumb: captureFrame(v), width, height, duration };
  } catch {
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
    if (own) URL.revokeObjectURL(url);
  }
}

/** JPEG data URL (max 640px) of the frame a video element is currently showing. */
export function captureFrame(v: HTMLVideoElement): string | null {
  const width = v.videoWidth;
  const height = v.videoHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, 640 / Math.max(width, height));
  const c = document.createElement("canvas");
  c.width = Math.round(width * scale);
  c.height = Math.round(height * scale);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  try {
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/** True for notes that hold a video file (video notes, or older file notes with a video attachment). */
export function isVideoNote(d: { type: string; file?: { type?: string } | null }) {
  return d.type === "video" || (d.type === "file" && isVideoMime(d.file?.type));
}

/** True for notes that hold a still image (never videos). */
export function isImageNote(d: { type: string; file?: { type?: string } | null }) {
  if (isVideoNote(d)) return false;
  return d.type === "image" || (d.type === "file" && !!d.file?.type?.startsWith("image/"));
}

/** Read just the duration of an audio file. */
export async function audioDuration(file: File): Promise<number | undefined> {
  const url = URL.createObjectURL(file);
  const a = document.createElement("audio");
  a.preload = "metadata";
  try {
    a.src = url;
    await waitFor(a, "loadedmetadata", 10_000);
    return isFinite(a.duration) ? a.duration : undefined;
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", ogv: "video/ogg", avi: "video/x-msvideo",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
};
export function guessMime(name: string) {
  return MIME_BY_EXT[name.split(".").pop()?.toLowerCase() || ""] || "application/octet-stream";
}

/** Which note type a dropped/picked file should become. */
export function detectType(f: File): "image" | "video" | "file" {
  const t = f.type || guessMime(f.name);
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  return "file";
}
