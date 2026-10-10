/**
 * ActivityPub: actors, posts, deliveries and the inbox.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../storage";
import {
  FEDI_URL,
  FEDI_DOMAIN,
  FEDI_PRIVATE,
  PUBLIC,
  AS_CONTEXT,
  MEDIA_DIR,
  bus,
  FediError,
  now,
  iso,
  json,
  idOf,
  arr,
  firstUrl,
  escapeHtml,
  newId,
  sanitize,
  htmlToText,
  mediaKind,
  fetchJson,
  fetchRemote,
  signHeaders,
  instanceKeys,
  actorById,
  actorByUri,
  statusById,
  statusByUri,
  accountById,
  accountByName,
  actorUri,
  profileUrl,
  type ActorRow,
  type AccountRow,
  type StatusRow,
  type MediaRow,
  UA,
  INSTANCE_ACTOR,
} from "./core";

const ACTOR_TYPES = new Set(["Person", "Service", "Application", "Group", "Organization"]);
const NOTE_TYPES = new Set(["Note", "Article", "Page", "Question", "Video", "Audio", "Image", "Event"]);
const isPublic = (x: string | null) => x === PUBLIC || x === "as:Public" || x === "Public";
const hostOf = (u: string) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
};

// ======================================================================
// Actors
// ======================================================================

function emojisOf(tags: any) {
  return arr(tags)
    .filter((t) => t && t.type === "Emoji" && t.name && (t.icon?.url || typeof t.icon === "string"))
    .map((t) => {
      const url = typeof t.icon === "string" ? t.icon : t.icon.url;
      return { shortcode: String(t.name).replace(/^:|:$/g, ""), url, static_url: url, visible_in_picker: false };
    });
}

export function upsertActor(o: any): ActorRow {
  const uri: string = o.id;
  const existing = actorByUri(uri);
  if (existing?.local) return existing;
  const fields = arr(o.attachment)
    .filter((a) => a && a.type === "PropertyValue" && a.name)
    .slice(0, 8)
    .map((a) => ({ name: String(a.name).slice(0, 255), value: sanitize(String(a.value || "")), verified_at: null }));
  const row = {
    uri,
    type: String(o.type || "Person"),
    username: String(o.preferredUsername || uri.split("/").pop() || "").slice(0, 100),
    domain: hostOf(uri),
    display_name: String(o.name || "").slice(0, 200),
    note: sanitize(String(o.summary || "")),
    url: firstUrl(o.url) || uri,
    avatar: firstUrl(o.icon),
    header: firstUrl(o.image),
    inbox: idOf(o.inbox),
    shared_inbox: idOf(o.endpoints?.sharedInbox) || null,
    outbox: idOf(o.outbox),
    followers_url: idOf(o.followers),
    following_url: idOf(o.following),
    featured_url: idOf(o.featured),
    key_id: o.publicKey?.id || null,
    public_key: o.publicKey?.publicKeyPem || null,
    locked: o.manuallyApprovesFollowers ? 1 : 0,
    bot: o.type === "Service" || o.type === "Application" ? 1 : 0,
    discoverable: o.discoverable === false ? 0 : 1,
    fields: JSON.stringify(fields),
    emojis: JSON.stringify(emojisOf(o.tag)),
    moved_to: idOf(o.movedTo),
    created_at: Date.parse(o.published) || existing?.created_at || now(),
    fetched: now(),
  };
  db.prepare(
    `INSERT INTO fedi_actors (uri, type, username, domain, display_name, note, url, avatar, header, inbox, shared_inbox, outbox, followers_url, following_url, featured_url, key_id, public_key, locked, bot, discoverable, fields, emojis, moved_to, created_at, fetched)
     VALUES (@uri, @type, @username, @domain, @display_name, @note, @url, @avatar, @header, @inbox, @shared_inbox, @outbox, @followers_url, @following_url, @featured_url, @key_id, @public_key, @locked, @bot, @discoverable, @fields, @emojis, @moved_to, @created_at, @fetched)
     ON CONFLICT(uri) DO UPDATE SET type=excluded.type, username=excluded.username, domain=excluded.domain, display_name=excluded.display_name, note=excluded.note, url=excluded.url, avatar=excluded.avatar, header=excluded.header,
       inbox=excluded.inbox, shared_inbox=excluded.shared_inbox, outbox=excluded.outbox, followers_url=excluded.followers_url, following_url=excluded.following_url, featured_url=excluded.featured_url,
       key_id=excluded.key_id, public_key=excluded.public_key, locked=excluded.locked, bot=excluded.bot, discoverable=excluded.discoverable, fields=excluded.fields, emojis=excluded.emojis, moved_to=excluded.moved_to,
       created_at=excluded.created_at, fetched=excluded.fetched`,
  ).run(row);
  const a = actorByUri(uri)!;
  if (!existing || now() - (existing.fetched || 0) > 1800_000) void refreshCounts(a);
  return a;
}

async function refreshCounts(a: ActorRow) {
  const total = async (u: string | null) => {
    if (!u) return null;
    try {
      const c = await fetchJson(u);
      return typeof c.totalItems === "number" ? c.totalItems : null;
    } catch {
      return null;
    }
  };
  const [f, g, s] = await Promise.all([total(a.followers_url), total(a.following_url), total(a.outbox)]);
  db.prepare("UPDATE fedi_actors SET followers_count = COALESCE(?, followers_count), following_count = COALESCE(?, following_count), statuses_count = COALESCE(?, statuses_count) WHERE id = ?").run(f, g, s, a.id);
}

/** A stand-in row for an actor we only know the address of (mentions); filled in when someone looks. */
export function stubActor(uri: string, acct?: string): ActorRow {
  const a = actorByUri(uri);
  if (a) return a;
  const m = (acct || "").replace(/^@/, "").split("@");
  db.prepare("INSERT OR IGNORE INTO fedi_actors (uri, username, domain, url, created_at, fetched) VALUES (?, ?, ?, ?, ?, 0)").run(uri, m[0] || uri.split("/").pop() || "", m[1] || hostOf(uri), uri, now());
  return actorByUri(uri)!;
}

const inflight = new Map<string, Promise<ActorRow | null>>();
export async function resolveActor(uri: string, opts: { refresh?: boolean; maxAge?: number } = {}): Promise<ActorRow | null> {
  uri = uri.split("#")[0];
  const a = actorByUri(uri);
  if (a?.local) return a;
  if (a && a.fetched && !opts.refresh && now() - a.fetched < (opts.maxAge ?? 2 * 86400_000)) return a;
  if (inflight.has(uri)) return inflight.get(uri)!;
  const p = (async () => {
    try {
      const o = await fetchJson(uri);
      if (!o || !ACTOR_TYPES.has(o.type) || typeof o.id !== "string" || hostOf(o.id) !== hostOf(uri)) return a || null;
      return upsertActor(o);
    } catch (e) {
      if (process.env.SCUTE_FEDI_DEBUG) console.warn("[fedi] resolveActor", uri, (e as Error)?.message, (e as any)?.cause?.code);
      if (a && (e as FediError).status === 410) db.prepare("UPDATE fedi_actors SET fetched = ? WHERE id = ?").run(now(), a.id);
      return a || null;
    } finally {
      inflight.delete(uri);
    }
  })();
  inflight.set(uri, p);
  return p;
}

/** The actor that owns an HTTP-signature key. */
export async function actorForKey(keyId: string, refresh = false): Promise<ActorRow | null> {
  if (!refresh) {
    const a = db.prepare("SELECT * FROM fedi_actors WHERE key_id = ?").get(keyId) as ActorRow | undefined;
    if (a?.public_key) return a;
  }
  const base = keyId.split("#")[0];
  let a = await resolveActor(base, { refresh: true });
  if (a?.key_id === keyId && a.public_key) return a;
  // keys published as their own documents (some servers)
  try {
    const k = await fetchJson(keyId);
    const owner = idOf(k.owner) || idOf(k.controller);
    if (owner) {
      a = await resolveActor(owner, { refresh: true });
      if (a?.key_id === keyId || a?.public_key) return a;
    }
  } catch {
    /* ignore */
  }
  return a?.public_key ? a : null;
}

