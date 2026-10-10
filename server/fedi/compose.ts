/** Writing posts and storing attachments for local accounts. */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { db } from "../storage";
import {
  FEDI_URL,
  FEDI_DOMAIN,
  MEDIA_DIR,
  MAX_CHARS,
  MAX_MEDIA,
  bus,
  FediError,
  now,
  iso,
  json,
  newId,
  escapeHtml,
  mediaKind,
  imageSize,
  actorById,
  statusById,
  accountByName,
  actorUri,
  profileUrl,
  type AccountRow,
  type StatusRow,
  type MediaRow,
  type ActorRow,
} from "./core";
import { webfinger, fanout, deliverStatus, removeStatus, mediaOf, removeMediaFiles } from "./ap";

const URL_RE = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/;
const MENTION_RE = /@([a-zA-Z0-9_]+(?:[.-]+[a-zA-Z0-9_]+)*)(?:@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d+)?))?/;
const TAG_RE = /#([\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*)/u;
const TOKEN_RE = new RegExp(`(${URL_RE.source})|(^|[^\\w/@])(${MENTION_RE.source})|(^|[^\\w/#&])(${TAG_RE.source})`, "gu");

export interface Rendered {
  html: string;
  mentions: { id: number; uri: string; acct: string }[];
  tags: string[];
}

