/**
 * Video downloads for bookmarks (Scute 1.18.0), ArchiveBox's "media" step.
 *
 * Browsers can't download from YouTube and most video sites, so for a video
 * bookmark the server runs yt-dlp into a temporary folder and hands the file
 * to the browser, which encrypts it and stores it as the bookmark's saved copy
 * like any other attachment. The temporary file is deleted as soon as it has
 * been sent (or after 30 minutes). The server keeps nothing.
 *
 *   SCUTE_MEDIA=off            turn video downloads off (also off with SCUTE_ARCHIVE=off)
 *   SCUTE_YTDLP=/path/yt-dlp   the yt-dlp program (default: yt-dlp on the PATH)
 *   SCUTE_MEDIA_HEIGHT=1080    highest video resolution to download
 *   SCUTE_YTDLP_UPDATE=off     don't run "yt-dlp -U" at start and once a day
 *   SCUTE_MEDIA_MAX_MB         largest download (default: SCUTE_MAX_UPLOAD_MB, the
 *                              attachment limit, since the copy is stored as one)
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./storage";
import { WEB_ON, checkHost } from "./web";

const off = (v: string | undefined) => ["off", "0", "false", "no"].includes((v || "").toLowerCase());
const YTDLP = process.env.SCUTE_YTDLP || "yt-dlp";
const HEIGHT = Math.max(144, Number(process.env.SCUTE_MEDIA_HEIGHT || 1080) || 1080);
const MAX_MB = Number(process.env.SCUTE_MEDIA_MAX_MB || process.env.SCUTE_MAX_UPLOAD_MB || 200);
const TMP = path.join(DATA_DIR, "tmp", "media");
const JOB_TTL = 30 * 60_000;
const RUN_LIMIT = 60 * 60_000; // one download may take up to an hour

interface Tool {
  ok: boolean;
  version?: string;
  ffmpeg: boolean;
  jsRuntimes: boolean;
  remoteComponents: boolean;
  error?: string;
}
let tool: Tool = { ok: false, ffmpeg: false, jsRuntimes: false, remoteComponents: false };
let toolReady: Promise<void> | null = null;

function run(cmd: string, args: string[], ms: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let p: ChildProcess;
    try {
      p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: -1, out, err: (e as Error).message });
    }
    const t = setTimeout(() => p.kill("SIGKILL"), ms);
    p.stdout!.on("data", (d) => (out += d).length > 2e6 && (out = out.slice(-1e6)));
    p.stderr!.on("data", (d) => (err += d).length > 2e5 && (err = err.slice(-1e5)));
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

async function detect() {
  if (!WEB_ON || off(process.env.SCUTE_MEDIA)) {
    tool = { ok: false, ffmpeg: false, jsRuntimes: false, remoteComponents: false, error: "turned off" };
    return;
  }
  const v = await run(YTDLP, ["--version"], 20_000);
  if (v.code !== 0) {
    tool = { ok: false, ffmpeg: false, jsRuntimes: false, remoteComponents: false, error: v.err.trim().split("\n").pop() || "not found" };
    console.log(`[media] video downloads off: ${YTDLP} isn't available (${tool.error})`);
    return;
  }
  const [help, ff] = await Promise.all([run(YTDLP, ["--help"], 20_000), run("ffmpeg", ["-version"], 10_000)]);
  tool = { ok: true, version: v.out.trim(), ffmpeg: ff.code === 0, jsRuntimes: help.out.includes("--js-runtimes"), remoteComponents: help.out.includes("--remote-components") };
  console.log(`[media] video downloads on: yt-dlp ${tool.version}${tool.ffmpeg ? ", ffmpeg" : ", no ffmpeg (single-file formats only)"}`);
}

/** Start detecting yt-dlp (and keep it up to date); call once at startup. */
export function initMedia() {
  toolReady = detect().then(async () => {
    if (!tool.ok || off(process.env.SCUTE_YTDLP_UPDATE)) return;
    const update = async () => {
      const r = await run(YTDLP, ["-U"], 120_000);
      const line = (r.out + r.err).trim().split("\n").filter(Boolean).pop() || "";
      if (/Updated yt-dlp to|up to date/i.test(line)) console.log(`[media] ${line}`);
      if (/Updated yt-dlp to/i.test(line)) await detect();
    };
    update().catch((e) => console.error("[media] update", e));
    setInterval(() => update().catch((e) => console.error("[media] update", e)), 24 * 3600_000).unref();
  });
  fs.rmSync(TMP, { recursive: true, force: true }); // leftovers from a restart
}
export const mediaOn = () => tool.ok;

// ---------------------------------------------------------------- jobs
interface Job {
  id: string;
  user: string;
  url: string;
  dir: string;
  proc: ChildProcess | null;
  state: "running" | "done" | "error";
  percent: number | null;
  bytes: number;
  total: number | null;
  phase: string;
  error?: string;
  file?: string;
  info?: Record<string, unknown>;
  started: number;
  touched: number;
}
const jobs = new Map<string, Job>();