export async function webfinger(acct: string): Promise<ActorRow | null> {
  acct = acct.trim().replace(/^acct:/, "").replace(/^@/, "");
  const [user, domain] = acct.split("@");
  if (!user) return null;
  if (!domain || domain.toLowerCase() === FEDI_DOMAIN) {
    const acc = accountByName(user);
    return acc ? actorById(acc.id)! : null;
  }
  const known = db.prepare("SELECT * FROM fedi_actors WHERE username = ? COLLATE NOCASE AND domain = ? COLLATE NOCASE AND fetched > ? AND local IS NULL").get(user, domain, now() - 2 * 86400_000) as ActorRow | undefined;
  if (known) return known;
  const schemes = FEDI_PRIVATE ? ["https", "http"] : ["https"];
  for (const s of schemes) {
    try {
      const r = await fetchRemote(`${s}://${domain}/.well-known/webfinger?resource=acct:${encodeURIComponent(user)}@${encodeURIComponent(domain)}`, {
        accept: "application/jrd+json, application/json",
        signed: false,
      });
      if (r.status !== 200) continue;
      const j = JSON.parse(r.body.toString("utf8"));
      const self = arr(j.links).find((l) => l.rel === "self" && /activity\+json|ld\+json/.test(l.type || ""));
      if (!self?.href) return null;
      const a = await resolveActor(self.href, { refresh: true });
      if (a) {
        // handles can live on another domain than the server (like ours)
        db.prepare("UPDATE fedi_actors SET domain = ? WHERE id = ? AND local IS NULL").run(domain.toLowerCase(), a.id);
        return actorById(a.id)!;
      }
      return null;
    } catch {
      /* next scheme */
    }
  }
  return null;
}

/** Fetch anything by address: an actor or a post. */
export async function resolveObject(url: string): Promise<{ actor?: ActorRow; status?: StatusRow } | null> {
  const local = localStatusFromUrl(url);
  if (local) return { status: local };
  const la = actorByUri(url) || (db.prepare("SELECT * FROM fedi_actors WHERE url = ?").get(url) as ActorRow | undefined);
  if (la?.local) return { actor: la };
  const st = statusByUri(url) || (db.prepare("SELECT * FROM fedi_statuses WHERE url = ?").get(url) as StatusRow | undefined);
  if (st) return { status: st };
  const o = await fetchJson(url);
  if (ACTOR_TYPES.has(o.type)) return { actor: upsertActor(o) };
  if (NOTE_TYPES.has(o.type)) {
    const s = await storeNote(o, { trusted: hostOf(o.id) === hostOf(url) });
    return s ? { status: s } : null;
  }
  return null;
}

function localStatusFromUrl(url: string) {
  if (!url.startsWith(FEDI_URL + "/")) return null;
  const m = url.slice(FEDI_URL.length).match(/^\/(?:users\/[^/]+\/statuses|@[^/]+)\/(\d+)/);
  return m ? statusById(Number(m[1])) || null : null;
}

// ======================================================================
// Local accounts
// ======================================================================

export function localActorJson(acc: AccountRow) {
  const a = actorById(acc.id)!;
  const fields = json(a.fields, []) as { name: string; value: string }[];
  const uri = a.uri;
  return {
    "@context": AS_CONTEXT,
    id: uri,
    type: a.bot ? "Service" : "Person",
    following: `${uri}/following`,
    followers: `${uri}/followers`,
    inbox: `${uri}/inbox`,
    outbox: `${uri}/outbox`,
    featured: `${uri}/collections/featured`,
    preferredUsername: acc.username,
    name: a.display_name || "",
    summary: a.note || "",
    url: profileUrl(acc.username),
    manuallyApprovesFollowers: !!a.locked,
    discoverable: !!a.discoverable,
    indexable: !!a.discoverable,
    published: iso(a.created_at),
    endpoints: { sharedInbox: `${FEDI_URL}/inbox` },
    publicKey: { id: `${uri}#main-key`, owner: uri, publicKeyPem: a.public_key },
    attachment: fields.map((f) => ({ type: "PropertyValue", name: f.name, value: f.value })),
    tag: [],
    ...(a.avatar ? { icon: { type: "Image", mediaType: mimeFromUrl(a.avatar), url: a.avatar } } : {}),
    ...(a.header ? { image: { type: "Image", mediaType: mimeFromUrl(a.header), url: a.header } } : {}),
  };
}
const mimeFromUrl = (u: string) => (/\.png($|\?)/i.test(u) ? "image/png" : /\.gif($|\?)/i.test(u) ? "image/gif" : /\.webp($|\?)/i.test(u) ? "image/webp" : "image/jpeg");

export function instanceActorJson(id = INSTANCE_ACTOR) {
  const k = instanceKeys();
  return {
    "@context": AS_CONTEXT,
    id,
    type: "Application",
    preferredUsername: FEDI_DOMAIN,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    url: `${FEDI_URL}/about`,
    manuallyApprovesFollowers: true,
    endpoints: { sharedInbox: `${FEDI_URL}/inbox` },
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: k.pub },
  };
}

/** Send an Update of a local profile to everyone following it. */
export function sendProfileUpdate(acc: AccountRow) {
  const a = actorById(acc.id)!;
  const body = { "@context": AS_CONTEXT, id: `${a.uri}#updates/${now()}`, type: "Update", actor: a.uri, to: [PUBLIC], object: localActorJson(acc) };
  deliver(acc, body, followersOf(a.id));
}

// ======================================================================
// Posts
// ======================================================================

export function mediaOf(statusId: number) {
  return db.prepare("SELECT * FROM fedi_media WHERE status_id = ? ORDER BY pos, id").all(statusId) as MediaRow[];
}

export function mediaUrl(m: MediaRow) {
  if (!m.file) return m.remote_url || "";
  return `${FEDI_URL}/fedi/media/${m.id}/${encodeURIComponent(path.basename(m.file))}`;
}
export function thumbUrl(m: MediaRow) {
  if (m.thumb) return `${FEDI_URL}/fedi/media/${m.id}/${encodeURIComponent(path.basename(m.thumb))}`;
  return m.type === "image" ? mediaUrl(m) : null;
}

function visibilityOf(o: any, actor: ActorRow): StatusRow["visibility"] {
  const to = arr(o.to).map(idOf);
  const cc = arr(o.cc).map(idOf);
  if (to.some(isPublic)) return "public";
  if (cc.some(isPublic)) return "unlisted";
  const all = [...to, ...cc];
  if ((actor.followers_url && all.includes(actor.followers_url)) || all.some((x) => x && /\/followers$/.test(x))) return "private";
  return "direct";
}

interface Mention {
  id: number;
  uri: string;
  acct: string;
}

