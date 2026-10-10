/**
 * Mastodon's client API (the parts apps use), so Tusky, Ivory, Elk, Phanpy,
 * Mona, Ice Cubes and the Scute plug-in can all talk to Scute's Fediverse.
 */
import type { Express, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import path from "node:path";
import { db } from "../storage";
import {
  FEDI_URL,
  FEDI_DOMAIN,
  MASTO_VERSION,
  MAX_CHARS,
  MAX_MEDIA,
  FEDI_MAX_MB,
  MEDIA_DIR,
  bus,
  FediError,
  now,
  iso,
  isoDay,
  json,
  sha256hex,
  randomToken,
  htmlToText,
  escapeHtml,
  actorById,
  statusById,
  accountById,
  type ActorRow,
  type AccountRow,
  type StatusRow,
  type MediaRow,
} from "./core";
import {
  resolveActor,
  webfinger,
  resolveObject,
  fetchOutbox,
  followActor,
  unfollowActor,
  likeStatus,
  unlikeStatus,
  reblogStatus,
  unreblogStatus,
  blockActor,
  unblockActor,
  sendAccept,
  sendReject,
  sendProfileUpdate,
  mediaOf,
  mediaUrl,
  thumbUrl,
  follows,
  voteLocal,
  backfill,
  notify,
} from "./ap";
import { createLocalStatus, editLocalStatus, deleteLocalStatus, saveUpload, renderText } from "./compose";
import { parseMultipart, cleanupUploads, type Multipart } from "./multipart";
import { vapidKeys, pushJson, type PushRow } from "./push";

export const DEFAULT_AVATAR = () => `${FEDI_URL}/fedi/static/avatar.png`;
export const DEFAULT_HEADER = () => `${FEDI_URL}/fedi/static/header.png`;

// ======================================================================
// Auth
// ======================================================================

export interface TokenRow {
  token_hash: string;
  app_id: number;
  account_id: number | null;
  scopes: string;
  created: number;
  last_used: number | null;
}
type MReq = Omit<Request, "params"> & { params: Record<string, string>; token?: TokenRow; acc?: AccountRow; me?: ActorRow };

export function tokenFrom(req: Request): TokenRow | null {
  const h = String(req.headers.authorization || "");
  const t = h.startsWith("Bearer ") ? h.slice(7).trim() : String((req.query as any).access_token || "");
  if (!t) return null;
  const row = db.prepare("SELECT * FROM fedi_tokens WHERE token_hash = ?").get(sha256hex(t)) as TokenRow | undefined;
  if (row && (!row.last_used || now() - row.last_used > 60_000)) db.prepare("UPDATE fedi_tokens SET last_used = ? WHERE token_hash = ?").run(now(), row.token_hash);
  return row || null;
}

function optional(req: MReq, _res: Response, next: NextFunction) {
  const t = tokenFrom(req);
  if (t?.account_id) {
    req.token = t;
    req.acc = accountById(t.account_id);
    req.me = req.acc ? actorById(req.acc.id) : undefined;
  } else if (t) req.token = t;
  else if (req.headers.authorization) return next(new FediError(401, "The access token is invalid"));
  next();
}
function required(req: MReq, res: Response, next: NextFunction) {
  optional(req, res, (e?: any) => {
    if (e) return next(e);
    if (!req.acc) return next(new FediError(401, "The access token is invalid"));
    next();
  });
}

export function issueToken(appId: number, accountId: number | null, scopes: string) {
  const token = randomToken(32);
  db.prepare("INSERT INTO fedi_tokens (token_hash, app_id, account_id, scopes, created) VALUES (?, ?, ?, ?, ?)").run(sha256hex(token), appId, accountId, scopes, now());
  return token;
}

// ======================================================================
// Body parsing (JSON, forms, multipart; Mastodon's bracket names)
// ======================================================================

function nest(flat: Record<string, any>) {
  const out: any = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.replace(/\]/g, "").split("[");
    let cur = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      if (last) {
        if (p === "") {
          // "a[]" handled by the parent
        } else if (parts[i + 1] === undefined) cur[p] = v;
      } else {
        const nextKey = parts[i + 1];
        if (nextKey === "" && i + 1 === parts.length - 1) {
          cur[p] = Array.isArray(cur[p]) ? cur[p].concat(v) : Array.isArray(v) ? v : [v];
          break;
        }
        cur[p] = cur[p] && typeof cur[p] === "object" ? cur[p] : {};
        cur = cur[p];
      }
    }
  }
  return out;
}

async function bodyOf(req: Request, opts: { files?: boolean } = {}): Promise<{ body: any; mp: Multipart | null }> {
  if (/^multipart\/form-data/i.test(String(req.headers["content-type"] || ""))) {
    const mp = await parseMultipart(req, { dir: path.join(MEDIA_DIR, "..", "tmp"), maxFileBytes: opts.files ? FEDI_MAX_MB * 1024 * 1024 : 16 * 1024 * 1024 });
    return { body: nest(mp.fields), mp };
  }
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const flat = Object.keys(b).some((k) => k.includes("[")) ? nest(b) : b;
  return { body: { ...nest(req.query as any), ...flat }, mp: null };
}
const bool = (v: any, d = false) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === "1" || v === 1 || v === "on");
const list = (v: any): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : typeof v === "object" ? Object.values(v).map(String) : [String(v)]);

const wrapA =
  (fn: (req: MReq, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = fn(req as MReq, res);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };

// ======================================================================
// Entities
// ======================================================================

const count = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as { c: number }).c;

export function accountJson(a: ActorRow, opts: { source?: boolean } = {}): any {
  if (a.local && !a.fetched) a = actorById(a.id)!;
  const local = !!a.local;
  const followers = local ? count("SELECT COUNT(*) c FROM fedi_follows WHERE followee_id = ? AND state = 'accepted'", a.id) : Math.max(a.followers_count, 0);
  const following = local ? count("SELECT COUNT(*) c FROM fedi_follows WHERE follower_id = ? AND state = 'accepted'", a.id) : Math.max(a.following_count, 0);
  const statuses = local ? count("SELECT COUNT(*) c FROM fedi_statuses WHERE actor_id = ? AND visibility IN ('public','unlisted')", a.id) : Math.max(a.statuses_count, 0);
  const last = (db.prepare("SELECT MAX(created_at) t FROM fedi_statuses WHERE actor_id = ?").get(a.id) as { t: number | null }).t;
  const out: any = {
    id: String(a.id),
    username: a.username,
    acct: local ? a.username : `${a.username}@${a.domain}`,
    display_name: a.display_name || "",
    locked: !!a.locked,
    bot: !!a.bot,
    discoverable: !!a.discoverable,
    indexable: !!a.discoverable,
    group: a.type === "Group",
    created_at: iso(new Date(isoDay(a.created_at)).getTime()),
    note: a.note || "",
    url: local ? `${FEDI_URL}/@${a.username}` : a.url || a.uri,
    uri: a.uri,
    avatar: a.avatar || DEFAULT_AVATAR(),
    avatar_static: a.avatar || DEFAULT_AVATAR(),
    header: a.header || DEFAULT_HEADER(),
    header_static: a.header || DEFAULT_HEADER(),
    followers_count: followers,
    following_count: following,
    statuses_count: statuses,
    last_status_at: last ? isoDay(last) : null,
    hide_collections: false,
    noindex: !a.discoverable,
    emojis: json(a.emojis, []),
    roles: [],
    fields: json(a.fields, []),
  };
  if (a.moved_to) {
    const m = db.prepare("SELECT * FROM fedi_actors WHERE uri = ?").get(a.moved_to) as ActorRow | undefined;
    if (m) out.moved = accountJson(m);
  }
  if (opts.source && local) {
    const acc = accountById(a.local!)!;
    const s = json(acc.settings, {});
    out.source = {
      privacy: s.privacy || "public",
      sensitive: !!s.sensitive,
      language: s.language || "",
      note: s.note_source ?? htmlToText(a.note || ""),
      fields: (s.fields_source || json(a.fields, []).map((f: any) => ({ name: f.name, value: htmlToText(f.value) }))).map((f: any) => ({ ...f, verified_at: null })),
      follow_requests_count: count("SELECT COUNT(*) c FROM fedi_follows WHERE followee_id = ? AND state = 'pending'", a.id),
      hide_collections: false,
      discoverable: !!a.discoverable,
      indexable: !!a.discoverable,
    };
    out.role = { id: "-99", name: "", permissions: "0", color: "", highlighted: false };
  }
  return out;
}