/** Plain text with @mentions, #hashtags and links into Mastodon-style HTML. */
export async function renderText(text: string, extraMentions: ActorRow[] = []): Promise<Rendered> {
  const wanted = new Map<string, ActorRow | null>();
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[3]) {
      const acct = (m[4] + (m[5] ? "@" + m[5] : "")).toLowerCase();
      if (!wanted.has(acct)) wanted.set(acct, null);
    }
  }
  await Promise.all(
    [...wanted.keys()].map(async (acct) => {
      wanted.set(acct, await webfinger(acct).catch(() => null));
    }),
  );
  const mentions = new Map<number, { id: number; uri: string; acct: string }>();
  const tags: string[] = [];
  const renderLine = (line: string) => {
    let out = "";
    let last = 0;
    for (const m of line.matchAll(TOKEN_RE)) {
      const at = m.index!;
      if (m[1]) {
        out += escapeHtml(line.slice(last, at));
        const url = m[1];
        const shown = url.replace(/^https?:\/\/(www\.)?/, "");
        const head = url.slice(0, url.length - shown.length);
        const short = shown.length > 30 ? shown.slice(0, 30) : shown;
        out += `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">${escapeHtml(head)}</span><span class="${shown.length > 30 ? "ellipsis" : ""}">${escapeHtml(short)}</span><span class="invisible">${escapeHtml(shown.slice(short.length))}</span></a>`;
        last = at + url.length;
      } else if (m[3]) {
        const pre = m[2] || "";
        out += escapeHtml(line.slice(last, at + pre.length));
        const acct = (m[4] + (m[5] ? "@" + m[5] : "")).toLowerCase();
        const a = wanted.get(acct);
        if (a) {
          const url = a.local ? profileUrl(a.username) : a.url || a.uri;
          out += `<span class="h-card" translate="no"><a href="${escapeHtml(url)}" class="u-url mention">@<span>${escapeHtml(a.username)}</span></a></span>`;
          mentions.set(a.id, { id: a.id, uri: a.uri, acct: a.local ? a.username : `${a.username}@${a.domain}` });
        } else out += escapeHtml(m[3]);
        last = at + pre.length + m[3].length;
      } else if (m[7]) {
        const pre = m[6] || "";
        out += escapeHtml(line.slice(last, at + pre.length));
        const tag = m[8];
        const t = tag.toLowerCase();
        if (!tags.includes(t)) tags.push(t);
        out += `<a href="${FEDI_URL}/tags/${encodeURIComponent(t)}" class="mention hashtag" rel="tag">#<span>${escapeHtml(tag)}</span></a>`;
        last = at + pre.length + m[7].length;
      }
    }
    return out + escapeHtml(line.slice(last));
  };
  const paras = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${p.split("\n").map(renderLine).join("<br>")}</p>`);
  for (const a of extraMentions) if (!mentions.has(a.id)) mentions.set(a.id, { id: a.id, uri: a.uri, acct: a.local ? a.username : `${a.username}@${a.domain}` });
  return { html: paras.join(""), mentions: [...mentions.values()], tags };
}

export interface PostInput {
  status?: string;
  spoiler_text?: string;
  visibility?: string;
  sensitive?: boolean;
  language?: string;
  in_reply_to_id?: string | number | null;
  media_ids?: (string | number)[];
  poll?: { options: string[]; expires_in: number; multiple?: boolean } | null;
  app?: { name: string; website?: string | null } | null;
}

function attachMedia(acc: AccountRow, statusId: number, ids: (string | number)[]) {
  const list = ids.slice(0, MAX_MEDIA).map((x) => Number(x));
  list.forEach((mid, pos) => {
    const m = db.prepare("SELECT * FROM fedi_media WHERE id = ? AND account_id = ?").get(mid, acc.id) as MediaRow | undefined;
    if (!m) throw new FediError(422, "Attachment not found");
    if (m.status_id && m.status_id !== statusId) throw new FediError(422, "That attachment is already used");
  });
  db.prepare("UPDATE fedi_media SET status_id = NULL WHERE status_id = ? AND account_id = ?").run(statusId, acc.id);
  list.forEach((mid, pos) => db.prepare("UPDATE fedi_media SET status_id = ?, pos = ? WHERE id = ?").run(statusId, pos, mid));
}

const VIS = ["public", "unlisted", "private", "direct"];

export async function createLocalStatus(acc: AccountRow, p: PostInput): Promise<StatusRow> {
  const me = actorById(acc.id)!;
  const text = String(p.status || "");
  const mediaIds = (p.media_ids || []).filter((x) => x !== "" && x != null);
  if (!text.trim() && !mediaIds.length && !p.poll) throw new FediError(422, "Write something or attach a file");
  if ([...text].length > MAX_CHARS) throw new FediError(422, `Posts can have up to ${MAX_CHARS} characters`);
  const settings = json(acc.settings, {});
  let visibility = VIS.includes(String(p.visibility)) ? String(p.visibility) : settings.privacy || "public";
  const parent = p.in_reply_to_id ? statusById(Number(p.in_reply_to_id)) : null;
  if (p.in_reply_to_id && !parent) throw new FediError(404, "The post you're replying to wasn't found");
  if (parent?.visibility === "direct" && !p.visibility) visibility = "direct";
  const parentAuthor = parent ? actorById(parent.actor_id) : null;
  const r = await renderText(text, parentAuthor && parentAuthor.id !== me.id ? [parentAuthor] : []);
  let poll: any = null;
  if (p.poll && Array.isArray(p.poll.options) && p.poll.options.filter(Boolean).length >= 2) {
    const secs = Math.min(Math.max(Number(p.poll.expires_in) || 86400, 300), 2629746);
    poll = { multiple: !!p.poll.multiple, options: p.poll.options.filter(Boolean).slice(0, 4).map((t) => ({ title: String(t).slice(0, 50), votes_count: 0 })), expires_at: iso(now() + secs * 1000), voters_count: 0 };
  }
  const id = newId();
  const uri = `${actorUri(acc.username)}/statuses/${id}`;
  db.prepare(
    `INSERT INTO fedi_statuses (id, uri, url, actor_id, local, in_reply_to_uri, in_reply_to_id, in_reply_to_actor_id, content, source, spoiler, visibility, sensitive, language, mentions, tags, poll, app, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    uri,
    `${profileUrl(acc.username)}/${id}`,
    me.id,
    parent?.uri ?? null,
    parent?.id ?? null,
    parent?.actor_id ?? null,
    text.trim() ? r.html : "",
    text,
    String(p.spoiler_text || "").slice(0, 500),
    visibility,
    p.sensitive || p.spoiler_text ? 1 : 0,
    p.language ? String(p.language).slice(0, 8) : settings.language || null,
    JSON.stringify(r.mentions),
    JSON.stringify(r.tags),
    poll ? JSON.stringify(poll) : null,
    p.app ? JSON.stringify(p.app) : null,
    now(),
  );
  try {
    attachMedia(acc, id, mediaIds);
  } catch (e) {
    db.prepare("DELETE FROM fedi_statuses WHERE id = ?").run(id);
    throw e;
  }
  const st = statusById(id)!;
  fanout(st);
  deliverStatus(acc, st, "Create");
  return st;
}