/** Store a post from another server. `trusted`: we fetched it from its own address. */
export async function storeNote(o: any, opts: { actor?: ActorRow; trusted?: boolean; depth?: number } = {}): Promise<StatusRow | null> {
  if (!o || typeof o.id !== "string" || !NOTE_TYPES.has(o.type)) return null;
  const existing = statusByUri(o.id);
  if (existing) return existing;
  const author = idOf(arr(o.attributedTo)[0]) || idOf(o.actor);
  if (!author) return null;
  if (hostOf(author) !== hostOf(o.id)) return null;
  const actor = opts.actor && opts.actor.uri === author ? opts.actor : await resolveActor(author);
  if (!actor) return null;

  const mentions: Mention[] = [];
  const tags: string[] = [];
  for (const t of arr(o.tag)) {
    if (!t) continue;
    if (t.type === "Mention" && typeof t.href === "string") {
      const local = localActorFromUri(t.href);
      const m = local || stubActor(t.href, t.name);
      if (!mentions.some((x) => x.id === m.id)) mentions.push({ id: m.id, uri: m.uri, acct: String(t.name || "").replace(/^@/, "") });
    } else if (t.type === "Hashtag" && t.name) {
      const n = String(t.name).replace(/^#/, "").toLowerCase().slice(0, 100);
      if (n && !tags.includes(n)) tags.push(n);
    }
  }
  // addressed to a local account without a Mention tag (some servers' DMs)
  for (const r of [...arr(o.to), ...arr(o.cc)].map(idOf)) {
    const local = r && localActorFromUri(r);
    if (local && !mentions.some((x) => x.id === local.id)) mentions.push({ id: local.id, uri: local.uri, acct: local.username });
  }

  let content = sanitize(String(o.content || (o.contentMap && Object.values(o.contentMap)[0]) || ""));
  if ((o.type === "Article" || o.type === "Page" || o.type === "Event") && o.name) {
    const link = firstUrl(o.url) || o.id;
    content = `<p><strong>${escapeHtml(String(o.name))}</strong></p>${o.summary ? `<p>${escapeHtml(htmlToText(String(o.summary)))}</p>` : content.length > 2000 ? `<p>${escapeHtml(htmlToText(content).slice(0, 500))}…</p>` : content}<p><a href="${escapeHtml(link)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(link)}</a></p>`;
  }
  const spoiler = o.type === "Article" || o.type === "Page" ? "" : String(o.summary || "").slice(0, 500);
  let poll: any = null;
  if (o.type === "Question") {
    const multiple = !!o.anyOf;
    const opts2 = arr(o.oneOf || o.anyOf).map((x) => ({ title: String(x?.name || ""), votes_count: Number(x?.replies?.totalItems || 0) }));
    poll = { multiple, options: opts2, expires_at: o.endTime || o.closed || null, voters_count: o.votersCount ?? null };
  }
  const inReplyToUri = idOf(o.inReplyTo);
  const parent = inReplyToUri ? statusByUri(inReplyToUri) || localStatusFromUrl(inReplyToUri) : null;
  const published = Date.parse(o.published) || now();
  const id = newId(Math.min(published, now()));
  const row = {
    id,
    uri: o.id,
    url: firstUrl(o.url) || o.id,
    actor_id: actor.id,
    in_reply_to_uri: inReplyToUri,
    in_reply_to_id: parent?.id ?? null,
    in_reply_to_actor_id: parent?.actor_id ?? null,
    content,
    spoiler,
    visibility: visibilityOf(o, actor),
    sensitive: o.sensitive || spoiler ? 1 : 0,
    language: (o.contentMap && Object.keys(o.contentMap)[0]) || null,
    mentions: JSON.stringify(mentions),
    tags: JSON.stringify(tags),
    emojis: JSON.stringify(emojisOf(o.tag)),
    poll: poll ? JSON.stringify(poll) : null,
    created_at: published,
    edited_at: o.updated && Date.parse(o.updated) > published + 1000 ? Date.parse(o.updated) : null,
  };
  try {
    db.prepare(
      `INSERT INTO fedi_statuses (id, uri, url, actor_id, local, in_reply_to_uri, in_reply_to_id, in_reply_to_actor_id, content, spoiler, visibility, sensitive, language, mentions, tags, emojis, poll, created_at, edited_at)
       VALUES (@id, @uri, @url, @actor_id, 0, @in_reply_to_uri, @in_reply_to_id, @in_reply_to_actor_id, @content, @spoiler, @visibility, @sensitive, @language, @mentions, @tags, @emojis, @poll, @created_at, @edited_at)`,
    ).run(row);
  } catch {
    return statusByUri(o.id) || null;
  }
  saveRemoteMedia(id, o.attachment);
  // replies that arrived before their parent
  db.prepare("UPDATE fedi_statuses SET in_reply_to_id = ?, in_reply_to_actor_id = ? WHERE in_reply_to_uri = ? AND in_reply_to_id IS NULL").run(id, actor.id, o.id);
  if (inReplyToUri && !parent && (opts.depth ?? 0) < 4) {
    const d = (opts.depth ?? 0) + 1;
    void fetchJson(inReplyToUri)
      .then((p) => storeNote(p, { trusted: true, depth: d }))
      .catch(() => null);
  }
  db.prepare("UPDATE fedi_actors SET statuses_count = statuses_count + 1 WHERE id = ? AND fetched > 0").run(actor.id);
  return statusById(id)!;
}

function saveRemoteMedia(statusId: number, attachments: any) {
  db.prepare("DELETE FROM fedi_media WHERE status_id = ? AND file IS NULL").run(statusId);
  let pos = 0;
  for (const a of arr(attachments).slice(0, 16)) {
    if (!a) continue;
    const url = typeof a.url === "string" ? a.url : firstUrl(arr(a.url).find((x: any) => !x?.mediaType || !/html/.test(x.mediaType)) || a.url) || a.href;
    if (!url || typeof url !== "string") continue;
    let mime = String(a.mediaType || (arr(a.url).find((x: any) => x?.mediaType)?.mediaType ?? ""));
    if (!mime) mime = a.type === "Image" ? "image/jpeg" : a.type === "Video" ? "video/mp4" : a.type === "Audio" ? "audio/mpeg" : "application/octet-stream";
    const type = mediaKind(mime);
    const meta: any = {};
    if (a.width && a.height) meta.original = { width: a.width, height: a.height, size: `${a.width}x${a.height}`, aspect: a.width / a.height };
    if (Array.isArray(a.focalPoint)) meta.focus = { x: a.focalPoint[0], y: a.focalPoint[1] };
    db.prepare("INSERT INTO fedi_media (id, status_id, pos, remote_url, type, mime, name, description, blurhash, meta, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      newId(now(), "fedi_media"),
      statusId,
      pos++,
      url,
      type,
      mime,
      url.split("/").pop()?.split("?")[0] || null,
      a.name ? String(a.name).slice(0, 1500) : null,
      a.blurhash || null,
      JSON.stringify(meta),
      now(),
    );
  }
}

function updateRemoteNote(st: StatusRow, o: any) {
  const prev = { content: st.content, spoiler_text: st.spoiler, sensitive: !!st.sensitive, created_at: iso(st.edited_at || st.created_at), media: mediaOf(st.id).map((m) => m.id), poll: st.poll };
  const history = json(st.history, []) as any[];
  const content = sanitize(String(o.content || ""));
  let poll = st.poll;
  if (o.type === "Question") {
    const p = json(st.poll, {});
    p.options = arr(o.oneOf || o.anyOf).map((x) => ({ title: String(x?.name || ""), votes_count: Number(x?.replies?.totalItems || 0) }));
    p.voters_count = o.votersCount ?? p.voters_count;
    p.expires_at = o.endTime || o.closed || p.expires_at;
    poll = JSON.stringify(p);
  }
  const changed = content !== st.content || String(o.summary || "") !== st.spoiler;
  if (changed) history.push(prev);
  db.prepare("UPDATE fedi_statuses SET content = ?, spoiler = ?, sensitive = ?, poll = ?, history = ?, edited_at = ? WHERE id = ?").run(
    content,
    String(o.summary || "").slice(0, 500),
    o.sensitive ? 1 : 0,
    poll,
    JSON.stringify(history.slice(-20)),
    changed ? Date.parse(o.updated) || now() : st.edited_at,
    st.id,
  );
  if (changed) saveRemoteMedia(st.id, o.attachment);
  bus.emit("status.update", st.id);
}

export function removeStatus(st: StatusRow) {
  const media = db.prepare("SELECT * FROM fedi_media WHERE status_id = ?").all(st.id) as MediaRow[];
  for (const m of media) removeMediaFiles(m);
  const reblogs = db.prepare("SELECT id FROM fedi_statuses WHERE reblog_of = ?").all(st.id) as { id: number }[];
  const tx = db.transaction(() => {
    for (const id of [st.id, ...reblogs.map((r) => r.id)]) {
      db.prepare("DELETE FROM fedi_home WHERE status_id = ?").run(id);
      db.prepare("DELETE FROM fedi_notifications WHERE status_id = ?").run(id);
      db.prepare("DELETE FROM fedi_likes WHERE status_id = ?").run(id);
      db.prepare("DELETE FROM fedi_bookmarks WHERE status_id = ?").run(id);
      db.prepare("DELETE FROM fedi_media WHERE status_id = ?").run(id);
      db.prepare("DELETE FROM fedi_statuses WHERE id = ?").run(id);
    }
    db.prepare("UPDATE fedi_statuses SET in_reply_to_id = NULL WHERE in_reply_to_id = ?").run(st.id);
  });
  tx();
  for (const id of [st.id, ...reblogs.map((r) => r.id)]) bus.emit("delete", id);
}

export function removeMediaFiles(m: MediaRow) {
  if (!m.file) return;
  fs.rmSync(path.join(MEDIA_DIR, String(m.id)), { recursive: true, force: true });
}

function localActorFromUri(uri: string): ActorRow | null {
  const a = actorByUri(uri);
  if (a?.local) return a;
  if (uri.startsWith(FEDI_URL + "/@")) {
    const acc = accountByName(uri.slice(FEDI_URL.length + 2).split("/")[0]);
    return acc ? actorById(acc.id)! : null;
  }
  return null;
}

// ---------- local posts as ActivityPub ----------

export function noteJson(st: StatusRow) {
  const actor = actorById(st.actor_id)!;
  const mentions = json(st.mentions, []) as Mention[];
  const tags = json(st.tags, []) as string[];
  const to: string[] = [];
  const cc: string[] = [];
  const mUris = mentions.map((m) => actorById(m.id)?.uri || m.uri);
  const followers = `${actor.uri}/followers`;
  if (st.visibility === "public") to.push(PUBLIC), cc.push(followers, ...mUris);
  else if (st.visibility === "unlisted") to.push(followers), cc.push(PUBLIC, ...mUris);
  else if (st.visibility === "private") to.push(followers, ...mUris);
  else to.push(...mUris);
  const parent = st.in_reply_to_id ? statusById(st.in_reply_to_id) : null;
  const media = mediaOf(st.id);
  const poll = json(st.poll, null);
  const o: any = {
    id: st.uri,
    type: poll ? "Question" : "Note",
    summary: st.spoiler || null,
    inReplyTo: parent?.uri || st.in_reply_to_uri || null,
    published: iso(st.created_at),
    ...(st.edited_at ? { updated: iso(st.edited_at) } : {}),
    url: st.url,
    attributedTo: actor.uri,
    to,
    cc,
    sensitive: !!st.sensitive,
    content: st.content,
    ...(st.language ? { contentMap: { [st.language]: st.content } } : {}),
    attachment: media.map((m) => {
      const meta = json(m.meta, {});
      return {
        type: "Document",
        mediaType: m.mime,
        url: mediaUrl(m),
        name: m.description || null,
        ...(m.blurhash ? { blurhash: m.blurhash } : {}),
        ...(meta.original?.width ? { width: meta.original.width, height: meta.original.height } : {}),
        ...(meta.focus ? { focalPoint: [meta.focus.x, meta.focus.y] } : {}),
      };
    }),
    tag: [
      ...mentions.map((m) => {
        const a = actorById(m.id);
        return { type: "Mention", href: a?.uri || m.uri, name: "@" + (a ? (a.local ? `${a.username}@${FEDI_DOMAIN}` : `${a.username}@${a.domain}`) : m.acct) };
      }),
      ...tags.map((t) => ({ type: "Hashtag", href: `${FEDI_URL}/tags/${encodeURIComponent(t)}`, name: `#${t}` })),
    ],
    replies: `${st.uri}/replies`,
  };
  if (poll) {
    o[poll.multiple ? "anyOf" : "oneOf"] = poll.options.map((x: any) => ({ type: "Note", name: x.title, replies: { type: "Collection", totalItems: x.votes_count } }));
    if (poll.expires_at) o.endTime = poll.expires_at;
    if (poll.expires_at && Date.parse(poll.expires_at) < now()) o.closed = poll.expires_at;
    o.votersCount = poll.voters_count || 0;
  }
  return o;
}

export function createActivity(st: StatusRow) {
  const o = noteJson(st);
  return { "@context": AS_CONTEXT, id: `${st.uri}/activity`, type: "Create", actor: o.attributedTo, published: o.published, to: o.to, cc: o.cc, object: o };
}

export function announceActivity(rb: StatusRow) {
  const actor = actorById(rb.actor_id)!;
  const orig = statusById(rb.reblog_of!)!;
  const origActor = actorById(orig.actor_id)!;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: rb.uri,
    type: "Announce",
    actor: actor.uri,
    published: iso(rb.created_at),
    to: [PUBLIC],
    cc: [origActor.uri, `${actor.uri}/followers`],
    object: orig.uri,
  };
}