export function canSee(st: StatusRow, viewerId: number | null): boolean {
  if (st.visibility === "public" || st.visibility === "unlisted") return true;
  if (!viewerId) return false;
  if (st.actor_id === viewerId) return true;
  const mentioned = (json(st.mentions, []) as any[]).some((m) => m.id === viewerId);
  if (mentioned) return true;
  return st.visibility === "private" && follows(viewerId, st.actor_id);
}

export function mediaJson(m: MediaRow) {
  const meta = json(m.meta, {});
  const url = mediaUrl(m);
  return {
    id: String(m.id),
    type: m.type,
    url,
    preview_url: thumbUrl(m),
    remote_url: m.file ? null : m.remote_url,
    preview_remote_url: null,
    text_url: null,
    meta: Object.keys(meta).length ? meta : null,
    description: m.description,
    blurhash: m.blurhash,
    // Scute: the original file name and size, for attachments of any kind
    name: m.name,
    mime: m.mime,
    size: m.size || null,
  };
}

function pollJson(st: StatusRow, viewerId: number | null) {
  const p = json(st.poll, null);
  if (!p) return null;
  const own = viewerId ? (db.prepare("SELECT choices FROM fedi_votes WHERE account_id = ? AND status_id = ?").get(viewerId, st.id) as { choices: string } | undefined) : undefined;
  const votes = p.options.reduce((s: number, o: any) => s + (o.votes_count || 0), 0);
  return {
    id: String(st.id),
    expires_at: p.expires_at || null,
    expired: !!(p.expires_at && Date.parse(p.expires_at) < now()),
    multiple: !!p.multiple,
    votes_count: votes,
    voters_count: p.multiple ? (p.voters_count ?? null) : (p.voters_count ?? votes),
    options: p.options.map((o: any) => ({ title: o.title, votes_count: o.votes_count ?? 0 })),
    emojis: [],
    voted: viewerId ? !!own || st.actor_id === viewerId : false,
    own_votes: own ? json(own.choices, []) : [],
  };
}

export function statusJson(st: StatusRow, viewerId: number | null, depth = 0): any {
  const a = actorById(st.actor_id)!;
  if (st.reblog_of) {
    const orig = statusById(st.reblog_of);
    const r = orig && depth < 1 ? statusJson(orig, viewerId, depth + 1) : null;
    return {
      ...baseStatus(st, a, viewerId),
      reblog: r,
      content: "",
      media_attachments: [],
      reblogged: r?.reblogged ?? false,
      favourited: r?.favourited ?? false,
      bookmarked: r?.bookmarked ?? false,
    };
  }
  return { ...baseStatus(st, a, viewerId), reblog: null };
}

function baseStatus(st: StatusRow, a: ActorRow, viewerId: number | null) {
  const mentions = (json(st.mentions, []) as any[]).map((m) => {
    const x = actorById(m.id);
    return x
      ? { id: String(x.id), username: x.username, url: x.local ? `${FEDI_URL}/@${x.username}` : x.url || x.uri, acct: x.local ? x.username : `${x.username}@${x.domain}` }
      : { id: String(m.id), username: m.acct.split("@")[0], url: m.uri, acct: m.acct };
  });
  const app = json(st.app, null);
  return {
    id: String(st.id),
    created_at: iso(st.created_at),
    in_reply_to_id: st.in_reply_to_id ? String(st.in_reply_to_id) : null,
    in_reply_to_account_id: st.in_reply_to_actor_id ? String(st.in_reply_to_actor_id) : null,
    sensitive: !!st.sensitive,
    spoiler_text: st.spoiler || "",
    visibility: st.visibility,
    language: st.language,
    uri: st.uri,
    url: st.url || st.uri,
    replies_count: count("SELECT COUNT(*) c FROM fedi_statuses WHERE in_reply_to_id = ?", st.id),
    reblogs_count: count("SELECT COUNT(*) c FROM fedi_statuses WHERE reblog_of = ?", st.id),
    favourites_count: count("SELECT COUNT(*) c FROM fedi_likes WHERE status_id = ?", st.id),
    edited_at: st.edited_at ? iso(st.edited_at) : null,
    favourited: viewerId ? !!db.prepare("SELECT 1 FROM fedi_likes WHERE actor_id = ? AND status_id = ?").get(viewerId, st.id) : false,
    reblogged: viewerId ? !!db.prepare("SELECT 1 FROM fedi_statuses WHERE actor_id = ? AND reblog_of = ?").get(viewerId, st.id) : false,
    muted: false,
    bookmarked: viewerId ? !!db.prepare("SELECT 1 FROM fedi_bookmarks WHERE account_id = ? AND status_id = ?").get(viewerId, st.id) : false,
    pinned: viewerId === st.actor_id ? !!st.pinned : undefined,
    content: st.content,
    filtered: [],
    account: accountJson(a),
    media_attachments: mediaOf(st.id).map(mediaJson),
    mentions,
    tags: (json(st.tags, []) as string[]).map((t) => ({ name: t, url: `${FEDI_URL}/tags/${encodeURIComponent(t)}` })),
    emojis: json(st.emojis, []),
    card: null,
    poll: pollJson(st, viewerId),
    application: st.local ? (app ? { name: app.name, website: app.website || null } : { name: "Scute", website: null }) : null,
    text: null as string | null,
  };
}

export function notificationJson(n: any, viewerId: number) {
  const from = actorById(n.from_id);
  const st = n.status_id ? statusById(n.status_id) : null;
  return {
    id: String(n.id),
    type: n.type,
    created_at: iso(n.created),
    group_key: `ungrouped-${n.id}`,
    account: from ? accountJson(from) : null,
    status: st ? statusJson(st, viewerId) : null,
  };
}

function relationship(me: ActorRow, other: ActorRow) {
  const f = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(me.id, other.id) as any;
  const r = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(other.id, me.id) as any;
  const b = (kind: string, x = me.id, y = other.id) => !!db.prepare("SELECT 1 FROM fedi_blocks WHERE account_id = ? AND target_id = ? AND kind = ?").get(x, y, kind);
  return {
    id: String(other.id),
    following: f?.state === "accepted",
    showing_reblogs: f ? !!f.reblogs : false,
    notifying: f ? !!f.notify : false,
    languages: null,
    followed_by: r?.state === "accepted",
    blocking: b("block"),
    blocked_by: b("blocked_by", other.id, me.id),
    muting: b("mute"),
    muting_notifications: b("mute"),
    requested: f?.state === "pending",
    requested_by: r?.state === "pending",
    domain_blocking: !!db.prepare("SELECT 1 FROM fedi_domain_blocks WHERE account_id = ? AND domain = ?").get(me.id, other.domain),
    endorsed: false,
    note: "",
  };
}

// ======================================================================
// Pagination
// ======================================================================

interface Page {
  where: string;
  args: any[];
  limit: number;
  asc: boolean;
}
function pageOf(req: Request, col = "id", def = 20, max = 40): Page {
  const q = req.query as any;
  const limit = Math.min(Math.max(Number(q.limit) || def, 1), max);
  const w: string[] = [];
  const a: any[] = [];
  if (q.max_id) w.push(`${col} < ?`), a.push(Number(q.max_id));
  if (q.since_id) w.push(`${col} > ?`), a.push(Number(q.since_id));
  if (q.min_id) w.push(`${col} > ?`), a.push(Number(q.min_id));
  return { where: w.length ? " AND " + w.join(" AND ") : "", args: a, limit, asc: !!q.min_id && !q.max_id };
}
function linkHeader(req: Request, res: Response, ids: (number | string)[]) {
  if (!ids.length) return;
  const base = `${FEDI_URL}${req.baseUrl}${req.path}`;
  const q = { ...(req.query as any) };
  delete q.max_id;
  delete q.min_id;
  delete q.since_id;
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...q, ...extra }).toString();
  const next = `<${base}?${qs({ max_id: String(ids[ids.length - 1]) })}>; rel="next"`;
  const prev = `<${base}?${qs({ min_id: String(ids[0]) })}>; rel="prev"`;
  res.setHeader("Link", `${next}, ${prev}`);
}
/** Run a status query of the form "SELECT s.* ... WHERE ... {page}" and answer with statuses. */
function sendStatuses(req: MReq, res: Response, sql: string, args: any[], p: Page, idCol = "s.id") {
  let rows = db.prepare(`${sql}${p.where.replace(/\bid\b/g, idCol)} ORDER BY ${idCol} ${p.asc ? "ASC" : "DESC"} LIMIT ?`).all(...args, ...p.args, p.limit) as (StatusRow & { _cursor?: number })[];
  if (p.asc) rows = rows.reverse();
  const viewer = req.me?.id ?? null;
  const out = rows.filter((s) => canSee(s, viewer)).map((s) => statusJson(s, viewer));
  linkHeader(req, res, rows.map((r) => r._cursor ?? r.id));
  res.json(out);
}