export async function editLocalStatus(acc: AccountRow, st: StatusRow, p: PostInput): Promise<StatusRow> {
  if (st.actor_id !== acc.id || st.reblog_of) throw new FediError(404, "Post not found");
  const history = json(st.history, []) as any[];
  history.push({ content: st.content, spoiler_text: st.spoiler, sensitive: !!st.sensitive, created_at: iso(st.edited_at || st.created_at), media: mediaOf(st.id).map((m) => m.id), poll: st.poll });
  const text = p.status != null ? String(p.status) : st.source || "";
  if ([...text].length > MAX_CHARS) throw new FediError(422, `Posts can have up to ${MAX_CHARS} characters`);
  const parentAuthor = st.in_reply_to_actor_id ? actorById(st.in_reply_to_actor_id) : null;
  const r = await renderText(text, parentAuthor && parentAuthor.id !== acc.id ? [parentAuthor] : []);
  // people mentioned before stay mentioned (they've already been sent the post)
  const old = json(st.mentions, []) as any[];
  for (const m of old) if (!r.mentions.some((x) => x.id === m.id)) r.mentions.push(m);
  if (p.media_ids) attachMedia(acc, st.id, p.media_ids.filter((x) => x !== "" && x != null));
  db.prepare("UPDATE fedi_statuses SET content = ?, source = ?, spoiler = ?, sensitive = ?, language = COALESCE(?, language), mentions = ?, tags = ?, history = ?, edited_at = ? WHERE id = ?").run(
    text.trim() ? r.html : "",
    text,
    p.spoiler_text != null ? String(p.spoiler_text).slice(0, 500) : st.spoiler,
    p.sensitive != null ? (p.sensitive ? 1 : 0) : st.sensitive,
    p.language || null,
    JSON.stringify(r.mentions),
    JSON.stringify(r.tags),
    JSON.stringify(history.slice(-20)),
    now(),
    st.id,
  );
  const fresh = statusById(st.id)!;
  deliverStatus(acc, fresh, "Update");
  bus.emit("status.update", st.id);
  return fresh;
}

export function deleteLocalStatus(acc: AccountRow, st: StatusRow) {
  if (st.actor_id !== acc.id) throw new FediError(404, "Post not found");
  if (!st.reblog_of) deliverStatus(acc, st, "Delete");
  removeStatus(st);
}

// ---------- attachments ----------

const safeName = (name: string, mime: string) => {
  let n = path.basename(name || "").replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[. ]+/, "").slice(-120);
  if (!n) n = "file";
  if (!/\.[a-z0-9]{1,8}$/i.test(n)) {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/ogg": "ogg", "application/pdf": "pdf" }[mime];
    if (ext) n += "." + ext;
  }
  return n.replace(/ /g, "_");
};

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav",
  pdf: "application/pdf", zip: "application/zip", txt: "text/plain", md: "text/markdown", csv: "text/csv", epub: "application/epub+zip",
  gpx: "application/gpx+xml", kml: "application/vnd.google-earth.kml+xml", json: "application/json",
};

let ffmpegOk: boolean | null = null;
function hasFfmpeg(): Promise<boolean> {
  if (ffmpegOk != null) return Promise.resolve(ffmpegOk);
  return new Promise((res) => execFile("ffmpeg", ["-version"], { timeout: 5000 }, (e) => res((ffmpegOk = !e))));
}
function run(cmd: string, args: string[]) {
  return new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 60_000, maxBuffer: 4 << 20 }, (e, out) => (e ? rej(e) : res(String(out)))));
}