// ======================================================================
// Follows, recipients and delivery
// ======================================================================

export function followersOf(actorId: number) {
  return db.prepare("SELECT a.* FROM fedi_follows f JOIN fedi_actors a ON a.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'accepted'").all(actorId) as ActorRow[];
}
export function localFollowersOf(actorId: number) {
  return db.prepare("SELECT a.* FROM fedi_follows f JOIN fedi_actors a ON a.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'accepted' AND a.local IS NOT NULL").all(actorId) as ActorRow[];
}
export const follows = (follower: number, followee: number) =>
  !!db.prepare("SELECT 1 FROM fedi_follows WHERE follower_id = ? AND followee_id = ? AND state = 'accepted'").get(follower, followee);

export function recipientsOf(st: StatusRow): ActorRow[] {
  const out = new Map<number, ActorRow>();
  if (st.visibility !== "direct") for (const a of followersOf(st.actor_id)) out.set(a.id, a);
  for (const m of json(st.mentions, []) as Mention[]) {
    const a = actorById(m.id);
    if (a) out.set(a.id, a);
  }
  if (st.in_reply_to_actor_id && st.visibility !== "direct") {
    const a = actorById(st.in_reply_to_actor_id);
    if (a) out.set(a.id, a);
  }
  // everyone who boosted or liked a public post hears about edits and deletes
  out.delete(st.actor_id);
  return [...out.values()];
}

/** Queue an activity for remote inboxes; handle it at once for local accounts. */
export function deliver(acc: AccountRow, activity: any, to: ActorRow[]) {
  const body = JSON.stringify(activity);
  const inboxes = new Set<string>();
  let local = false;
  for (const a of to) {
    if (a.local) {
      if (a.id !== acc.id) local = true;
      continue;
    }
    const ib = a.shared_inbox || a.inbox;
    if (ib) inboxes.add(ib);
  }
  const ins = db.prepare("INSERT INTO fedi_deliveries (account_id, inbox, body, next_at, created) VALUES (?, ?, ?, ?, ?)");
  for (const ib of inboxes) ins.run(acc.id, ib, body, now(), now());
  if (local) {
    const signer = actorById(acc.id)!;
    setImmediate(() => handleActivity(JSON.parse(body), signer).catch((e) => console.error("[fedi] local delivery", e)));
  }
  if (inboxes.size) kickDeliveries();
}