// ======================================================================
// Lookups
// ======================================================================

function actorParam(id: string): ActorRow {
  const a = /^\d+$/.test(id) ? actorById(Number(id)) : undefined;
  if (!a) throw new FediError(404, "Record not found");
  return a;
}
function statusParam(id: string, viewer: number | null): StatusRow {
  const st = /^\d+$/.test(id) ? statusById(Number(id)) : undefined;
  if (!st || !canSee(st, viewer)) throw new FediError(404, "Record not found");
  return st;
}
async function freshen(a: ActorRow) {
  if (a.local) return a;
  if (!a.fetched || now() - a.fetched > 86400_000) return (await resolveActor(a.uri, { refresh: true })) || a;
  // looked at again after a while: refresh the profile and counts in the background
  if (now() - a.fetched > 3600_000) void resolveActor(a.uri, { refresh: true }).catch(() => null);
  return a;
}

// ======================================================================
// Routes
// ======================================================================

export function instanceV2() {
  const owner = db.prepare("SELECT a.* FROM fedi_accounts c JOIN fedi_actors a ON a.id = c.id ORDER BY c.created LIMIT 1").get() as ActorRow | undefined;
  const users = count("SELECT COUNT(*) c FROM fedi_accounts");
  return {
    domain: FEDI_DOMAIN,
    title: FEDI_DOMAIN,
    version: MASTO_VERSION,
    source_url: "https://github.com/",
    description: `A small Fediverse server run with Scute.`,
    usage: { users: { active_month: users } },
    thumbnail: { url: `${FEDI_URL}/fedi/static/header.png` },
    icon: [],
    languages: ["en"],
    configuration: {
      urls: { streaming: FEDI_URL.replace(/^http/, "ws"), status: null },
      vapid: { public_key: vapidKeys().pub },
      accounts: { max_featured_tags: 0, max_pinned_statuses: 5 },
      statuses: { max_characters: MAX_CHARS, max_media_attachments: MAX_MEDIA, characters_reserved_per_url: 23 },
      media_attachments: {
        supported_mime_types: SUPPORTED_MIME,
        image_size_limit: FEDI_MAX_MB * 1024 * 1024,
        image_matrix_limit: 33177600,
        video_size_limit: FEDI_MAX_MB * 1024 * 1024,
        video_frame_rate_limit: 120,
        video_matrix_limit: 8294400,
        description_limit: 1500,
      },
      polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
      translation: { enabled: false },
    },
    registrations: { enabled: false, approval_required: false, message: null, url: null },
    api_versions: { mastodon: 2 },
    contact: { email: "", account: owner ? accountJson(owner) : null },
    rules: [],
  };
}
const SUPPORTED_MIME = [
  "image/jpeg", "image/png", "image/gif", "image/heic", "image/heif", "image/webp", "image/avif",
  "video/webm", "video/mp4", "video/quicktime", "video/ogg",
  "audio/wave", "audio/wav", "audio/x-wav", "audio/x-pn-wave", "audio/vnd.wave", "audio/ogg", "audio/vorbis", "audio/mpeg", "audio/mp3", "audio/webm", "audio/flac", "audio/aac", "audio/m4a", "audio/x-m4a", "audio/mp4", "audio/3gpp", "video/x-ms-asf",
  "application/pdf", "application/zip", "application/epub+zip", "text/plain", "text/markdown", "text/csv", "application/json", "application/gpx+xml", "application/octet-stream",
];