export async function saveUpload(acc: AccountRow, f: { path: string; filename: string; mime: string; size: number }, opts: { description?: string; focus?: string; thumbnail?: { path: string; mime: string } | null }) {
  let mime = f.mime;
  const ext = (f.filename.split(".").pop() || "").toLowerCase();
  if (!mime || mime === "application/octet-stream") mime = EXT_MIME[ext] || "application/octet-stream";
  const type = mediaKind(mime);
  const id = newId(now(), "fedi_media");
  const dir = path.join(MEDIA_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const name = safeName(f.filename, mime);
  const dest = path.join(dir, name);
  fs.renameSync(f.path, dest);
  const meta: any = {};
  if (type === "image") {
    const fd = fs.openSync(dest, "r");
    const head = Buffer.alloc(Math.min(f.size, 512 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const s = imageSize(head);
    if (s) meta.original = meta.small = { width: s.width, height: s.height, size: `${s.width}x${s.height}`, aspect: s.width / s.height };
  }
  if (opts.focus) {
    const [x, y] = String(opts.focus).split(",").map(Number);
    if (isFinite(x) && isFinite(y)) meta.focus = { x, y };
  }
  let thumb: string | null = null;
  if (opts.thumbnail) {
    const tExt = opts.thumbnail.mime === "image/png" ? "png" : opts.thumbnail.mime === "image/webp" ? "webp" : "jpg";
    thumb = `thumb.${tExt}`;
    fs.renameSync(opts.thumbnail.path, path.join(dir, thumb));
    const s = imageSize(fs.readFileSync(path.join(dir, thumb)));
    if (s) meta.small = { width: s.width, height: s.height, size: `${s.width}x${s.height}`, aspect: s.width / s.height };
  }
  db.prepare("INSERT INTO fedi_media (id, account_id, file, thumb, type, mime, name, description, meta, size, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    acc.id,
    `${id}/${name}`,
    thumb ? `${id}/${thumb}` : null,
    type,
    mime,
    f.filename.slice(0, 200),
    opts.description ? String(opts.description).slice(0, 1500) : null,
    JSON.stringify(meta),
    f.size,
    now(),
  );
  if ((type === "video" || type === "audio") && (await hasFfmpeg())) await probeVideo(id, dest, type, !thumb).catch(() => null);
  return db.prepare("SELECT * FROM fedi_media WHERE id = ?").get(id) as MediaRow;
}

async function probeVideo(id: number, file: string, type: string, makeThumb: boolean) {
  const info = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]));
  const v = (info.streams || []).find((s: any) => s.codec_type === "video");
  const m = db.prepare("SELECT * FROM fedi_media WHERE id = ?").get(id) as MediaRow;
  const meta = json(m.meta, {});
  const duration = Number(info.format?.duration || 0);
  if (v && type === "video") {
    meta.original = { width: v.width, height: v.height, size: `${v.width}x${v.height}`, aspect: v.width / v.height, duration, frame_rate: v.r_frame_rate };
    if (makeThumb) {
      const t = path.join(path.dirname(file), "thumb.jpg");
      await run("ffmpeg", ["-v", "error", "-ss", String(Math.min(1, duration / 2)), "-i", file, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-y", t]);
      const s = imageSize(fs.readFileSync(t));
      if (s) meta.small = { width: s.width, height: s.height, size: `${s.width}x${s.height}`, aspect: s.width / s.height };
      db.prepare("UPDATE fedi_media SET thumb = ? WHERE id = ?").run(`${id}/thumb.jpg`, id);
    }
  } else if (duration) meta.original = { duration };
  db.prepare("UPDATE fedi_media SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
}

/** Attachments nobody posted within a day go away. */
export function pruneMedia() {
  const rows = db.prepare("SELECT * FROM fedi_media WHERE status_id IS NULL AND file IS NOT NULL AND created < ? AND id NOT IN (SELECT 0)").all(now() - 86400_000) as MediaRow[];
  for (const m of rows) {
    // avatars and headers are referenced from the actor row
    const used = db.prepare("SELECT 1 FROM fedi_actors WHERE local IS NOT NULL AND (avatar LIKE ? OR header LIKE ?)").get(`%/fedi/media/${m.id}/%`, `%/fedi/media/${m.id}/%`);
    if (used) continue;
    removeMediaFiles(m);
    db.prepare("DELETE FROM fedi_media WHERE id = ?").run(m.id);
  }
}

export { FEDI_DOMAIN };