function cleanup(j: Job) {
  try {
    j.proc?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  fs.rmSync(j.dir, { recursive: true, force: true });
  jobs.delete(j.id);
}
setInterval(() => {
  const now = Date.now();
  for (const j of jobs.values()) if (now - j.touched > JOB_TTL || (j.state === "running" && now - j.started > RUN_LIMIT)) cleanup(j);
}, 60_000).unref();

const MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", flac: "audio/flac" };

/** Turn yt-dlp's last error line into something a person can act on. */
function explain(err: string): string {
  const lines = err.split("\n").map((l) => l.trim()).filter(Boolean);
  const e = [...lines].reverse().find((l) => l.startsWith("ERROR:")) || lines.pop() || "yt-dlp failed";
  const m = e.replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "");
  if (/Unsupported URL/i.test(m)) return "There's no video Scute can download on that page.";
  if (/Sign in to confirm|not a bot|cookies/i.test(m)) return `The site wants a signed-in browser before it hands out this video (${m.slice(0, 160)}).`;
  if (/File is larger than max-filesize|larger than max/i.test(m)) return `The video is larger than this server saves (${MAX_MB} MB). Lower SCUTE_MEDIA_HEIGHT or raise SCUTE_MAX_UPLOAD_MB.`;
  if (/Private video|members-only|This video is unavailable|Video unavailable/i.test(m)) return m.slice(0, 240);
  if (/live/i.test(m) && /not.*(started|supported)/i.test(m)) return m.slice(0, 240);
  return m.slice(0, 300);
}

function startJob(j: Job) {
  // prefer formats known to fit under the size limit (so a 4K video comes down at a size that fits)
  const fit = `[filesize<?${MAX_MB}M][filesize_approx<?${MAX_MB}M]`;
  const fmt = tool.ffmpeg ? `bv*${fit}+ba/b${fit}/bv*+ba/b` : `b${fit}/b/bv*`;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--no-color",
    "--no-mtime",
    "--no-part",
    "--restrict-filenames",
    "--write-info-json",
    "--no-write-comments",
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--max-filesize",
    `${MAX_MB}M`,
    "-f",
    fmt,
    // best video up to HEIGHT, preferring H.264/AAC in MP4 so every browser plays it
    "-S",
    `res:${HEIGHT},vcodec:h264,acodec:aac,ext:mp4:m4a`,
    ...(tool.ffmpeg ? ["--merge-output-format", "mp4"] : []),
    ...(tool.jsRuntimes ? ["--js-runtimes", `node:${process.execPath}`] : []),
    ...(tool.remoteComponents ? ["--remote-components", "ejs:github"] : []),
    "--progress-template",
    "download:@P %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(info.format_id)s",
    "-o",
    path.join(j.dir, "media.%(ext)s"),
    "--",
    j.url,
  ];
  const p = spawn(YTDLP, args, { cwd: j.dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: process.env.HOME || j.dir } });
  j.proc = p;
  let err = "";
  let parts = 0;
  let lastFmt = "";
  let doneBytes = 0;
  let buf = "";
  p.stdout!.on("data", (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const l of lines) {
      j.touched = Date.now();
      if (l.startsWith("@P ")) {
        const [, got, tot, est, f] = l.split(" ");
        if (f !== lastFmt) {
          if (lastFmt) doneBytes += j.bytes - doneBytes; // previous stream finished
          lastFmt = f;
          parts++;
        }
        const g = Number(got) || 0;
        const t = Number(tot) || Number(est) || 0;
        j.phase = parts > 1 ? "Downloading the audio" : "Downloading the video";
        j.bytes = doneBytes + g;
        j.total = t ? doneBytes + t : null;
        j.percent = t ? Math.min(100, Math.round((g / t) * 100)) : null;
      } else if (/\[Merger\]|\[VideoConvertor\]|\[FixupM/.test(l)) {
        j.phase = "Putting the video together";
        j.percent = null;
      }
    }
  });
  p.stderr!.on("data", (d) => (err += d).length > 2e5 && (err = err.slice(-1e5)));
  p.on("error", (e) => {
    j.state = "error";
    j.error = e.message;
    j.proc = null;
  });
  p.on("close", (code) => {
    j.proc = null;
    j.touched = Date.now();
    if (j.state === "error") return;
    const files = fs.existsSync(j.dir) ? fs.readdirSync(j.dir) : [];
    const media = files.find((f) => f.startsWith("media.") && !f.endsWith(".json") && !/\.f\d+\./.test(f) && !f.endsWith(".part"));
    let info: Record<string, any> = {};
    const ij = files.find((f) => f.endsWith(".info.json"));
    if (ij)
      try {
        info = JSON.parse(fs.readFileSync(path.join(j.dir, ij), "utf8"));
      } catch {
        /* keep empty */
      }
    if (code !== 0 || !media) {
      j.state = "error";
      j.error = code === 0 ? (/max-filesize|larger than/i.test(err) ? explain("ERROR: File is larger than max-filesize") : "yt-dlp finished without a video file") : explain(err);
      if (code !== 0) console.warn(`[media] ${j.url.slice(0, 200)}: ${j.error}`);
      return;
    }
    const full = path.join(j.dir, media);
    const size = fs.statSync(full).size;
    if (size > MAX_MB * 1024 * 1024) {
      j.state = "error";
      j.error = explain("ERROR: File is larger than max-filesize");
      return;
    }
    const ext = media.split(".").pop()!.toLowerCase();
    const vcodec = String(info.vcodec || "");
    const audioOnly = vcodec === "none" || (!info.width && !info.height && /^(m4a|mp3|ogg|opus|oga|wav|flac)$/.test(ext));
    j.file = full;
    j.state = "done";
    j.percent = 100;
    j.bytes = size;
    j.total = size;
    j.info = {
      title: info.title || info.fulltitle || null,
      uploader: info.uploader || info.channel || info.creator || null,
      duration: typeof info.duration === "number" ? info.duration : null,
      width: info.width || null,
      height: info.height || null,
      site: info.extractor_key || info.extractor || null,
      webpage: info.webpage_url || j.url,
      uploaded: info.upload_date || null, // YYYYMMDD
      description: typeof info.description === "string" ? info.description.slice(0, 2000) : null,
      thumbnail: info.thumbnail || null,
      ext,
      type: MIME[ext] || (audioOnly ? "audio/mp4" : "video/mp4"),
      size,
      audioOnly,
      tool: `yt-dlp ${tool.version}`,
    };
  });
}