const BACKOFF = [60, 300, 1800, 7200, 21600, 43200, 86400, 86400, 172800].map((s) => s * 1000);
let running = 0;
let kickTimer: NodeJS.Timeout | null = null;
export function kickDeliveries() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    runDeliveries().catch((e) => console.error("[fedi] deliveries", e));
  }, 50);
}
async function runDeliveries() {
  if (running >= 8) return;
  const due = db.prepare("SELECT * FROM fedi_deliveries WHERE next_at <= ? ORDER BY next_at LIMIT ?").all(now(), 8 - running) as any[];
  if (!due.length) return;
  for (const d of due) db.prepare("UPDATE fedi_deliveries SET next_at = ? WHERE id = ?").run(now() + 120_000, d.id); // claimed
  await Promise.all(
    due.map(async (d) => {
      running++;
      try {
        await sendOne(d);
      } catch (e) {
        console.error("[fedi] delivery", d.id, e);
      } finally {
        running--;
      }
    }),
  );
  kickDeliveries();
}
async function sendOne(d: { id: number; account_id: number; inbox: string; body: string; attempts: number }) {
  const acc = accountById(d.account_id);
  if (!acc) return db.prepare("DELETE FROM fedi_deliveries WHERE id = ?").run(d.id);
  let status = 0;
  let err = "";
  try {
    const u = new URL(d.inbox);
    const { checkRemote } = await import("./core");
    await checkRemote(u);
    const headers = signHeaders("POST", d.inbox, d.body, actorById(acc.id)?.key_id || `${actorUri(acc.username)}#main-key`, acc.private_key);
    delete (headers as any).host;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    try {
      const r = await fetch(d.inbox, { method: "POST", headers: { ...headers, "user-agent": UA }, body: d.body, signal: ctl.signal, redirect: "manual" });
      status = r.status;
      err = status >= 300 ? (await r.text().catch(() => "")).slice(0, 200) : "";
    } finally {
      clearTimeout(t);
    }
  } catch (e: any) {
    err = String(e?.message || e).slice(0, 200);
  }
  if (status >= 200 && status < 300) return db.prepare("DELETE FROM fedi_deliveries WHERE id = ?").run(d.id);
  const permanent = status >= 400 && status < 500 && ![401, 408, 429].includes(status);
  if (permanent || d.attempts + 1 >= BACKOFF.length) {
    console.warn(`[fedi] gave up delivering to ${d.inbox}: ${status || ""} ${err}`);
    return db.prepare("DELETE FROM fedi_deliveries WHERE id = ?").run(d.id);
  }
  db.prepare("UPDATE fedi_deliveries SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?").run(now() + BACKOFF[d.attempts], `${status} ${err}`.trim(), d.id);
}
export function startDeliveryLoop() {
  setInterval(() => runDeliveries().catch((e) => console.error("[fedi] deliveries", e)), 15_000).unref();
  kickDeliveries();
}

// ======================================================================
// Home timelines and notifications
// ======================================================================

export function blocked(accountId: number, actor: ActorRow, kinds = ["block", "mute"]) {
  if (db.prepare(`SELECT 1 FROM fedi_blocks WHERE account_id = ? AND target_id = ? AND kind IN (${kinds.map(() => "?").join(",")})`).get(accountId, actor.id, ...kinds)) return true;
  return !!db.prepare("SELECT 1 FROM fedi_domain_blocks WHERE account_id = ? AND domain = ?").get(accountId, actor.domain);
}

export function addHome(accountId: number, statusId: number) {
  const r = db.prepare("INSERT OR IGNORE INTO fedi_home (account_id, status_id) VALUES (?, ?)").run(accountId, statusId);
  if (r.changes) bus.emit("home", { accountId, statusId });
}

export function notify(accountId: number, type: string, fromId: number, statusId: number | null) {
  if (accountId === fromId) return;
  const from = actorById(fromId);
  if (!from || blocked(accountId, from)) return;
  const dup = db.prepare("SELECT id FROM fedi_notifications WHERE account_id = ? AND type = ? AND from_id = ? AND status_id IS ?").get(accountId, type, fromId, statusId);
  if (dup) return;
  const id = newId(now(), "fedi_notifications");
  db.prepare("INSERT INTO fedi_notifications (id, account_id, type, from_id, status_id, created) VALUES (?, ?, ?, ?, ?, ?)").run(id, accountId, type, fromId, statusId, now());
  bus.emit("notification", { accountId, id });
}