export function registerMastodonApi(app: Express) {
  const g = (p: string, ...h: any[]) => app.get(p, ...h);
  const post = (p: string, ...h: any[]) => app.post(p, ...h);
  const del = (p: string, ...h: any[]) => app.delete(p, ...h);
  const put = (p: string, ...h: any[]) => app.put(p, ...h);
  const patch = (p: string, ...h: any[]) => app.patch(p, ...h);

  // ---------- instance ----------
  g("/api/v2/instance", (_q: Request, res: Response) => res.json(instanceV2()));
  g("/api/v1/instance", (_q: Request, res: Response) => {
    const v2 = instanceV2();
    res.json({
      uri: FEDI_DOMAIN,
      title: v2.title,
      short_description: v2.description,
      description: v2.description,
      email: "",
      version: MASTO_VERSION,
      urls: { streaming_api: v2.configuration.urls.streaming },
      stats: { user_count: v2.usage.users.active_month, status_count: count("SELECT COUNT(*) c FROM fedi_statuses WHERE local = 1"), domain_count: count("SELECT COUNT(DISTINCT domain) c FROM fedi_actors WHERE local IS NULL") },
      thumbnail: v2.thumbnail.url,
      languages: v2.languages,
      registrations: false,
      approval_required: false,
      invites_enabled: false,
      configuration: { ...v2.configuration, accounts: undefined },
      contact_account: v2.contact.account,
      rules: [],
    });
  });
  g("/api/v1/instance/peers", (_q: Request, res: Response) => res.json((db.prepare("SELECT DISTINCT domain FROM fedi_actors WHERE local IS NULL AND domain != ''").all() as any[]).map((r) => r.domain)));
  g("/api/v1/instance/activity", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/instance/rules", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/instance/extended_description", (_q: Request, res: Response) => res.json({ updated_at: iso(now()), content: "" }));
  g("/api/v1/instance/domain_blocks", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/instance/translation_languages", (_q: Request, res: Response) => res.json({}));
  g("/api/v1/custom_emojis", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/announcements", (_q: Request, res: Response) => res.json([]));
  for (const p of ["/api/v1/trends", "/api/v1/trends/tags", "/api/v1/trends/statuses", "/api/v1/trends/links", "/api/v1/suggestions", "/api/v2/suggestions", "/api/v1/directory", "/api/v1/endorsements", "/api/v1/featured_tags", "/api/v1/featured_tags/suggestions", "/api/v1/followed_tags", "/api/v1/lists", "/api/v1/filters", "/api/v2/filters", "/api/v1/scheduled_statuses", "/api/v1/reports"])
    g(p, optional, (_q: Request, res: Response) => res.json([]));
  g("/api/v1/accounts/:id/featured_tags", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/accounts/:id/lists", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/accounts/:id/identity_proofs", (_q: Request, res: Response) => res.json([]));
  g("/api/v1/accounts/familiar_followers", required, wrapA((req, res) => res.json(list((req.query as any)["id[]"] ?? (req.query as any).id).map((id) => ({ id, accounts: [] })))));
  g("/api/v1/preferences", required, wrapA((req, res) => {
    const s = json(req.acc!.settings, {});
    res.json({ "posting:default:visibility": s.privacy || "public", "posting:default:sensitive": !!s.sensitive, "posting:default:language": s.language || null, "reading:expand:media": "default", "reading:expand:spoilers": false });
  }));

  // ---------- apps ----------
  post("/api/v1/apps", wrapA(async (req, res) => {
    const { body, mp } = await bodyOf(req);
    cleanupUploads(mp);
    const name = String(body.client_name || "").trim().slice(0, 100);
    if (!name) throw new FediError(422, "client_name is required");
    const redirects = list(body.redirect_uris).flatMap((s) => s.split(/\s+/)).filter(Boolean);
    if (!redirects.length) redirects.push("urn:ietf:wg:oauth:2.0:oob");
    const scopes = String(body.scopes || "read").trim() || "read";
    const clientId = randomToken(24);
    const secret = randomToken(32);
    const r = db.prepare("INSERT INTO fedi_apps (client_id, client_secret, name, website, redirect_uris, scopes, created) VALUES (?, ?, ?, ?, ?, ?, ?)").run(clientId, secret, name, body.website ? String(body.website).slice(0, 300) : null, redirects.join("\n"), scopes, now());
    res.json({ id: String(r.lastInsertRowid), name, website: body.website || null, scopes: scopes.split(/\s+/), redirect_uri: redirects.join("\n"), redirect_uris: redirects, client_id: clientId, client_secret: secret, client_secret_expires_at: 0, vapid_key: vapidKeys().pub });
  }));
  g("/api/v1/apps/verify_credentials", optional, wrapA((req, res) => {
    if (!req.token) throw new FediError(401, "The access token is invalid");
    const a = db.prepare("SELECT * FROM fedi_apps WHERE id = ?").get(req.token.app_id) as any;
    res.json({ id: String(a?.id ?? 0), name: a?.name || "Scute", website: a?.website || null, scopes: (req.token.scopes || "read").split(/\s+/), vapid_key: vapidKeys().pub });
  }));

  // ---------- accounts ----------
  g("/api/v1/accounts/verify_credentials", required, wrapA((req, res) => res.json(accountJson(req.me!, { source: true }))));
  patch("/api/v1/accounts/update_credentials", required, wrapA(async (req, res) => {
    const { body, mp } = await bodyOf(req, { files: true });
    try {
      const acc = req.acc!;
      const me = req.me!;
      const s = json(acc.settings, {});
      const sets: string[] = [];
      const args: any[] = [];
      if (body.display_name !== undefined) sets.push("display_name = ?"), args.push(String(body.display_name).slice(0, 100));
      if (body.note !== undefined) {
        s.note_source = String(body.note).slice(0, 2000);
        sets.push("note = ?"), args.push(s.note_source.trim() ? (await renderText(s.note_source)).html : "");
      }
      if (body.locked !== undefined) sets.push("locked = ?"), args.push(bool(body.locked) ? 1 : 0);
      if (body.bot !== undefined) sets.push("bot = ?"), args.push(bool(body.bot) ? 1 : 0);
      if (body.discoverable !== undefined) sets.push("discoverable = ?"), args.push(bool(body.discoverable) ? 1 : 0);
      if (body.fields_attributes !== undefined) {
        const raw = Array.isArray(body.fields_attributes) ? body.fields_attributes : Object.values(body.fields_attributes || {});
        const src = (raw as any[]).filter((f) => f && (f.name || f.value)).slice(0, 4).map((f) => ({ name: String(f.name || "").slice(0, 255), value: String(f.value || "").slice(0, 255) }));
        s.fields_source = src;
        const fields = [];
        for (const f of src) {
          const r = await renderText(f.value);
          fields.push({ name: f.name, value: r.html.replace(/^<p>|<\/p>$/g, ""), verified_at: null });
        }
        sets.push("fields = ?"), args.push(JSON.stringify(fields));
      }
      const src = body.source || {};
      if (src.privacy) s.privacy = String(src.privacy);
      if (src.sensitive !== undefined) s.sensitive = bool(src.sensitive);
      if (src.language !== undefined) s.language = String(src.language || "");
      for (const which of ["avatar", "header"] as const) {
        const f = mp?.files[which];
        if (f && f.size) {
          if (!/^image\//.test(f.mime)) throw new FediError(422, `The ${which} must be an image`);
          const m = await saveUpload(acc, f, {});
          sets.push(`${which} = ?`), args.push(mediaUrl(m));
        } else if (body[which] === "" && mp && !f) {
          sets.push(`${which} = NULL`);
        }
      }
      db.prepare("UPDATE fedi_accounts SET settings = ? WHERE id = ?").run(JSON.stringify(s), acc.id);
      if (sets.length) db.prepare(`UPDATE fedi_actors SET ${sets.join(", ")} WHERE id = ?`).run(...args, me.id);
      sendProfileUpdate(accountById(acc.id)!);
      res.json(accountJson(actorById(me.id)!, { source: true }));
    } finally {
      cleanupUploads(mp);
    }
  }));
  del("/api/v1/profile/avatar", required, wrapA((req, res) => {
    db.prepare("UPDATE fedi_actors SET avatar = NULL WHERE id = ?").run(req.me!.id);
    sendProfileUpdate(req.acc!);
    res.json(accountJson(actorById(req.me!.id)!, { source: true }));
  }));
  del("/api/v1/profile/header", required, wrapA((req, res) => {
    db.prepare("UPDATE fedi_actors SET header = NULL WHERE id = ?").run(req.me!.id);
    sendProfileUpdate(req.acc!);
    res.json(accountJson(actorById(req.me!.id)!, { source: true }));
  }));
  g("/api/v1/accounts/relationships", required, wrapA((req, res) => {
    const q = req.query as any;
    const ids = list(q["id[]"] ?? q.id);
    res.json(ids.map((id) => actorById(Number(id))).filter(Boolean).map((a) => relationship(req.me!, a!)));
  }));
  g("/api/v1/accounts/lookup", optional, wrapA(async (req, res) => {
    const acct = String((req.query as any).acct || "").replace(/^@/, "");
    const a = await webfinger(acct);
    if (!a) throw new FediError(404, "Record not found");
    res.json(accountJson(a));
  }));
  g("/api/v1/accounts/search", required, wrapA(async (req, res) => {
    const q = req.query as any;
    res.json((await searchAccounts(String(q.q || ""), bool(q.resolve), Number(q.limit) || 20, req.me!.id, bool(q.following))).map((a) => accountJson(a)));
  }));
  g("/api/v1/accounts/:id", optional, wrapA(async (req, res) => res.json(accountJson(await freshen(actorParam(req.params.id))))));
  g("/api/v1/accounts/:id/statuses", optional, wrapA(async (req, res) => {
    let a = actorParam(req.params.id);
    const q = req.query as any;
    const p = pageOf(req);
    if (!a.local && !q.max_id && !q.min_id && !q.since_id) {
      const have = count("SELECT COUNT(*) c FROM fedi_statuses WHERE actor_id = ?", a.id);
      if (have < 10 && a.outbox) {
        a = await freshen(a);
        await fetchOutbox(a, 20).catch(() => null);
      }
    }
    let where = "WHERE s.actor_id = ?";
    if (bool(q.pinned)) where += " AND s.pinned = 1";
    if (bool(q.exclude_replies)) where += " AND (s.in_reply_to_id IS NULL AND s.in_reply_to_uri IS NULL OR s.in_reply_to_actor_id = s.actor_id)";
    if (bool(q.exclude_reblogs)) where += " AND s.reblog_of IS NULL";
    if (bool(q.only_media)) where += " AND EXISTS (SELECT 1 FROM fedi_media m WHERE m.status_id = s.id)";
    if (q.tagged) where += ` AND s.tags LIKE '%"' || ? || '"%'`;
    const args: any[] = [a.id];
    if (q.tagged) args.push(String(q.tagged).toLowerCase());
    sendStatuses(req, res, `SELECT s.* FROM fedi_statuses s ${where}`, args, p);
  }));
  const actorList = (sql: string) =>
    wrapA((req, res) => {
      const a = actorParam(req.params.id);
      const p = pageOf(req, "f.rowid");
      const rows = db.prepare(`${sql}${p.where.replace(/\bf\.rowid\b/g, "f.rowid")} ORDER BY f.rowid DESC LIMIT ?`).all(a.id, ...p.args, p.limit) as (ActorRow & { _c: number })[];
      linkHeader(req, res, rows.map((r) => r._c));
      res.json(rows.map((r) => accountJson(r)));
    });
  g("/api/v1/accounts/:id/followers", optional, actorList("SELECT a.*, f.rowid _c FROM fedi_follows f JOIN fedi_actors a ON a.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'accepted'"));
  g("/api/v1/accounts/:id/following", optional, actorList("SELECT a.*, f.rowid _c FROM fedi_follows f JOIN fedi_actors a ON a.id = f.followee_id WHERE f.follower_id = ? AND f.state = 'accepted'"));
  post("/api/v1/accounts/:id/follow", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    let a = await freshen(actorParam(req.params.id));
    if (!a.local && !a.inbox) throw new FediError(422, "That account can't be followed");
    followActor(req.acc!, a, { reblogs: bool(body.reblogs, true), notify: bool(body.notify) });
    if (a.local) await new Promise((r) => setTimeout(r, 30));
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/unfollow", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    unfollowActor(req.acc!, a);
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/remove_from_followers", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    const row = db.prepare("SELECT uri FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(a.id, req.me!.id) as any;
    if (row) {
      db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(a.id, req.me!.id);
      if (!a.local) sendReject(req.acc!, a, row.uri);
    }
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/block", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    blockActor(req.acc!, a);
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/unblock", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    unblockActor(req.acc!, a);
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/mute", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    db.prepare("INSERT OR IGNORE INTO fedi_blocks (account_id, target_id, kind, created) VALUES (?, ?, 'mute', ?)").run(req.me!.id, a.id, now());
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/unmute", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    db.prepare("DELETE FROM fedi_blocks WHERE account_id = ? AND target_id = ? AND kind = 'mute'").run(req.me!.id, a.id);
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/accounts/:id/note", required, wrapA((req, res) => res.json(relationship(req.me!, actorParam(req.params.id)))));
  post("/api/v1/accounts/:id/pin", required, wrapA((req, res) => res.json(relationship(req.me!, actorParam(req.params.id)))));
  post("/api/v1/accounts/:id/unpin", required, wrapA((req, res) => res.json(relationship(req.me!, actorParam(req.params.id)))));

  const blockList = (kind: string) =>
    wrapA((req, res) => {
      const rows = db.prepare("SELECT a.* FROM fedi_blocks b JOIN fedi_actors a ON a.id = b.target_id WHERE b.account_id = ? AND b.kind = ? ORDER BY b.created DESC LIMIT 80").all(req.me!.id, kind) as ActorRow[];
      res.json(rows.map((r) => accountJson(r)));
    });
  g("/api/v1/blocks", required, blockList("block"));
  g("/api/v1/mutes", required, blockList("mute"));
  g("/api/v1/domain_blocks", required, wrapA((req, res) => res.json((db.prepare("SELECT domain FROM fedi_domain_blocks WHERE account_id = ?").all(req.me!.id) as any[]).map((r) => r.domain))));
  post("/api/v1/domain_blocks", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    const d = String(body.domain || "").trim().toLowerCase();
    if (d) db.prepare("INSERT OR IGNORE INTO fedi_domain_blocks (account_id, domain) VALUES (?, ?)").run(req.me!.id, d);
    res.json({});
  }));
  del("/api/v1/domain_blocks", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    db.prepare("DELETE FROM fedi_domain_blocks WHERE account_id = ? AND domain = ?").run(req.me!.id, String(body.domain || "").trim().toLowerCase());
    res.json({});
  }));

  // ---------- follow requests ----------
  g("/api/v1/follow_requests", required, wrapA((req, res) => {
    const rows = db.prepare("SELECT a.* FROM fedi_follows f JOIN fedi_actors a ON a.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'pending' ORDER BY f.created DESC").all(req.me!.id) as ActorRow[];
    res.json(rows.map((r) => accountJson(r)));
  }));
  post("/api/v1/follow_requests/:id/authorize", required, wrapA(async (req, res) => {
    const a = actorParam(req.params.id);
    const row = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ? AND state = 'pending'").get(a.id, req.me!.id) as any;
    if (row) {
      db.prepare("UPDATE fedi_follows SET state = 'accepted' WHERE follower_id = ? AND followee_id = ?").run(a.id, req.me!.id);
      db.prepare("DELETE FROM fedi_notifications WHERE account_id = ? AND from_id = ? AND type = 'follow_request'").run(req.me!.id, a.id);
      notify(req.me!.id, "follow", a.id, null);
      if (a.local) {
        // local followers: their pending follow is accepted directly
        void backfill(req.me!, a.id);
      } else sendAccept(req.acc!, a, row.uri);
    }
    res.json(relationship(req.me!, a));
  }));
  post("/api/v1/follow_requests/:id/reject", required, wrapA((req, res) => {
    const a = actorParam(req.params.id);
    const row = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ? AND state = 'pending'").get(a.id, req.me!.id) as any;
    if (row) {
      db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(a.id, req.me!.id);
      db.prepare("DELETE FROM fedi_notifications WHERE account_id = ? AND from_id = ? AND type = 'follow_request'").run(req.me!.id, a.id);
      if (!a.local) sendReject(req.acc!, a, row.uri);
    }
    res.json(relationship(req.me!, a));
  }));

  // ---------- statuses ----------
  post("/api/v1/statuses", required, wrapA(async (req, res) => {
    const { body, mp } = await bodyOf(req);
    cleanupUploads(mp);
    const app = db.prepare("SELECT name, website FROM fedi_apps WHERE id = ?").get(req.token!.app_id) as any;
    const pollIn = body.poll && typeof body.poll === "object" ? { options: list(body.poll.options), expires_in: Number(body.poll.expires_in), multiple: bool(body.poll.multiple) } : null;
    const st = await createLocalStatus(req.acc!, {
      status: body.status,
      spoiler_text: body.spoiler_text,
      visibility: body.visibility,
      sensitive: bool(body.sensitive),
      language: body.language,
      in_reply_to_id: body.in_reply_to_id,
      media_ids: list(body.media_ids),
      poll: pollIn,
      app: app ? { name: app.name, website: app.website } : null,
    });
    res.json(statusJson(st, req.me!.id));
  }));
  g("/api/v1/statuses", optional, wrapA((req, res) => {
    const q = req.query as any;
    res.json(list(q["id[]"] ?? q.id).map((id) => statusById(Number(id))).filter((s) => s && canSee(s, req.me?.id ?? null)).map((s) => statusJson(s!, req.me?.id ?? null)));
  }));
  g("/api/v1/statuses/:id", optional, wrapA((req, res) => res.json(statusJson(statusParam(req.params.id, req.me?.id ?? null), req.me?.id ?? null))));
  put("/api/v1/statuses/:id", required, wrapA(async (req, res) => {
    const { body, mp } = await bodyOf(req);
    cleanupUploads(mp);
    const st = statusParam(req.params.id, req.me!.id);
    // descriptions can be changed while editing
    for (const ma of Array.isArray(body.media_attributes) ? body.media_attributes : Object.values(body.media_attributes || {})) {
      const m = ma as any;
      if (m?.id) db.prepare("UPDATE fedi_media SET description = ? WHERE id = ? AND account_id = ?").run(String(m.description || "").slice(0, 1500), Number(m.id), req.acc!.id);
    }
    const fresh = await editLocalStatus(req.acc!, st, { status: body.status, spoiler_text: body.spoiler_text, sensitive: body.sensitive !== undefined ? bool(body.sensitive) : undefined, language: body.language, media_ids: body.media_ids !== undefined ? list(body.media_ids) : undefined });
    res.json(statusJson(fresh, req.me!.id));
  }));
  del("/api/v1/statuses/:id", required, wrapA((req, res) => {
    const st = statusParam(req.params.id, req.me!.id);
    const out = statusJson(st, req.me!.id);
    out.text = st.source || htmlToText(st.content);
    deleteLocalStatus(req.acc!, st);
    res.json(out);
  }));
  g("/api/v1/statuses/:id/source", required, wrapA((req, res) => {
    const st = statusParam(req.params.id, req.me!.id);
    res.json({ id: String(st.id), text: st.source ?? htmlToText(st.content), spoiler_text: st.spoiler });
  }));
  g("/api/v1/statuses/:id/history", optional, wrapA((req, res) => {
    const st = statusParam(req.params.id, req.me?.id ?? null);
    const a = accountJson(actorById(st.actor_id)!);
    const hist = (json(st.history, []) as any[]).map((h) => ({ content: h.content, spoiler_text: h.spoiler_text, sensitive: h.sensitive, created_at: h.created_at, account: a, media_attachments: (h.media || []).map((id: number) => db.prepare("SELECT * FROM fedi_media WHERE id = ?").get(id)).filter(Boolean).map(mediaJson), emojis: [] }));
    hist.push({ content: st.content, spoiler_text: st.spoiler, sensitive: !!st.sensitive, created_at: iso(st.edited_at || st.created_at), account: a, media_attachments: mediaOf(st.id).map(mediaJson), emojis: [] });
    res.json(hist);
  }));
  g("/api/v1/statuses/:id/context", optional, wrapA(async (req, res) => {
    const viewer = req.me?.id ?? null;
    const st = statusParam(req.params.id, viewer);
    const ancestors: StatusRow[] = [];
    let cur: StatusRow | undefined = st;
    for (let i = 0; i < 40 && cur; i++) {
      let parent: StatusRow | undefined = cur!.in_reply_to_id ? statusById(cur.in_reply_to_id) : undefined;
      if (!parent && cur.in_reply_to_uri && i < 8) {
        const r: { status?: StatusRow } | null = await resolveObject(cur.in_reply_to_uri).catch(() => null);
        parent = r?.status;
        if (parent) db.prepare("UPDATE fedi_statuses SET in_reply_to_id = ?, in_reply_to_actor_id = ? WHERE id = ?").run(parent.id, parent.actor_id, cur.id);
      }
      if (parent) ancestors.unshift(parent);
      cur = parent;
    }
    const descendants: StatusRow[] = [];
    const walk = (id: number, depth: number) => {
      if (depth > 30 || descendants.length > 200) return;
      for (const r of db.prepare("SELECT * FROM fedi_statuses WHERE in_reply_to_id = ? ORDER BY id").all(id) as StatusRow[]) {
        descendants.push(r);
        walk(r.id, depth + 1);
      }
    };
    walk(st.id, 0);
    res.json({ ancestors: ancestors.filter((s) => canSee(s, viewer)).map((s) => statusJson(s, viewer)), descendants: descendants.filter((s) => canSee(s, viewer)).map((s) => statusJson(s, viewer)) });
  }));
  const act = (fn: (acc: AccountRow, st: StatusRow) => StatusRow | void, useOriginal = true) =>
    wrapA((req, res) => {
      let st = statusParam(req.params.id, req.me!.id);
      if (useOriginal && st.reblog_of) st = statusById(st.reblog_of) || st;
      const out = fn(req.acc!, st);
      res.json(statusJson(out && out.reblog_of ? out : statusById(st.id)!, req.me!.id));
    });
  post("/api/v1/statuses/:id/favourite", required, act((acc, st) => likeStatus(acc, st)));
  post("/api/v1/statuses/:id/unfavourite", required, act((acc, st) => unlikeStatus(acc, st)));
  post("/api/v1/statuses/:id/reblog", required, act((acc, st) => reblogStatus(acc, st)));
  post("/api/v1/statuses/:id/unreblog", required, act((acc, st) => unreblogStatus(acc, st)));
  post("/api/v1/statuses/:id/bookmark", required, act((acc, st) => void db.prepare("INSERT OR IGNORE INTO fedi_bookmarks (account_id, status_id, created) VALUES (?, ?, ?)").run(acc.id, st.id, now())));
  post("/api/v1/statuses/:id/unbookmark", required, act((acc, st) => void db.prepare("DELETE FROM fedi_bookmarks WHERE account_id = ? AND status_id = ?").run(acc.id, st.id)));
  post("/api/v1/statuses/:id/pin", required, act((acc, st) => {
    if (st.actor_id !== acc.id) throw new FediError(422, "You can only pin your own posts");
    db.prepare("UPDATE fedi_statuses SET pinned = 1 WHERE id = ?").run(st.id);
  }));
  post("/api/v1/statuses/:id/unpin", required, act((acc, st) => void db.prepare("UPDATE fedi_statuses SET pinned = 0 WHERE id = ? AND actor_id = ?").run(st.id, acc.id)));
  post("/api/v1/statuses/:id/mute", required, act(() => undefined));
  post("/api/v1/statuses/:id/unmute", required, act(() => undefined));
  g("/api/v1/statuses/:id/favourited_by", optional, wrapA((req, res) => {
    const st = statusParam(req.params.id, req.me?.id ?? null);
    res.json((db.prepare("SELECT a.* FROM fedi_likes l JOIN fedi_actors a ON a.id = l.actor_id WHERE l.status_id = ? ORDER BY l.created DESC LIMIT 80").all(st.id) as ActorRow[]).map((a) => accountJson(a)));
  }));
  g("/api/v1/statuses/:id/reblogged_by", optional, wrapA((req, res) => {
    const st = statusParam(req.params.id, req.me?.id ?? null);
    res.json((db.prepare("SELECT a.* FROM fedi_statuses s JOIN fedi_actors a ON a.id = s.actor_id WHERE s.reblog_of = ? ORDER BY s.id DESC LIMIT 80").all(st.id) as ActorRow[]).map((a) => accountJson(a)));
  }));
  g("/api/v1/statuses/:id/card", (_q: Request, res: Response) => res.json({}));
  g("/api/v1/polls/:id", optional, wrapA((req, res) => {
    const st = statusParam(req.params.id, req.me?.id ?? null);
    res.json(pollJson(st, req.me?.id ?? null));
  }));
  post("/api/v1/polls/:id/votes", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    const st = statusParam(req.params.id, req.me!.id);
    voteLocal(req.acc!, st, list(body.choices).map(Number));
    res.json(pollJson(statusById(st.id)!, req.me!.id));
  }));

  // ---------- media ----------
  const upload = wrapA(async (req, res) => {
    const { body, mp } = await bodyOf(req, { files: true });
    try {
      const f = mp?.files.file;
      if (!f || !f.size) throw new FediError(422, "No file");
      const t = mp?.files.thumbnail;
      const m = await saveUpload(req.acc!, f, { description: body.description, focus: body.focus, thumbnail: t && t.size && /^image\//.test(t.mime) ? { path: t.path, mime: t.mime } : null });
      res.json(mediaJson(m));
    } finally {
      cleanupUploads(mp);
    }
  });
  post("/api/v1/media", required, upload);
  post("/api/v2/media", required, upload);
  g("/api/v1/media/:id", required, wrapA((req, res) => {
    const m = db.prepare("SELECT * FROM fedi_media WHERE id = ? AND account_id = ?").get(Number(req.params.id), req.acc!.id) as MediaRow | undefined;
    if (!m) throw new FediError(404, "Record not found");
    res.json(mediaJson(m));
  }));
  put("/api/v1/media/:id", required, wrapA(async (req, res) => {
    const { body, mp } = await bodyOf(req, { files: true });
    try {
      const m = db.prepare("SELECT * FROM fedi_media WHERE id = ? AND account_id = ?").get(Number(req.params.id), req.acc!.id) as MediaRow | undefined;
      if (!m) throw new FediError(404, "Record not found");
      if (body.description !== undefined) db.prepare("UPDATE fedi_media SET description = ? WHERE id = ?").run(String(body.description).slice(0, 1500), m.id);
      if (body.focus) {
        const meta = json(m.meta, {});
        const [x, y] = String(body.focus).split(",").map(Number);
        if (isFinite(x) && isFinite(y)) meta.focus = { x, y };
        db.prepare("UPDATE fedi_media SET meta = ? WHERE id = ?").run(JSON.stringify(meta), m.id);
      }
      res.json(mediaJson(db.prepare("SELECT * FROM fedi_media WHERE id = ?").get(m.id) as MediaRow));
    } finally {
      cleanupUploads(mp);
    }
  }));
  del("/api/v1/media/:id", required, wrapA((req, res) => {
    const m = db.prepare("SELECT * FROM fedi_media WHERE id = ? AND account_id = ? AND status_id IS NULL").get(Number(req.params.id), req.acc!.id) as MediaRow | undefined;
    if (!m) throw new FediError(404, "Record not found");
    db.prepare("DELETE FROM fedi_media WHERE id = ?").run(m.id);
    res.json({});
  }));

  // ---------- timelines ----------
  g("/api/v1/timelines/home", required, wrapA((req, res) => {
    const p = pageOf(req);
    sendStatuses(req, res, "SELECT s.* FROM fedi_home h JOIN fedi_statuses s ON s.id = h.status_id WHERE h.account_id = ?", [req.me!.id], p);
  }));
  g("/api/v1/timelines/public", optional, wrapA((req, res) => {
    const q = req.query as any;
    const p = pageOf(req);
    let where = "WHERE s.visibility = 'public' AND s.reblog_of IS NULL";
    if (bool(q.local)) where += " AND s.local = 1";
    if (bool(q.remote)) where += " AND s.local = 0";
    if (bool(q.only_media)) where += " AND EXISTS (SELECT 1 FROM fedi_media m WHERE m.status_id = s.id)";
    sendStatuses(req, res, `SELECT s.* FROM fedi_statuses s ${where}`, [], p);
  }));
  g("/api/v1/timelines/tag/:tag", optional, wrapA((req, res) => {
    const q = req.query as any;
    const p = pageOf(req);
    let where = `WHERE s.visibility = 'public' AND s.reblog_of IS NULL AND s.tags LIKE '%"' || ? || '"%'`;
    if (bool(q.local)) where += " AND s.local = 1";
    if (bool(q.only_media)) where += " AND EXISTS (SELECT 1 FROM fedi_media m WHERE m.status_id = s.id)";
    sendStatuses(req, res, `SELECT s.* FROM fedi_statuses s ${where}`, [String(req.params.tag).toLowerCase()], p);
  }));
  g("/api/v1/timelines/list/:id", required, (_q: Request, res: Response) => res.json([]));
  g("/api/v1/timelines/direct", required, wrapA((req, res) => {
    const p = pageOf(req);
    sendStatuses(req, res, `SELECT s.* FROM fedi_statuses s WHERE s.visibility = 'direct' AND (s.actor_id = ? OR s.mentions LIKE '%"id":' || ? || ',%')`, [req.me!.id, String(req.me!.id)], p);
  }));
  g("/api/v1/favourites", required, wrapA((req, res) => {
    const p = pageOf(req, "l.rowid");
    sendStatuses(req, res, "SELECT s.*, l.rowid _cursor FROM fedi_likes l JOIN fedi_statuses s ON s.id = l.status_id WHERE l.actor_id = ?", [req.me!.id], p, "l.rowid");
  }));
  g("/api/v1/bookmarks", required, wrapA((req, res) => {
    const p = pageOf(req, "b.rowid");
    sendStatuses(req, res, "SELECT s.*, b.rowid _cursor FROM fedi_bookmarks b JOIN fedi_statuses s ON s.id = b.status_id WHERE b.account_id = ?", [req.me!.id], p, "b.rowid");
  }));
  g("/api/v1/conversations", required, wrapA((req, res) => {
    const me = req.me!.id;
    const rows = db.prepare(`SELECT s.* FROM fedi_statuses s WHERE s.visibility = 'direct' AND (s.actor_id = ? OR s.mentions LIKE '%"id":' || ? || ',%') ORDER BY s.id DESC LIMIT 200`).all(me, String(me)) as StatusRow[];
    const convs = new Map<string, { last: StatusRow; accounts: Set<number> }>();
    for (const s of rows) {
      const people = new Set<number>([s.actor_id, ...(json(s.mentions, []) as any[]).map((m) => m.id)]);
      people.delete(me);
      const key = [...people].sort().join(",");
      if (!convs.has(key)) convs.set(key, { last: s, accounts: people });
    }
    const limit = Math.min(Number((req.query as any).limit) || 20, 40);
    res.json([...convs.values()].slice(0, limit).map((c) => ({ id: String(c.last.id), unread: false, accounts: [...c.accounts].map((id) => actorById(id)).filter(Boolean).map((a) => accountJson(a!)), last_status: statusJson(c.last, me) })));
  }));
  post("/api/v1/conversations/:id/read", required, (_q: Request, res: Response) => res.json({}));
  del("/api/v1/conversations/:id", required, (_q: Request, res: Response) => res.json({}));

  // ---------- notifications ----------
  const notifWhere = (req: Request) => {
    const q = req.query as any;
    const types = list(q["types[]"] ?? q.types);
    const ex = list(q["exclude_types[]"] ?? q.exclude_types);
    let w = "";
    const a: any[] = [];
    if (types.length) w += ` AND type IN (${types.map(() => "?").join(",")})`, a.push(...types);
    if (ex.length) w += ` AND type NOT IN (${ex.map(() => "?").join(",")})`, a.push(...ex);
    if (q.account_id) w += " AND from_id = ?", a.push(Number(q.account_id));
    return { w, a };
  };
  g("/api/v1/notifications", required, wrapA((req, res) => {
    const p = pageOf(req, "id", 15, 80);
    const { w, a } = notifWhere(req);
    let rows = db.prepare(`SELECT * FROM fedi_notifications WHERE account_id = ?${w}${p.where} ORDER BY id ${p.asc ? "ASC" : "DESC"} LIMIT ?`).all(req.me!.id, ...a, ...p.args, p.limit) as any[];
    if (p.asc) rows = rows.reverse();
    linkHeader(req, res, rows.map((r) => r.id));
    res.json(rows.map((n) => notificationJson(n, req.me!.id)).filter((n) => n.account && (n.status || !["mention", "favourite", "reblog", "status", "update", "poll"].includes(n.type))));
  }));
  g("/api/v1/streaming/health", optional, (_q: Request, res: Response) => res.type("text/plain").send("OK"));
  // grouped notifications (Mastodon 4.3); every notification is its own group here
  g("/api/v2/notifications", required, wrapA((req, res) => {
    const p = pageOf(req, "id", 40, 80);
    const { w, a } = notifWhere(req);
    let rows = db.prepare(`SELECT * FROM fedi_notifications WHERE account_id = ?${w}${p.where} ORDER BY id ${p.asc ? "ASC" : "DESC"} LIMIT ?`).all(req.me!.id, ...a, ...p.args, p.limit) as any[];
    if (p.asc) rows = rows.reverse();
    linkHeader(req, res, rows.map((r) => r.id));
    const ns = rows.map((n) => notificationJson(n, req.me!.id)).filter((n) => n.account && (n.status || !["mention", "favourite", "reblog", "status", "update", "poll"].includes(n.type)));
    const accounts = new Map<string, any>();
    const statuses = new Map<string, any>();
    for (const n of ns) {
      accounts.set(n.account.id, n.account);
      if (n.status) {
        statuses.set(n.status.id, n.status);
        if (n.status.reblog) statuses.set(n.status.reblog.id, n.status.reblog);
      }
    }
    res.json({
      accounts: [...accounts.values()],
      statuses: [...statuses.values()],
      notification_groups: ns.map((n) => ({
        group_key: `ungrouped-${n.id}`,
        notifications_count: 1,
        type: n.type,
        most_recent_notification_id: n.id,
        page_min_id: n.id,
        page_max_id: n.id,
        latest_page_notification_at: n.created_at,
        sample_account_ids: [n.account.id],
        status_id: n.status?.id ?? null,
      })),
    });
  }));
  g("/api/v2/notifications/unread_count", required, wrapA((req, res) => {
    const m = db.prepare("SELECT last_read_id FROM fedi_markers WHERE account_id = ? AND timeline = 'notifications'").get(req.me!.id) as any;
    res.json({ count: count("SELECT COUNT(*) c FROM fedi_notifications WHERE account_id = ? AND id > ?", req.me!.id, Number(m?.last_read_id || 0)) });
  }));
  g("/api/v2/notifications/policy", required, (_q: Request, res: Response) => res.json({ for_not_following: "accept", for_not_followers: "accept", for_new_accounts: "accept", for_private_mentions: "accept", for_limited_accounts: "accept", summary: { pending_requests_count: 0, pending_notifications_count: 0 } }));
  g("/api/v2/notifications/:key", required, wrapA((req, res) => {
    const id = Number(String(req.params.key).replace(/^ungrouped-/, ""));
    const n = db.prepare("SELECT * FROM fedi_notifications WHERE id = ? AND account_id = ?").get(id, req.me!.id);
    if (!n) throw new FediError(404, "Record not found");
    const j = notificationJson(n, req.me!.id);
    res.json({ accounts: [j.account], statuses: j.status ? [j.status] : [], notification_groups: [{ group_key: `ungrouped-${j.id}`, notifications_count: 1, type: j.type, most_recent_notification_id: j.id, page_min_id: j.id, page_max_id: j.id, latest_page_notification_at: j.created_at, sample_account_ids: [j.account.id], status_id: j.status?.id ?? null }] });
  }));
  post("/api/v2/notifications/:key/dismiss", required, wrapA((req, res) => {
    db.prepare("DELETE FROM fedi_notifications WHERE id = ? AND account_id = ?").run(Number(String(req.params.key).replace(/^ungrouped-/, "")), req.me!.id);
    res.json({});
  }));
  g("/api/v1/notifications/unread_count", required, wrapA((req, res) => {
    const m = db.prepare("SELECT last_read_id FROM fedi_markers WHERE account_id = ? AND timeline = 'notifications'").get(req.me!.id) as any;
    res.json({ count: count("SELECT COUNT(*) c FROM fedi_notifications WHERE account_id = ? AND id > ?", req.me!.id, Number(m?.last_read_id || 0)) });
  }));
  g("/api/v1/notifications/policy", required, (_q: Request, res: Response) => res.json({ for_not_following: "accept", for_not_followers: "accept", for_new_accounts: "accept", for_private_mentions: "accept", for_limited_accounts: "accept", summary: { pending_requests_count: 0, pending_notifications_count: 0 } }));
  g("/api/v1/notifications/requests", required, (_q: Request, res: Response) => res.json([]));
  g("/api/v1/notifications/:id", required, wrapA((req, res) => {
    const n = db.prepare("SELECT * FROM fedi_notifications WHERE id = ? AND account_id = ?").get(Number(req.params.id), req.me!.id);
    if (!n) throw new FediError(404, "Record not found");
    res.json(notificationJson(n, req.me!.id));
  }));
  post("/api/v1/notifications/clear", required, wrapA((req, res) => {
    db.prepare("DELETE FROM fedi_notifications WHERE account_id = ?").run(req.me!.id);
    res.json({});
  }));
  post("/api/v1/notifications/:id/dismiss", required, wrapA((req, res) => {
    db.prepare("DELETE FROM fedi_notifications WHERE id = ? AND account_id = ?").run(Number(req.params.id), req.me!.id);
    res.json({});
  }));

  // ---------- markers ----------
  g("/api/v1/markers", required, wrapA((req, res) => {
    const out: any = {};
    for (const r of db.prepare("SELECT * FROM fedi_markers WHERE account_id = ?").all(req.me!.id) as any[]) out[r.timeline] = { last_read_id: r.last_read_id, version: r.version, updated_at: iso(r.updated) };
    res.json(out);
  }));
  post("/api/v1/markers", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    const out: any = {};
    for (const t of ["home", "notifications"]) {
      const id = body[t]?.last_read_id;
      if (!id) continue;
      db.prepare("INSERT INTO fedi_markers (account_id, timeline, last_read_id, version, updated) VALUES (?, ?, ?, 1, ?) ON CONFLICT(account_id, timeline) DO UPDATE SET last_read_id = excluded.last_read_id, version = version + 1, updated = excluded.updated").run(req.me!.id, t, String(id), now());
      const r = db.prepare("SELECT * FROM fedi_markers WHERE account_id = ? AND timeline = ?").get(req.me!.id, t) as any;
      out[t] = { last_read_id: r.last_read_id, version: r.version, updated_at: iso(r.updated) };
    }
    res.json(out);
  }));

  // ---------- search ----------
  g("/api/v2/search", optional, wrapA(async (req, res) => {
    const q = req.query as any;
    const text = String(q.q || "").trim();
    const type = String(q.type || "");
    const limit = Math.min(Number(q.limit) || 20, 40);
    const resolve = bool(q.resolve) && !!req.me;
    const out: any = { accounts: [], statuses: [], hashtags: [] };
    if (!text) return res.json(out);
    if (/^https?:\/\//.test(text) && resolve) {
      const r = await resolveObject(text).catch(() => null);
      if (r?.actor && (!type || type === "accounts")) out.accounts.push(accountJson(r.actor));
      if (r?.status && (!type || type === "statuses") && canSee(r.status, req.me?.id ?? null)) out.statuses.push(statusJson(r.status, req.me?.id ?? null));
      return res.json(out);
    }
    if (!type || type === "accounts") out.accounts = (await searchAccounts(text, resolve, limit, req.me?.id ?? null, bool(q.following))).map((a) => accountJson(a));
    if (!type || type === "hashtags") {
      const t = text.replace(/^#/, "").toLowerCase();
      if (/^[\p{L}\p{N}_]+$/u.test(t)) {
        const uses = count(`SELECT COUNT(*) c FROM fedi_statuses WHERE tags LIKE '%"' || ? || '"%'`, t);
        out.hashtags.push({ name: t, url: `${FEDI_URL}/tags/${encodeURIComponent(t)}`, history: [{ day: String(Math.floor(now() / 86400_000) * 86400), uses: String(uses), accounts: "0" }], following: false });
      }
    }
    if ((!type || type === "statuses") && req.me && !text.startsWith("@")) {
      const like = `%${text.replace(/[%_]/g, "")}%`;
      const rows = db.prepare(`SELECT * FROM fedi_statuses WHERE reblog_of IS NULL AND (content LIKE ? OR spoiler LIKE ?) AND (actor_id = ? OR id IN (SELECT status_id FROM fedi_home WHERE account_id = ?) OR id IN (SELECT status_id FROM fedi_likes WHERE actor_id = ?) OR id IN (SELECT status_id FROM fedi_bookmarks WHERE account_id = ?) OR visibility = 'public') ORDER BY id DESC LIMIT ?`).all(like, like, req.me.id, req.me.id, req.me.id, req.me.id, limit) as StatusRow[];
      out.statuses = rows.filter((s) => canSee(s, req.me!.id)).map((s) => statusJson(s, req.me!.id));
    }
    res.json(out);
  }));
  g("/api/v1/search", optional, wrapA(async (req, res) => {
    res.redirect(307, `${req.baseUrl || ""}/api/v2/search?${new URLSearchParams(req.query as any)}`);
  }));
  g("/api/v1/tags/:tag", optional, wrapA((req, res) => {
    const t = String(req.params.tag).toLowerCase();
    res.json({ name: t, url: `${FEDI_URL}/tags/${encodeURIComponent(t)}`, history: [], following: false });
  }));

  // ---------- push ----------
  g("/api/v1/push/subscription", required, wrapA((req, res) => {
    const p = db.prepare("SELECT * FROM fedi_push WHERE token_hash = ?").get(req.token!.token_hash) as PushRow | undefined;
    if (!p) throw new FediError(404, "Record not found");
    res.json(pushJson(p));
  }));
  post("/api/v1/push/subscription", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    const sub = body.subscription || {};
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new FediError(422, "subscription is incomplete");
    const t = String(req.headers.authorization || "").replace(/^Bearer\s+/, "") || String((req.query as any).access_token || "");
    const alerts: any = {};
    for (const k of ["mention", "status", "reblog", "follow", "follow_request", "favourite", "poll", "update"]) alerts[k] = bool(body.data?.alerts?.[k], false);
    db.prepare("INSERT INTO fedi_push (token_hash, account_id, access_token, endpoint, p256dh, auth, alerts, policy, standard, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, alerts = excluded.alerts, policy = excluded.policy, standard = excluded.standard").run(
      req.token!.token_hash,
      req.acc!.id,
      t,
      String(sub.endpoint),
      String(sub.keys.p256dh),
      String(sub.keys.auth),
      JSON.stringify(alerts),
      String(body.data?.policy || body.policy || "all"),
      bool(sub.standard) ? 1 : 0,
      now(),
    );
    res.json(pushJson(db.prepare("SELECT * FROM fedi_push WHERE token_hash = ?").get(req.token!.token_hash) as PushRow));
  }));
  put("/api/v1/push/subscription", required, wrapA(async (req, res) => {
    const { body } = await bodyOf(req);
    const p = db.prepare("SELECT * FROM fedi_push WHERE token_hash = ?").get(req.token!.token_hash) as PushRow | undefined;
    if (!p) throw new FediError(404, "Record not found");
    const alerts = json(p.alerts, {});
    for (const k of Object.keys(body.data?.alerts || {})) alerts[k] = bool(body.data.alerts[k]);
    db.prepare("UPDATE fedi_push SET alerts = ?, policy = ? WHERE token_hash = ?").run(JSON.stringify(alerts), String(body.data?.policy || body.policy || p.policy), p.token_hash);
    res.json(pushJson(db.prepare("SELECT * FROM fedi_push WHERE token_hash = ?").get(p.token_hash) as PushRow));
  }));
  del("/api/v1/push/subscription", required, wrapA((req, res) => {
    db.prepare("DELETE FROM fedi_push WHERE token_hash = ?").run(req.token!.token_hash);
    res.json({});
  }));

  // anything else under the Mastodon API: a JSON 404, never the web app
  app.all(/^\/api\/v[12]\//, (_q: Request, res: Response) => res.status(404).json({ error: "Record not found" }));
}