type Wrap = (fn: (req: any, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => void;

export function registerMediaRoutes(app: Express, { auth, wrap, HttpError }: { auth: RequestHandler; wrap: Wrap; HttpError: new (s: number, m: string) => Error }) {
  const own = (req: any): Job => {
    const j = jobs.get(String(req.params.id));
    if (!j || j.user !== req.user.id) throw new HttpError(404, "That download is gone; try again");
    j.touched = Date.now();
    return j;
  };
  const view = (j: Job) => ({ id: j.id, state: j.state, phase: j.phase, percent: j.percent, bytes: j.bytes, total: j.total, error: j.error || null, info: j.info || null });

  app.get(
    "/api/web/media",
    auth,
    wrap(async (_req, res) => {
      await toolReady;
      res.json({ enabled: tool.ok, version: tool.version || null, ffmpeg: tool.ffmpeg, maxMb: MAX_MB, height: HEIGHT, error: tool.ok ? null : tool.error || null });
    }),
  );

  /** Start downloading the video on a page. Body: { url }. */
  app.post(
    "/api/web/media",
    auth,
    express.json({ limit: "16kb" }),
    wrap(async (req, res) => {
      await toolReady;
      if (!tool.ok) throw new HttpError(403, `Video downloads are off on this server (${tool.error || "yt-dlp isn't installed"})`);
      let u: URL;
      try {
        u = new URL(String(req.body?.url || ""));
      } catch {
        throw new HttpError(400, "That isn't a valid link");
      }
      await checkHost(u, HttpError);
      const mine = [...jobs.values()].filter((j) => j.user === req.user.id && j.state === "running");
      if (mine.length >= 2) throw new HttpError(429, "Two videos are already downloading; wait for one to finish");
      const id = crypto.randomBytes(12).toString("hex");
      const dir = path.join(TMP, id);
      fs.mkdirSync(dir, { recursive: true });
      const j: Job = { id, user: req.user.id, url: u.href, dir, proc: null, state: "running", percent: null, bytes: 0, total: null, phase: "Looking up the video", started: Date.now(), touched: Date.now() };
      jobs.set(id, j);
      startJob(j);
      res.json(view(j));
    }),
  );

  app.get(
    "/api/web/media/:id",
    auth,
    wrap((req, res) => res.json(view(own(req)))),
  );

  /** The finished file. It's deleted from the server once it has been sent. */
  app.get(
    "/api/web/media/:id/file",
    auth,
    wrap((req, res) => {
      const j = own(req);
      if (j.state !== "done" || !j.file) throw new HttpError(409, j.state === "error" ? j.error || "The download failed" : "Not finished yet");
      const info = j.info || {};
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(fs.statSync(j.file).size));
      res.setHeader("X-Media-Type", String(info.type || "video/mp4"));
      res.setHeader("Cache-Control", "no-store");
      const s = fs.createReadStream(j.file);
      s.pipe(res);
      res.on("finish", () => cleanup(j));
      res.on("close", () => !res.writableFinished && s.destroy());
    }),
  );

  app.delete(
    "/api/web/media/:id",
    auth,
    wrap((req, res) => {
      const j = jobs.get(String(req.params.id));
      if (j && j.user === req.user.id) cleanup(j);
      res.json({ ok: true });
    }),
  );
}