/** Put a new post in the home timelines it belongs in and notify mentioned people. */
export function fanout(st: StatusRow) {
  const author = actorById(st.actor_id)!;
  const mentions = (json(st.mentions, []) as Mention[]).map((m) => m.id);
  const target = st.reblog_of ? statusById(st.reblog_of) : null;
  if (author.local) addHome(author.id, st.id);
  for (const f of localFollowersOf(author.id)) {
    if (blocked(f.id, author)) continue;
    if (st.visibility === "direct" && !mentions.includes(f.id)) continue;
    if (target) {
      const fl = db.prepare("SELECT reblogs FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(f.id, author.id) as { reblogs: number } | undefined;
      if (!fl?.reblogs || target.actor_id === f.id) continue;
      const tAuthor = actorById(target.actor_id);
      if (tAuthor && blocked(f.id, tAuthor)) continue;
    }
    if (!target && st.in_reply_to_actor_id && st.in_reply_to_actor_id !== author.id && st.in_reply_to_actor_id !== f.id && !follows(f.id, st.in_reply_to_actor_id)) continue;
    addHome(f.id, st.id);
    const fl = db.prepare("SELECT notify FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(f.id, author.id) as { notify: number } | undefined;
    if (fl?.notify && !target) notify(f.id, "status", author.id, st.id);
  }
  if (!target)
    for (const mid of mentions) {
      const a = actorById(mid);
      if (!a?.local || a.id === author.id) continue;
      if (st.visibility === "direct") addHome(a.id, st.id);
      notify(a.id, "mention", author.id, st.id);
    }
  if (!target && (st.visibility === "public")) bus.emit("public", st.id);
}

// ======================================================================
// The inbox
// ======================================================================

/** Handle one incoming activity, already verified as sent by `signer`. */
export async function handleActivity(act: any, signer: ActorRow): Promise<void> {
  if (!act || typeof act !== "object") return;
  const actorId = idOf(act.actor);
  if (actorId !== signer.uri) {
    // forwarded activities (e.g. replies forwarded by a thread's author): only trust them by fetching
    if (act.id && hostOf(act.id) === hostOf(actorId || "") && (act.type === "Create" || act.type === "Update")) {
      const obj = idOf(act.object);
      if (obj) {
        try {
          const o = await fetchJson(obj);
          const sender = await resolveActor(actorId!);
          if (sender) await handleActivity({ ...act, object: o }, sender);
        } catch {
          /* ignore */
        }
      }
    }
    return;
  }
  const type = act.type;
  const obj = act.object;
  switch (type) {
    case "Follow":
      return onFollow(act, signer);
    case "Accept":
      return onAccept(obj, signer);
    case "Reject":
      return onReject(obj, signer);
    case "Undo":
      return onUndo(obj, signer);
    case "Create":
      return onCreate(obj, signer, act);
    case "Update":
      return onUpdate(obj, signer);
    case "Delete":
      return onDelete(obj, signer);
    case "Announce":
      return onAnnounce(act, signer);
    case "Like":
    case "EmojiReact":
      return onLike(act, signer);
    case "Block":
      return onBlock(obj, signer);
    case "Move":
      return onMove(act, signer);
    default:
      return;
  }
}

async function onFollow(act: any, signer: ActorRow) {
  const target = localActorFromUri(idOf(act.object) || "");
  if (!target) return;
  const acc = accountById(target.local!)!;
  if (blocked(acc.id, signer, ["block"])) {
    deliver(acc, { "@context": AS_CONTEXT, id: `${target.uri}#rejects/${crypto.randomUUID()}`, type: "Reject", actor: target.uri, object: { id: act.id, type: "Follow", actor: signer.uri, object: target.uri } }, [signer]);
    return;
  }
  const existing = db.prepare("SELECT state FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(signer.id, target.id) as { state: string } | undefined;
  const state = existing?.state === "accepted" || !target.locked ? "accepted" : "pending";
  db.prepare(
    "INSERT INTO fedi_follows (follower_id, followee_id, state, uri, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(follower_id, followee_id) DO UPDATE SET state = excluded.state, uri = excluded.uri",
  ).run(signer.id, target.id, state, act.id || null, now());
  if (state === "accepted") {
    sendAccept(acc, signer, act.id);
    if (existing?.state !== "accepted") notify(acc.id, "follow", signer.id, null);
  } else notify(acc.id, "follow_request", signer.id, null);
}

export function sendAccept(acc: AccountRow, follower: ActorRow, followUri: string | null) {
  const me = actorById(acc.id)!;
  deliver(
    acc,
    { "@context": AS_CONTEXT, id: `${me.uri}#accepts/follows/${crypto.randomUUID()}`, type: "Accept", actor: me.uri, object: { id: followUri || `${follower.uri}#follows/${me.id}`, type: "Follow", actor: follower.uri, object: me.uri } },
    [follower],
  );
}
export function sendReject(acc: AccountRow, follower: ActorRow, followUri: string | null) {
  const me = actorById(acc.id)!;
  deliver(
    acc,
    { "@context": AS_CONTEXT, id: `${me.uri}#rejects/follows/${crypto.randomUUID()}`, type: "Reject", actor: me.uri, object: { id: followUri || `${follower.uri}#follows/${me.id}`, type: "Follow", actor: follower.uri, object: me.uri } },
    [follower],
  );
}

function followFromObj(obj: any, signer: ActorRow) {
  // Accept/Reject { object: Follow } where we are the follower and signer the followee
  const fid = idOf(obj);
  let row = fid ? (db.prepare("SELECT * FROM fedi_follows WHERE uri = ? AND followee_id = ?").get(fid, signer.id) as any) : null;
  if (!row && obj && typeof obj === "object") {
    const follower = localActorFromUri(idOf(obj.actor) || "");
    if (follower) row = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(follower.id, signer.id);
  }
  if (!row) {
    // Some servers send Accept with only an id we don't recognise: accept our one pending follow
    const rows = db.prepare("SELECT f.* FROM fedi_follows f JOIN fedi_actors a ON a.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'pending' AND a.local IS NOT NULL").all(signer.id) as any[];
    if (rows.length === 1) row = rows[0];
  }
  return row as { follower_id: number; followee_id: number; state: string } | null;
}

async function onAccept(obj: any, signer: ActorRow) {
  const row = followFromObj(obj, signer);
  if (!row) return;
  db.prepare("UPDATE fedi_follows SET state = 'accepted' WHERE follower_id = ? AND followee_id = ?").run(row.follower_id, row.followee_id);
  void backfill(signer, row.follower_id);
}
async function onReject(obj: any, signer: ActorRow) {
  const row = followFromObj(obj, signer);
  if (row) db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(row.follower_id, row.followee_id);
}

/** After a follow is accepted: their latest public posts into the follower's home. */
export async function backfill(actor: ActorRow, localId: number, limit = 20) {
  const local = actorById(localId);
  if (!local?.local) return;
  try {
    if (actor.local) {
      const rows = db.prepare("SELECT id FROM fedi_statuses WHERE actor_id = ? AND visibility IN ('public','unlisted','private') AND in_reply_to_id IS NULL ORDER BY id DESC LIMIT ?").all(actor.id, limit) as { id: number }[];
      for (const r of rows) addHome(localId, r.id);
      return;
    }
    const st = await fetchOutbox(actor, limit);
    for (const s of st) if (!s.in_reply_to_uri) addHome(localId, s.id);
  } catch {
    /* ignore */
  }
}

/** The newest public posts from someone's outbox (profiles of people we've just found). */
export async function fetchOutbox(actor: ActorRow, limit = 20): Promise<StatusRow[]> {
  if (!actor.outbox || actor.local) return [];
  const out: StatusRow[] = [];
  let col = await fetchJson(actor.outbox);
  let page = typeof col.first === "string" ? await fetchJson(col.first) : col.first || col;
  let guard = 0;
  while (page && out.length < limit && guard++ < 3) {
    for (const it of arr(page.orderedItems || page.items)) {
      if (out.length >= limit) break;
      const o = it?.type === "Create" ? it.object : null;
      if (o && typeof o === "object") {
        const s = await storeNote(o, { actor, trusted: true }).catch(() => null);
        if (s) out.push(s);
      }
    }
    if (!page.next || out.length >= limit) break;
    page = await fetchJson(idOf(page.next)!).catch(() => null);
  }
  return out;
}

async function onUndo(obj: any, signer: ActorRow) {
  const oid = idOf(obj);
  const t = typeof obj === "object" ? obj?.type : null;
  if (t === "Follow" || (!t && oid && db.prepare("SELECT 1 FROM fedi_follows WHERE uri = ?").get(oid))) {
    const target = typeof obj === "object" ? localActorFromUri(idOf(obj.object) || "") : null;
    if (target) db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(signer.id, target.id);
    else if (oid) db.prepare("DELETE FROM fedi_follows WHERE uri = ? AND follower_id = ?").run(oid, signer.id);
    return;
  }
  if (t === "Like" || t === "EmojiReact" || (!t && oid && db.prepare("SELECT 1 FROM fedi_likes WHERE uri = ?").get(oid))) {
    const st = typeof obj === "object" && obj.object ? statusByUri(idOf(obj.object)!) || localStatusFromUrl(idOf(obj.object)!) : null;
    if (st) db.prepare("DELETE FROM fedi_likes WHERE actor_id = ? AND status_id = ?").run(signer.id, st.id);
    else if (oid) db.prepare("DELETE FROM fedi_likes WHERE uri = ? AND actor_id = ?").run(oid, signer.id);
    return;
  }
  if (t === "Announce" || !t) {
    const rb = oid ? (db.prepare("SELECT * FROM fedi_statuses WHERE uri = ? AND actor_id = ? AND reblog_of IS NOT NULL").get(oid, signer.id) as StatusRow | undefined) : undefined;
    if (rb) removeStatus(rb);
    return;
  }
  if (t === "Block") {
    const target = localActorFromUri(idOf(obj.object) || "");
    if (target) db.prepare("DELETE FROM fedi_blocks WHERE account_id = ? AND target_id = ? AND kind = 'blocked_by'").run(signer.id, target.id);
  }
}

async function onCreate(obj: any, signer: ActorRow, act: any) {
  if (typeof obj === "string") obj = await fetchJson(obj).catch(() => null);
  if (!obj || !NOTE_TYPES.has(obj.type)) return;
  if (idOf(arr(obj.attributedTo)[0]) !== signer.uri) return;
  // poll votes: a Note with a name, no content, replying to a local poll
  const replyTo = idOf(obj.inReplyTo);
  if (obj.name && !obj.content && replyTo) {
    const poll = statusByUri(replyTo) || localStatusFromUrl(replyTo);
    if (poll?.local && poll.poll) return countVote(poll, signer, String(obj.name));
  }
  if (statusByUri(obj.id)) return;
  const followed = localFollowersOf(signer.id).length > 0;
  const addressed = [...arr(obj.to), ...arr(obj.cc), ...arr(act?.to), ...arr(act?.cc)].map(idOf).some((r) => r && localActorFromUri(r));
  const mentionsLocal = arr(obj.tag).some((t) => t?.type === "Mention" && t.href && localActorFromUri(t.href));
  const parent = replyTo ? statusByUri(replyTo) || localStatusFromUrl(replyTo) : null;
  if (!followed && !addressed && !mentionsLocal && !parent) return;
  const st = await storeNote(obj, { actor: signer });
  if (st) fanout(st);
}

function countVote(poll: StatusRow, voter: ActorRow, choice: string) {
  const p = json(poll.poll, null);
  if (!p || (p.expires_at && Date.parse(p.expires_at) < now())) return;
  const idx = p.options.findIndex((o: any) => o.title === choice);
  if (idx < 0) return;
  const prev = db.prepare("SELECT choices FROM fedi_votes WHERE account_id = ? AND status_id = ?").get(voter.id, poll.id) as { choices: string } | undefined;
  const choices: number[] = prev ? json(prev.choices, []) : [];
  if (choices.includes(idx) || (!p.multiple && choices.length)) return;
  choices.push(idx);
  db.prepare("INSERT INTO fedi_votes (account_id, status_id, choices) VALUES (?, ?, ?) ON CONFLICT(account_id, status_id) DO UPDATE SET choices = excluded.choices").run(voter.id, poll.id, JSON.stringify(choices));
  p.options[idx].votes_count++;
  if (!prev) p.voters_count = (p.voters_count || 0) + 1;
  db.prepare("UPDATE fedi_statuses SET poll = ? WHERE id = ?").run(JSON.stringify(p), poll.id);
  const acc = accountById(poll.actor_id);
  if (acc) {
    const fresh = statusById(poll.id)!;
    deliver(acc, { "@context": AS_CONTEXT, id: `${fresh.uri}#updates/${now()}`, type: "Update", actor: actorUri(acc.username), to: noteJson(fresh).to, cc: noteJson(fresh).cc, object: noteJson(fresh) }, recipientsOf(fresh));
  }
}

async function onUpdate(obj: any, signer: ActorRow) {
  if (typeof obj === "string") obj = await fetchJson(obj).catch(() => null);
  if (!obj) return;
  if (ACTOR_TYPES.has(obj.type)) {
    if (obj.id === signer.uri) upsertActor(obj);
    return;
  }
  if (NOTE_TYPES.has(obj.type)) {
    const st = statusByUri(obj.id);
    if (st && st.actor_id === signer.id) updateRemoteNote(st, obj);
  }
}

async function onDelete(obj: any, signer: ActorRow) {
  const oid = idOf(obj);
  if (!oid) return;
  if (oid === signer.uri) {
    // the account is gone: drop its posts and follows
    const rows = db.prepare("SELECT * FROM fedi_statuses WHERE actor_id = ?").all(signer.id) as StatusRow[];
    for (const r of rows) removeStatus(r);
    db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? OR followee_id = ?").run(signer.id, signer.id);
    db.prepare("DELETE FROM fedi_notifications WHERE from_id = ?").run(signer.id);
    db.prepare("DELETE FROM fedi_likes WHERE actor_id = ?").run(signer.id);
    return;
  }
  const st = statusByUri(oid);
  if (st && st.actor_id === signer.id) removeStatus(st);
}

async function onAnnounce(act: any, signer: ActorRow) {
  const oid = idOf(act.object);
  if (!oid || !act.id) return;
  if (statusByUri(act.id)) return;
  let target = statusByUri(oid) || localStatusFromUrl(oid);
  const followed = localFollowersOf(signer.id).length > 0;
  if (!target) {
    if (!followed) return;
    try {
      const o = typeof act.object === "object" && act.object.content !== undefined && hostOf(act.object.id) === hostOf(signer.uri) ? act.object : await fetchJson(oid);
      target = await storeNote(o, { trusted: true });
    } catch {
      return;
    }
    if (!target) return;
  }
  if (target.visibility === "private" || target.visibility === "direct") return;
  if (!followed && !actorById(target.actor_id)?.local) return;
  const published = Date.parse(act.published) || now();
  const id = newId(Math.min(published, now()));
  db.prepare("INSERT OR IGNORE INTO fedi_statuses (id, uri, url, actor_id, reblog_of, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, act.id, act.id, signer.id, target.id, visibilityOf(act, signer), published);
  const rb = statusByUri(act.id);
  if (!rb) return;
  const tActor = actorById(target.actor_id);
  if (tActor?.local) notify(tActor.id, "reblog", signer.id, target.id);
  fanout(rb);
}

async function onLike(act: any, signer: ActorRow) {
  const oid = idOf(act.object);
  if (!oid) return;
  const st = statusByUri(oid) || localStatusFromUrl(oid);
  if (!st) return;
  const a = actorById(st.actor_id);
  if (!a?.local) return;
  db.prepare("INSERT OR IGNORE INTO fedi_likes (actor_id, status_id, uri, created) VALUES (?, ?, ?, ?)").run(signer.id, st.id, act.id || null, now());
  notify(a.id, "favourite", signer.id, st.id);
}

async function onBlock(obj: any, signer: ActorRow) {
  const target = localActorFromUri(idOf(obj) || "");
  if (!target) return;
  db.prepare("DELETE FROM fedi_follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)").run(signer.id, target.id, target.id, signer.id);
  db.prepare("INSERT OR IGNORE INTO fedi_blocks (account_id, target_id, kind, created) VALUES (?, ?, 'blocked_by', ?)").run(signer.id, target.id, now());
}

async function onMove(act: any, signer: ActorRow) {
  // An account moved: follow the new one for every local follower, as Mastodon does
  const from = idOf(act.object);
  const to = idOf(act.target);
  if (from !== signer.uri || !to) return;
  const dest = await resolveActor(to, { refresh: true });
  if (!dest || !arr((await fetchJson(dest.uri).catch(() => ({})))?.alsoKnownAs).includes(signer.uri)) return;
  db.prepare("UPDATE fedi_actors SET moved_to = ? WHERE id = ?").run(dest.uri, signer.id);
  for (const f of localFollowersOf(signer.id)) {
    const acc = accountById(f.local!);
    if (acc) followActor(acc, dest);
    db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(f.id, signer.id);
  }
}

// ======================================================================
// Things local accounts do
// ======================================================================

export function followActor(acc: AccountRow, target: ActorRow, opts: { reblogs?: boolean; notify?: boolean } = {}) {
  const me = actorById(acc.id)!;
  if (target.id === me.id) throw new FediError(422, "You can't follow yourself");
  const existing = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(me.id, target.id) as any;
  if (existing) {
    db.prepare("UPDATE fedi_follows SET reblogs = ?, notify = ? WHERE follower_id = ? AND followee_id = ?").run(opts.reblogs === false ? 0 : 1, opts.notify ? 1 : 0, me.id, target.id);
    return;
  }
  const uri = `${me.uri}#follows/${crypto.randomUUID()}`;
  db.prepare("INSERT INTO fedi_follows (follower_id, followee_id, state, uri, reblogs, notify, created) VALUES (?, ?, 'pending', ?, ?, ?, ?)").run(me.id, target.id, uri, opts.reblogs === false ? 0 : 1, opts.notify ? 1 : 0, now());
  deliver(acc, { "@context": AS_CONTEXT, id: uri, type: "Follow", actor: me.uri, object: target.uri }, [target]);
}

export function unfollowActor(acc: AccountRow, target: ActorRow) {
  const me = actorById(acc.id)!;
  const row = db.prepare("SELECT * FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(me.id, target.id) as any;
  if (!row) return;
  db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(me.id, target.id);
  db.prepare("DELETE FROM fedi_home WHERE account_id = ? AND status_id IN (SELECT id FROM fedi_statuses WHERE actor_id = ?)").run(acc.id, target.id);
  deliver(acc, { "@context": AS_CONTEXT, id: `${row.uri || me.uri + "#follows/" + target.id}/undo`, type: "Undo", actor: me.uri, object: { id: row.uri, type: "Follow", actor: me.uri, object: target.uri } }, [target]);
}

export function likeStatus(acc: AccountRow, st: StatusRow) {
  const me = actorById(acc.id)!;
  const uri = `${me.uri}#likes/${st.id}`;
  const r = db.prepare("INSERT OR IGNORE INTO fedi_likes (actor_id, status_id, uri, created) VALUES (?, ?, ?, ?)").run(me.id, st.id, uri, now());
  if (!r.changes) return;
  const author = actorById(st.actor_id)!;
  if (author.local) notify(author.id, "favourite", me.id, st.id);
  else deliver(acc, { "@context": "https://www.w3.org/ns/activitystreams", id: uri, type: "Like", actor: me.uri, object: st.uri }, [author]);
}
export function unlikeStatus(acc: AccountRow, st: StatusRow) {
  const me = actorById(acc.id)!;
  const row = db.prepare("SELECT * FROM fedi_likes WHERE actor_id = ? AND status_id = ?").get(me.id, st.id) as any;
  if (!row) return;
  db.prepare("DELETE FROM fedi_likes WHERE actor_id = ? AND status_id = ?").run(me.id, st.id);
  const author = actorById(st.actor_id)!;
  if (!author.local)
    deliver(acc, { "@context": "https://www.w3.org/ns/activitystreams", id: `${row.uri}/undo`, type: "Undo", actor: me.uri, object: { id: row.uri, type: "Like", actor: me.uri, object: st.uri } }, [author]);
}

export function reblogStatus(acc: AccountRow, st: StatusRow): StatusRow {
  const me = actorById(acc.id)!;
  if (st.visibility === "private" || st.visibility === "direct") throw new FediError(422, "This post can't be boosted");
  const existing = db.prepare("SELECT * FROM fedi_statuses WHERE actor_id = ? AND reblog_of = ?").get(me.id, st.id) as StatusRow | undefined;
  if (existing) return existing;
  const id = newId();
  const uri = `${me.uri}/statuses/${id}/activity`;
  db.prepare("INSERT INTO fedi_statuses (id, uri, url, actor_id, local, reblog_of, visibility, created_at) VALUES (?, ?, ?, ?, 1, ?, 'public', ?)").run(id, uri, uri, me.id, st.id, now());
  const rb = statusById(id)!;
  const author = actorById(st.actor_id)!;
  if (author.local) notify(author.id, "reblog", me.id, st.id);
  fanout(rb);
  deliver(acc, announceActivity(rb), [...followersOf(me.id), author]);
  return rb;
}
export function unreblogStatus(acc: AccountRow, st: StatusRow) {
  const me = actorById(acc.id)!;
  const rb = db.prepare("SELECT * FROM fedi_statuses WHERE actor_id = ? AND reblog_of = ?").get(me.id, st.id) as StatusRow | undefined;
  if (!rb) return;
  const act = announceActivity(rb);
  removeStatus(rb);
  const author = actorById(st.actor_id)!;
  deliver(acc, { "@context": "https://www.w3.org/ns/activitystreams", id: `${rb.uri}/undo`, type: "Undo", actor: me.uri, object: act }, [...followersOf(me.id), author]);
}

export function blockActor(acc: AccountRow, target: ActorRow) {
  const me = actorById(acc.id)!;
  db.prepare("INSERT OR IGNORE INTO fedi_blocks (account_id, target_id, kind, created) VALUES (?, ?, 'block', ?)").run(acc.id, target.id, now());
  const wasFollowing = db.prepare("SELECT 1 FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").get(me.id, target.id);
  if (wasFollowing) unfollowActor(acc, target);
  db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? AND followee_id = ?").run(target.id, me.id);
  db.prepare("DELETE FROM fedi_home WHERE account_id = ? AND status_id IN (SELECT id FROM fedi_statuses WHERE actor_id = ?)").run(acc.id, target.id);
  db.prepare("DELETE FROM fedi_notifications WHERE account_id = ? AND from_id = ?").run(acc.id, target.id);
  if (!target.local) deliver(acc, { "@context": "https://www.w3.org/ns/activitystreams", id: `${me.uri}#blocks/${target.id}`, type: "Block", actor: me.uri, object: target.uri }, [target]);
}
export function unblockActor(acc: AccountRow, target: ActorRow) {
  const me = actorById(acc.id)!;
  const r = db.prepare("DELETE FROM fedi_blocks WHERE account_id = ? AND target_id = ? AND kind = 'block'").run(acc.id, target.id);
  if (r.changes && !target.local)
    deliver(
      acc,
      { "@context": "https://www.w3.org/ns/activitystreams", id: `${me.uri}#blocks/${target.id}/undo`, type: "Undo", actor: me.uri, object: { id: `${me.uri}#blocks/${target.id}`, type: "Block", actor: me.uri, object: target.uri } },
      [target],
    );
}

/** Deliver a post to everyone it's addressed to, and those who'd see edits. */
export function deliverStatus(acc: AccountRow, st: StatusRow, kind: "Create" | "Update" | "Delete", extra: ActorRow[] = []) {
  const to = new Map<number, ActorRow>();
  for (const a of [...recipientsOf(st), ...extra]) to.set(a.id, a);
  if (kind !== "Create" && st.visibility !== "direct") {
    // people who boosted or liked it
    for (const r of db.prepare("SELECT a.* FROM fedi_statuses s JOIN fedi_actors a ON a.id = s.actor_id WHERE s.reblog_of = ?").all(st.id) as ActorRow[]) to.set(r.id, r);
  }
  const me = actorById(acc.id)!;
  if (kind === "Create") return deliver(acc, createActivity(st), [...to.values()]);
  if (kind === "Update") {
    const o = noteJson(st);
    return deliver(acc, { "@context": AS_CONTEXT, id: `${st.uri}#updates/${st.edited_at || now()}`, type: "Update", actor: me.uri, to: o.to, cc: o.cc, object: o }, [...to.values()]);
  }
  const o = noteJson(st);
  deliver(acc, { "@context": AS_CONTEXT, id: `${st.uri}#delete`, type: "Delete", actor: me.uri, to: o.to, cc: o.cc, object: { id: st.uri, type: "Tombstone" } }, [...to.values()]);
}

export function voteLocal(acc: AccountRow, st: StatusRow, choices: number[]) {
  const p = json(st.poll, null);
  if (!p) throw new FediError(404, "No poll");
  if (p.expires_at && Date.parse(p.expires_at) < now()) throw new FediError(422, "The poll has ended");
  if (db.prepare("SELECT 1 FROM fedi_votes WHERE account_id = ? AND status_id = ?").get(acc.id, st.id)) throw new FediError(422, "You have already voted");
  const valid = [...new Set(choices)].filter((c) => c >= 0 && c < p.options.length);
  if (!valid.length || (!p.multiple && valid.length > 1)) throw new FediError(422, "Pick one option");
  db.prepare("INSERT INTO fedi_votes (account_id, status_id, choices) VALUES (?, ?, ?)").run(acc.id, st.id, JSON.stringify(valid));
  const author = actorById(st.actor_id)!;
  const me = actorById(acc.id)!;
  if (author.local) {
    for (const c of valid) p.options[c].votes_count++;
    p.voters_count = (p.voters_count || 0) + 1;
    db.prepare("UPDATE fedi_statuses SET poll = ? WHERE id = ?").run(JSON.stringify(p), st.id);
    return;
  }
  for (const c of valid) {
    p.options[c].votes_count++;
    const id = `${me.uri}#votes/${st.id}/${c}`;
    deliver(
      acc,
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${id}/activity`,
        type: "Create",
        actor: me.uri,
        to: [author.uri],
        object: { id, type: "Note", name: p.options[c].title, attributedTo: me.uri, to: [author.uri], inReplyTo: st.uri },
      },
      [author],
    );
  }
  p.voters_count = (p.voters_count || 0) + 1;
  db.prepare("UPDATE fedi_statuses SET poll = ? WHERE id = ?").run(JSON.stringify(p), st.id);
}