async function searchAccounts(q: string, resolve: boolean, limit: number, viewer: number | null, following: boolean): Promise<ActorRow[]> {
  const text = q.trim().replace(/^@/, "");
  const out: ActorRow[] = [];
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) || (resolve && /^[^@\s]+@[^@\s]+$/.test(text))) {
    const [u, d] = text.split("@");
    const known = db.prepare("SELECT * FROM fedi_actors WHERE username = ? COLLATE NOCASE AND (domain = ? COLLATE NOCASE OR (local IS NOT NULL AND ? = ?))").get(u, d, d.toLowerCase(), FEDI_DOMAIN) as ActorRow | undefined;
    const a = known || (resolve ? await webfinger(text).catch(() => null) : null);
    if (a) out.push(a);
  }
  const like = `%${text.split("@")[0].replace(/[%_]/g, "")}%`;
  const rows = db
    .prepare(
      `SELECT * FROM fedi_actors WHERE fetched > 0 AND (username LIKE ? OR display_name LIKE ?) ${following && viewer ? "AND id IN (SELECT followee_id FROM fedi_follows WHERE follower_id = ? AND state = 'accepted')" : ""} ORDER BY (local IS NOT NULL) DESC, (id IN (SELECT followee_id FROM fedi_follows WHERE follower_id = ?)) DESC, followers_count DESC LIMIT ?`,
    )
    .all(like, like, ...(following && viewer ? [viewer] : []), viewer ?? 0, limit) as ActorRow[];
  for (const r of rows) if (!out.some((x) => x.id === r.id)) out.push(r);
  return out.slice(0, limit);
}

export { escapeHtml };
