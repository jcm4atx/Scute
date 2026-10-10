/**
 * Fediverse routes: WebFinger, NodeInfo, ActivityPub actors/inboxes/outboxes,
 * public profile pages, OAuth for Mastodon apps, the streaming API, media
 * files, and the signed-in Scute endpoints the plug-in uses.
 */
import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { db } from "../storage";
import {
  FEDI_ON,
  FEDI_URL,
  FEDI_HOST,
  FEDI_DOMAIN,
  FEDI_USERS,
  MASTO_VERSION,
  MEDIA_DIR,
  AS_CONTEXT,
  bus,
  FediError,
  now,
  iso,
  json,
  sha256hex,
  randomToken,
  escapeHtml,
  htmlToText,
  parseSignature,
  newKeyPair,
  kv,
  solidPng,
  actorById,
  actorByUri,
  statusById,
  accountById,
  accountByName,
  accountByUser,
  actorUri,
  profileUrl,
  type ActorRow,
  type AccountRow,
  type StatusRow,
  type MediaRow,
  INSTANCE_ACTOR,
  LEGACY_INSTANCE_ACTOR,
} from "./core";
import { APP_VERSION } from "../../shared/version";
import {
  localActorJson,
  instanceActorJson,
  noteJson,
  createActivity,
  announceActivity,
  handleActivity,
  actorForKey,
  startDeliveryLoop,
  deliver,
  followersOf,
  removeStatus,
  mediaOf,
  mediaUrl,
  thumbUrl,
} from "./ap";
import { registerMastodonApi, accountJson, statusJson, notificationJson, tokenFrom, issueToken, canSee } from "./api";
import { pruneMedia } from "./compose";
import { sendPushFor } from "./push";

const AP_TYPES = /application\/(activity|ld)\+json/i;
const wantsAp = (req: Request) => AP_TYPES.test(String(req.headers.accept || "")) || /\bjson\b/.test(String(req.query.format || ""));
const apJson = (res: Response, body: any, status = 200) => res.status(status).type("application/activity+json; charset=utf-8").set("Access-Control-Allow-Origin", "*").send(JSON.stringify(body));
const reqHost = (req: Request) => String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase().replace(/:(443|80)$/, "");

const FEDI_PATH = /^\/(\.well-known\/(webfinger|nodeinfo|host-meta|oauth-authorization-server)|nodeinfo|users\/|actor|inbox|api\/v[12]\/|oauth\/|@|tags\/|fedi\/|about|authorize_interaction|favicon\.ico|robots\.txt)/;
export const isFediPath = (p: string) => FEDI_PATH.test(p);
const RESERVED = new Set(["admin", "root", "actor", "inbox", "about", "api", "oauth", "users", "tags", "fedi", "settings", "support", "help", "www", "mail", "postmaster", "abuse", "security"]);

interface Deps {
  auth: any;
  wrap: any;
  HttpError: any;
  checkLogin: (u: string, k: string, ip: string) => { id: string; username: string };
  kdfParams: (u: string) => { salt: string; iter: number };
}

// ======================================================================
// HTTP signature check for the inbox
// ======================================================================

async function verifySignature(req: Request): Promise<ActorRow> {
  const header = String(req.headers.signature || "");
  if (!header) {
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Signature ")) throw new FediError(401, "Request not signed");
  }
  const p = parseSignature(header || String(req.headers.authorization).slice(10));
  if (!p.keyId || !p.signature) throw new FediError(401, "Bad signature");
  const names = (p.headers || "date").toLowerCase().split(/\s+/);
  const date = Date.parse(String(req.headers.date || ""));
  if (names.includes("date") && (!date || Math.abs(now() - date) > 12 * 3600_000)) throw new FediError(401, "Signature too old");
  if (req.method === "POST") {
    if (!names.includes("digest")) throw new FediError(401, "Digest not signed");
    const raw = (req as any).rawBody as Buffer | undefined;
    const want = "SHA-256=" + crypto.createHash("sha256").update(raw || Buffer.alloc(0)).digest("base64");
    const got = String(req.headers.digest || "").split(",").map((s) => s.trim()).find((s) => /^sha-256=/i.test(s));
    if (!got || got.slice(8) !== want.slice(8)) throw new FediError(401, "Digest mismatch");
  }
  const prefix = String(req.headers["x-forwarded-prefix"] || "").replace(/\/+$/, "");
  const targets = [...new Set([req.originalUrl, prefix + req.originalUrl])];
  const hosts = [...new Set([String(req.headers.host || ""), String(req.headers["x-forwarded-host"] || "").split(",")[0].trim(), FEDI_HOST].filter(Boolean))];
  const build = (target: string, host: string) =>
    names
      .map((n) => {
        if (n === "(request-target)") return `(request-target): ${req.method.toLowerCase()} ${target}`;
        if (n === "(created)") return `(created): ${p.created}`;
        if (n === "(expires)") return `(expires): ${p.expires}`;
        if (n === "host") return `host: ${host}`;
        const v = req.headers[n];
        return `${n}: ${Array.isArray(v) ? v.join(", ") : (v ?? "")}`;
      })
      .join("\n");
  const sig = Buffer.from(p.signature, "base64");
  const check = (pem: string) => {
    for (const t of targets)
      for (const h of hosts) {
        try {
          if (crypto.verify("sha256", Buffer.from(build(t, h)), pem, sig)) return true;
        } catch {
          /* bad key */
        }
      }
    return false;
  };
  let actor = await actorForKey(p.keyId);
  if (actor?.public_key && check(actor.public_key)) return actor;
  actor = await actorForKey(p.keyId, true);
  if (actor?.public_key && check(actor.public_key)) return actor;
  throw new FediError(401, "Signature didn't verify");
}

// ======================================================================
// HTML (public profile and post pages)
// ======================================================================

const CSS = `
:root{color-scheme:light dark;--bg:#f7f6f2;--fg:#28251d;--muted:#7a7974;--card:#fbfbf9;--line:#dcd9d5;--accent:#01696f}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#cdccca;--muted:#8a8986;--card:#1c1b19;--line:#393836;--accent:#4f98a3}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}main{max-width:640px;margin:0 auto;padding:24px 16px 64px}
.head{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card);margin-bottom:20px}
.banner{height:160px;background:var(--line) center/cover}.who{display:flex;gap:16px;align-items:flex-end;padding:0 20px;margin-top:-40px}
.av{width:88px;height:88px;border-radius:12px;border:3px solid var(--card);background:var(--line) center/cover;flex:none}
.name{font-size:20px;font-weight:650;margin:0}.acct{color:var(--muted);font-size:14px;word-break:break-all}
.bio{padding:12px 20px 4px}.bio p{margin:.4em 0}.fields{padding:0 20px 12px;font-size:14px}.fields div{display:flex;gap:8px;border-top:1px solid var(--line);padding:6px 0}.fields b{min-width:110px;color:var(--muted);font-weight:500}
.stats{display:flex;gap:18px;padding:8px 20px 16px;color:var(--muted);font-size:14px}.stats b{color:var(--fg)}
.post{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:14px 16px;margin-bottom:12px}
.post .meta{display:flex;gap:10px;align-items:center;margin-bottom:6px}.post .meta .av{width:40px;height:40px;border-width:0;border-radius:8px;margin:0}
.post .meta a{text-decoration:none;color:inherit}.post time{margin-left:auto;color:var(--muted);font-size:13px;white-space:nowrap}
.post .c p{margin:.35em 0}.post .c .invisible{display:none}.post .c .ellipsis::after{content:"…"}
.media{display:grid;gap:6px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-top:8px}.media img,.media video{width:100%;border-radius:8px;max-height:420px;object-fit:cover;background:var(--line)}.media audio{width:100%}
.file{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:10px 12px;text-decoration:none;color:inherit}.file span{color:var(--muted);font-size:13px}
details summary{cursor:pointer;color:var(--muted)}.foot{color:var(--muted);font-size:13px;text-align:center;margin-top:28px}
.btn{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:8px;padding:6px 12px;text-decoration:none;font-size:14px}
form.auth{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:20px;display:grid;gap:12px}
form.auth input{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);width:100%}
form.auth button{font:inherit;padding:9px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
form.auth button.no{background:transparent;color:var(--fg);border-color:var(--line)}.err{color:#a12c7b;min-height:1.2em;font-size:14px}.row{display:flex;gap:8px;justify-content:flex-end}
code{background:var(--line);padding:2px 6px;border-radius:6px;word-break:break-all}`;

function page(title: string, body: string, extraHead = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" href="${FEDI_URL}/fedi/static/avatar.png">${extraHead}<style>${CSS}</style></head><body><main>${body}<p class="foot">${escapeHtml(FEDI_DOMAIN)} · a Fediverse server run with Scute</p></main></body></html>`;
}
const fmtSize = (n: number) => (n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : n > 1e3 ? Math.round(n / 1e3) + " KB" : n + " B");

function mediaHtml(m: MediaRow) {
  const url = escapeHtml(mediaUrl(m));
  const alt = escapeHtml(m.description || "");
  if (m.type === "image") return `<a href="${url}"><img src="${escapeHtml(thumbUrl(m) || mediaUrl(m))}" alt="${alt}" loading="lazy"></a>`;
  if (m.type === "video" || m.type === "gifv") return `<video src="${url}" ${thumbUrl(m) ? `poster="${escapeHtml(thumbUrl(m)!)}"` : ""} controls preload="none" aria-label="${alt}"></video>`;
  if (m.type === "audio") return `<audio src="${url}" controls preload="none" aria-label="${alt}"></audio>`;
  return `<a class="file" href="${url}" download>⬇ <div><div>${escapeHtml(m.name || "file")}</div><span>${escapeHtml(m.mime)}${m.size ? " · " + fmtSize(m.size) : ""}${alt ? " · " + alt : ""}</span></div></a>`;
}

function postHtml(st: StatusRow) {
  const a = actorById(st.actor_id)!;
  const av = escapeHtml(a.avatar || `${FEDI_URL}/fedi/static/avatar.png`);
  const media = mediaOf(st.id);
  const body = `<div class="c">${st.content}</div>${media.length ? `<div class="media">${media.map(mediaHtml).join("")}</div>` : ""}`;
  const local = `${FEDI_URL}/@${a.local ? a.username : ""}${a.local ? "/" + st.id : ""}`;
  return `<article class="post"><div class="meta"><div class="av" style="background-image:url('${av}')"></div><a href="${escapeHtml(a.local ? profileUrl(a.username) : a.url || a.uri)}"><b>${escapeHtml(a.display_name || a.username)}</b><div class="acct">@${escapeHtml(a.username)}@${escapeHtml(a.local ? FEDI_DOMAIN : a.domain)}</div></a><time datetime="${iso(st.created_at)}"><a href="${escapeHtml(a.local ? local : st.url || st.uri)}">${new Date(st.created_at).toUTCString().slice(5, 22)}</a></time></div>${st.spoiler ? `<details><summary>${escapeHtml(st.spoiler)}</summary>${body}</details>` : body}</article>`;
}

function profilePage(acc: AccountRow, before?: number) {
  const a = actorById(acc.id)!;
  const j = accountJson(a);
  const fields = json(a.fields, []) as any[];
  const rows = db.prepare(`SELECT * FROM fedi_statuses WHERE actor_id = ? AND visibility = 'public' AND reblog_of IS NULL ${before ? "AND id < ?" : ""} ORDER BY pinned DESC, id DESC LIMIT 20`).all(...[a.id, ...(before ? [before] : [])]) as StatusRow[];
  const more = rows.length === 20 ? `<p style="text-align:center"><a class="btn" href="${profileUrl(acc.username)}?max_id=${rows[rows.length - 1].id}">Older posts</a></p>` : "";
  return page(
    `${a.display_name || a.username} (@${acc.username}@${FEDI_DOMAIN})`,
    `<section class="head"><div class="banner" style="background-image:url('${escapeHtml(j.header)}')"></div><div class="who"><div class="av" style="background-image:url('${escapeHtml(j.avatar)}')"></div><div><h1 class="name">${escapeHtml(a.display_name || a.username)}</h1><div class="acct">@${escapeHtml(acc.username)}@${escapeHtml(FEDI_DOMAIN)}</div></div></div><div class="bio">${a.note || ""}</div>${fields.length ? `<div class="fields">${fields.map((f) => `<div><b>${escapeHtml(f.name)}</b><span>${f.value}</span></div>`).join("")}</div>` : ""}<div class="stats"><span><b>${j.statuses_count}</b> posts</span><span><b>${j.following_count}</b> following</span><span><b>${j.followers_count}</b> followers</span></div></section>
     <p class="acct" style="margin:-8px 0 16px">To follow, search for <code>@${escapeHtml(acc.username)}@${escapeHtml(FEDI_DOMAIN)}</code> on your own server.</p>
     ${rows.map(postHtml).join("") || `<p class="acct">No public posts yet.</p>`}${more}`,
    `<link rel="alternate" type="application/activity+json" href="${actorUri(acc.username)}"><meta property="og:title" content="${escapeHtml(a.display_name || a.username)}"><meta property="og:description" content="${escapeHtml(htmlToText(a.note || "").slice(0, 200))}">`,
  );
}

// ======================================================================
// Registration
// ======================================================================

export function registerFediRoutes(app: Express, httpServer: Server, deps: Deps) {
  if (!FEDI_ON) {
    app.get("/api/fedi", deps.auth, (_req: Request, res: Response) => res.json({ enabled: false }));
    return;
  }
  const wrapF =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = fn(req, res);
        if (out instanceof Promise) out.catch(next);
      } catch (e) {
        next(e);
      }
    };

  // CORS for web apps (Elk, Phanpy) on other origins
  app.use((req, res, next) => {
    if (!/^\/(api\/v[12]\/|oauth\/|\.well-known\/|nodeinfo|fedi\/)/.test(req.path)) return next();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Link, X-RateLimit-Reset, X-RateLimit-Limit, X-RateLimit-Remaining, X-Request-Id, Idempotency-Key");
    if (req.method !== "OPTIONS") return next();
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Accept");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
  });

  // ---------- discovery ----------
  app.get("/.well-known/webfinger", wrapF((req, res) => {
    const r = String(req.query.resource || "").trim();
    let name = "";
    let m: RegExpMatchArray | null;
    if ((m = r.match(/^(?:acct:)?@?([^@]+)@(.+)$/))) {
      const d = m[2].toLowerCase();
      if (d !== FEDI_DOMAIN && d !== FEDI_HOST) return res.status(404).json({ error: "Not found" });
      name = m[1];
    } else if (r.startsWith(FEDI_URL + "/users/")) name = r.slice(FEDI_URL.length + 7).split("/")[0];
    else if (r.startsWith(FEDI_URL + "/@")) name = r.slice(FEDI_URL.length + 2).split("/")[0];
    else if (r === INSTANCE_ACTOR || r === LEGACY_INSTANCE_ACTOR) name = FEDI_DOMAIN;
    if (name.toLowerCase() === FEDI_DOMAIN) {
      return res.type("application/jrd+json").set("Access-Control-Allow-Origin", "*").send(JSON.stringify({ subject: `acct:${FEDI_DOMAIN}@${FEDI_DOMAIN}`, aliases: [INSTANCE_ACTOR], links: [{ rel: "self", type: "application/activity+json", href: INSTANCE_ACTOR }] }));
    }
    const acc = name ? accountByName(name) : undefined;
    if (!acc) return res.status(404).json({ error: "Not found" });
    res.type("application/jrd+json").set("Access-Control-Allow-Origin", "*").send(
      JSON.stringify({
        subject: `acct:${acc.username}@${FEDI_DOMAIN}`,
        aliases: [profileUrl(acc.username), actorUri(acc.username)],
        links: [
          { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: profileUrl(acc.username) },
          { rel: "self", type: "application/activity+json", href: actorUri(acc.username) },
          { rel: "http://ostatus.org/schema/1.0/subscribe", template: `${FEDI_URL}/authorize_interaction?uri={uri}` },
          ...(actorById(acc.id)?.avatar ? [{ rel: "http://webfinger.net/rel/avatar", type: "image/png", href: actorById(acc.id)!.avatar }] : []),
        ],
      }),
    );
  }));
  app.get("/.well-known/host-meta", (_req, res) => {
    res.type("application/xrd+xml").send(`<?xml version="1.0" encoding="UTF-8"?><XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"><Link rel="lrdd" template="${FEDI_URL}/.well-known/webfinger?resource={uri}"/></XRD>`);
  });
  app.get("/.well-known/nodeinfo", (_req, res) => res.json({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.0", href: `${FEDI_URL}/nodeinfo/2.0` }] }));
  app.get(["/nodeinfo/2.0", "/nodeinfo/2.0.json"], (_req, res) => {
    const users = (db.prepare("SELECT COUNT(*) c FROM fedi_accounts").get() as any).c;
    const posts = (db.prepare("SELECT COUNT(*) c FROM fedi_statuses WHERE local = 1 AND reblog_of IS NULL").get() as any).c;
    res.type('application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"').send(
      JSON.stringify({ version: "2.0", software: { name: "scute", version: APP_VERSION }, protocols: ["activitypub"], services: { inbound: [], outbound: [] }, openRegistrations: false, usage: { users: { total: users, activeMonth: users, activeHalfyear: users }, localPosts: posts }, metadata: { nodeName: FEDI_DOMAIN } }),
    );
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer: FEDI_URL + "/",
      service_documentation: "https://docs.joinmastodon.org/",
      authorization_endpoint: `${FEDI_URL}/oauth/authorize`,
      token_endpoint: `${FEDI_URL}/oauth/token`,
      revocation_endpoint: `${FEDI_URL}/oauth/revoke`,
      app_registration_endpoint: `${FEDI_URL}/api/v1/apps`,
      scopes_supported: ["read", "write", "follow", "push", "profile"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    }),
  );
  app.get("/robots.txt", (req, res, next) => (reqHost(req) === FEDI_HOST ? res.type("text/plain").send("User-agent: *\nDisallow: /oauth/\nDisallow: /api/\n") : next()));

  // ---------- ActivityPub ----------
  app.get("/instance-actor", (_req, res) => apJson(res, instanceActorJson()));
  app.get("/actor", (_req, res) => apJson(res, instanceActorJson(LEGACY_INSTANCE_ACTOR)));
  app.post(["/instance-actor/inbox", "/actor/inbox"], (_req, res) => res.status(202).end());

  const accParam = (req: Request) => {
    const acc = accountByName(String(req.params.name));
    if (!acc) throw new FediError(kv(`gone:${String(req.params.name).toLowerCase()}`) ? 410 : 404, "Not found");
    return acc;
  };
  app.get("/users/:name", wrapF((req, res) => {
    const acc = accParam(req);
    if (!wantsAp(req)) return res.redirect(302, profileUrl(acc.username));
    apJson(res, localActorJson(acc));
  }));
  const collection = (id: string, total: number, items?: any[], first?: string) => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "OrderedCollection",
    totalItems: total,
    ...(items ? { orderedItems: items } : {}),
    ...(first ? { first } : {}),
  });
  app.get("/users/:name/outbox", wrapF((req, res) => {
    const acc = accParam(req);
    const base = `${actorUri(acc.username)}/outbox`;
    const total = (db.prepare("SELECT COUNT(*) c FROM fedi_statuses WHERE actor_id = ? AND visibility IN ('public','unlisted')").get(acc.id) as any).c;
    if (!req.query.page) return apJson(res, { ...collection(base, total, undefined, `${base}?page=true`), last: `${base}?min_id=0&page=true` });
    const max = Number(req.query.max_id) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare("SELECT * FROM fedi_statuses WHERE actor_id = ? AND visibility IN ('public','unlisted') AND id < ? ORDER BY id DESC LIMIT 20").all(acc.id, max) as StatusRow[];
    const items = rows.map((s) => (s.reblog_of ? (statusById(s.reblog_of) ? announceActivity(s) : null) : createActivity(s))).filter(Boolean).map((a: any) => ({ ...a, "@context": undefined }));
    apJson(res, {
      "@context": AS_CONTEXT,
      id: `${base}?page=true${req.query.max_id ? `&max_id=${req.query.max_id}` : ""}`,
      type: "OrderedCollectionPage",
      partOf: base,
      orderedItems: items,
      ...(rows.length === 20 ? { next: `${base}?page=true&max_id=${rows[rows.length - 1].id}` } : {}),
    });
  }));
  const people = (which: "followers" | "following") =>
    wrapF((req, res) => {
      const acc = accParam(req);
      const base = `${actorUri(acc.username)}/${which}`;
      const sql =
        which === "followers"
          ? "SELECT a.uri FROM fedi_follows f JOIN fedi_actors a ON a.id = f.follower_id WHERE f.followee_id = ? AND f.state = 'accepted' ORDER BY f.created DESC"
          : "SELECT a.uri FROM fedi_follows f JOIN fedi_actors a ON a.id = f.followee_id WHERE f.follower_id = ? AND f.state = 'accepted' ORDER BY f.created DESC";
      const rows = db.prepare(sql).all(acc.id) as { uri: string }[];
      if (!req.query.page) return apJson(res, collection(base, rows.length, undefined, `${base}?page=1`));
      const n = Math.max(1, Number(req.query.page) || 1);
      const slice = rows.slice((n - 1) * 40, n * 40).map((r) => r.uri);
      apJson(res, { "@context": "https://www.w3.org/ns/activitystreams", id: `${base}?page=${n}`, type: "OrderedCollectionPage", totalItems: rows.length, partOf: base, orderedItems: slice, ...(rows.length > n * 40 ? { next: `${base}?page=${n + 1}` } : {}) });
    });
  app.get("/users/:name/followers", people("followers"));
  app.get("/users/:name/following", people("following"));
  app.get("/users/:name/collections/featured", wrapF((req, res) => {
    const acc = accParam(req);
    const rows = db.prepare("SELECT * FROM fedi_statuses WHERE actor_id = ? AND pinned = 1 AND visibility IN ('public','unlisted') ORDER BY id DESC LIMIT 5").all(acc.id) as StatusRow[];
    apJson(res, { "@context": AS_CONTEXT, id: `${actorUri(acc.username)}/collections/featured`, type: "OrderedCollection", totalItems: rows.length, orderedItems: rows.map(noteJson) });
  }));
  const localStatus = (req: Request) => {
    const acc = accParam(req);
    const st = statusById(Number(req.params.id));
    if (!st || st.actor_id !== acc.id || !st.local || (st.visibility !== "public" && st.visibility !== "unlisted")) throw new FediError(404, "Not found");
    return { acc, st };
  };
  app.get("/users/:name/statuses/:id", wrapF((req, res) => {
    const { acc, st } = localStatus(req);
    if (st.reblog_of) return apJson(res, announceActivity(st));
    if (!wantsAp(req)) return res.redirect(302, `${profileUrl(acc.username)}/${st.id}`);
    apJson(res, { "@context": AS_CONTEXT, ...noteJson(st) });
  }));
  app.get("/users/:name/statuses/:id/activity", wrapF((req, res) => {
    const { st } = localStatus(req);
    apJson(res, st.reblog_of ? announceActivity(st) : createActivity(st));
  }));
  app.get("/users/:name/statuses/:id/replies", wrapF((req, res) => {
    const { st } = localStatus(req);
    const rows = db.prepare("SELECT uri FROM fedi_statuses WHERE in_reply_to_id = ? AND visibility IN ('public','unlisted') ORDER BY id LIMIT 100").all(st.id) as { uri: string }[];
    apJson(res, { "@context": "https://www.w3.org/ns/activitystreams", id: `${st.uri}/replies`, type: "Collection", first: { type: "CollectionPage", partOf: `${st.uri}/replies`, items: rows.map((r) => r.uri) } });
  }));

  // inboxes: verify, answer 202, handle
  const inbox = wrapF(async (req, res) => {
    let signer: ActorRow;
    try {
      signer = await verifySignature(req);
    } catch (e: any) {
      // Deletes from accounts that are already gone can't be verified: ignore quietly
      const b = req.body;
      if (b?.type === "Delete" && idOfStr(b.actor) && idOfStr(b.actor) === idOfStr(b.object)) return res.status(202).end();
      return res.status(e.status || 401).json({ error: e.message });
    }
    if (db.prepare("SELECT 1 FROM fedi_domain_blocks WHERE domain = ? AND account_id IN (SELECT id FROM fedi_accounts)").get(signer.domain) && req.body?.type !== "Undo") {
      // every local account blocked this server
      const n = (db.prepare("SELECT COUNT(DISTINCT account_id) c FROM fedi_domain_blocks WHERE domain = ?").get(signer.domain) as any).c;
      const total = (db.prepare("SELECT COUNT(*) c FROM fedi_accounts").get() as any).c;
      if (n >= total) return res.status(202).end();
    }
    res.status(202).end();
    queue = queue.then(() => handleActivity(req.body, signer).catch((e) => console.error("[fedi] inbox", req.body?.type, e?.message || e)));
  });
  let queue: Promise<void> = Promise.resolve();
  app.post("/inbox", inbox);
  app.post("/users/:name/inbox", inbox);

  // ---------- public pages ----------
  app.get("/@:name", wrapF((req, res) => {
    const acc = accountByName(String(req.params.name).split("@")[0]);
    if (!acc) return res.status(404).type("html").send(page("Not found", "<h1>Not found</h1>"));
    if (wantsAp(req)) return apJson(res, localActorJson(acc));
    res.type("html").set("Cache-Control", "public, max-age=60").send(profilePage(acc, Number(req.query.max_id) || undefined));
  }));
  app.get("/@:name/:id", wrapF((req, res) => {
    const acc = accountByName(String(req.params.name));
    const st = acc ? statusById(Number(req.params.id)) : undefined;
    if (!acc || !st || st.actor_id !== acc.id || !(st.visibility === "public" || st.visibility === "unlisted")) return res.status(404).type("html").send(page("Not found", "<h1>Not found</h1>"));
    if (wantsAp(req)) return apJson(res, { "@context": AS_CONTEXT, ...noteJson(st) });
    const a = actorById(acc.id)!;
    const replies = db.prepare("SELECT * FROM fedi_statuses WHERE in_reply_to_id = ? AND visibility = 'public' ORDER BY id LIMIT 50").all(st.id) as StatusRow[];
    const parent = st.in_reply_to_id ? statusById(st.in_reply_to_id) : undefined;
    const media = mediaOf(st.id);
    const og = media.find((m) => m.type === "image");
    res.type("html").send(
      page(
        `${a.display_name || a.username}: "${htmlToText(st.content).slice(0, 60)}"`,
        `${parent && parent.visibility === "public" ? postHtml(parent) : ""}${postHtml(st)}${replies.map(postHtml).join("")}<p><a class="btn" href="${profileUrl(acc.username)}">More from @${escapeHtml(acc.username)}</a></p>`,
        `<link rel="alternate" type="application/activity+json" href="${st.uri}"><meta property="og:title" content="${escapeHtml(a.display_name || a.username)} (@${escapeHtml(acc.username)}@${escapeHtml(FEDI_DOMAIN)})"><meta property="og:description" content="${escapeHtml(htmlToText(st.spoiler || st.content).slice(0, 200))}">${og ? `<meta property="og:image" content="${escapeHtml(thumbUrl(og) || mediaUrl(og))}">` : ""}`,
      ),
    );
  }));
  app.get("/tags/:tag", wrapF((req, res) => {
    const t = String(req.params.tag).toLowerCase();
    const rows = db.prepare(`SELECT * FROM fedi_statuses WHERE visibility = 'public' AND reblog_of IS NULL AND tags LIKE '%"' || ? || '"%' ORDER BY id DESC LIMIT 40`).all(t) as StatusRow[];
    res.type("html").send(page(`#${t}`, `<h1>#${escapeHtml(t)}</h1>${rows.map(postHtml).join("") || "<p>No posts here yet.</p>"}`));
  }));
  app.get("/about", (_req, res) => {
    const accs = db.prepare("SELECT * FROM fedi_accounts ORDER BY created").all() as AccountRow[];
    res.type("html").send(page(FEDI_DOMAIN, `<h1>${escapeHtml(FEDI_DOMAIN)}</h1><p>A small Fediverse server run with Scute.</p>${accs.map((a) => `<p><a class="btn" href="${profileUrl(a.username)}">@${escapeHtml(a.username)}@${escapeHtml(FEDI_DOMAIN)}</a></p>`).join("")}`));
  });
  app.get("/authorize_interaction", (req, res) => {
    const uri = String(req.query.uri || "");
    res.type("html").send(page("Follow", `<p>Open this in your Fediverse app and search for:</p><p><code>${escapeHtml(uri)}</code></p>`));
  });

  // ---------- media ----------
  const statics: Record<string, Buffer> = {};
  app.get("/fedi/static/:file", (req, res) => {
    const f = req.params.file;
    if (f !== "avatar.png" && f !== "header.png") return res.status(404).end();
    statics[f] ||= f === "avatar.png" ? solidPng(400, 400, [0x8a, 0x89, 0x86]) : solidPng(1500, 500, [0xd4, 0xd1, 0xca]);
    res.type("png").set("Cache-Control", "public, max-age=604800").set("Access-Control-Allow-Origin", "*").send(statics[f]);
  });
  app.get(["/favicon.ico"], (req, res, next) => (reqHost(req) === FEDI_HOST ? res.redirect(302, "/fedi/static/avatar.png") : next()));
  app.get("/fedi/media/:id/:name", (req, res) => {
    const m = db.prepare("SELECT * FROM fedi_media WHERE id = ?").get(Number(req.params.id)) as MediaRow | undefined;
    const rel = m && [m.file, m.thumb].find((f) => f && path.basename(f) === req.params.name);
    if (!m || !rel) return res.status(404).end();
    const file = path.join(MEDIA_DIR, rel);
    if (!file.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(file)) return res.status(404).end();
    const isThumb = rel === m.thumb;
    const mime = isThumb ? (/\.png$/.test(rel) ? "image/png" : /\.webp$/.test(rel) ? "image/webp" : "image/jpeg") : m.mime;
    const inline = isThumb || /^(image|video|audio)\//.test(mime) || mime === "application/pdf";
    res.set({
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": mime === "application/pdf" ? "default-src 'none'; object-src 'self'" : "default-src 'none'; sandbox", // browsers' PDF viewers don't run sandboxed
      "Content-Disposition": `${inline && !req.query.dl ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(m.name || req.params.name)}`,
    });
    res.sendFile(file, { headers: { "Content-Type": mime } });
  });

  // ---------- OAuth ----------
  const appByClient = (id: string) => db.prepare("SELECT * FROM fedi_apps WHERE client_id = ?").get(id) as any;
  app.get("/oauth/authorize", wrapF((req, res) => {
    const q = req.query as any;
    const a = appByClient(String(q.client_id || ""));
    if (!a) return res.status(400).type("html").send(page("Unknown app", "<h1>Unknown app</h1><p>This app isn't registered here.</p>"));
    const redirect = String(q.redirect_uri || a.redirect_uris.split("\n")[0]);
    if (!a.redirect_uris.split("\n").includes(redirect)) return res.status(400).type("html").send(page("Bad redirect", "<h1>That redirect address isn't registered for this app</h1>"));
    const scopes = String(q.scope || q.scopes || a.scopes || "read");
    const data = { client_id: a.client_id, redirect_uri: redirect, scope: scopes, state: q.state ?? null, code_challenge: q.code_challenge ?? null, code_challenge_method: q.code_challenge_method ?? null };
    res.set({ "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'", "Cache-Control": "no-store" }).type("html").send(
      page(
        `Sign in to ${FEDI_DOMAIN}`,
        `<h1 style="font-size:22px">Allow <b>${escapeHtml(a.name)}</b> to use your account?</h1>
         <p class="acct">It will be able to ${scopeText(scopes)}. You can remove it later in Scute (Fediverse → Apps).</p>
         <form class="auth" id="f"><label>Scute username<input id="u" autocomplete="username" required autocapitalize="none"></label>
         <label>Password<input id="p" type="password" autocomplete="current-password" required></label>
         <div class="err" id="e"></div><div class="row"><button type="button" class="no" id="d">Deny</button><button id="ok">Allow</button></div>
         <p class="acct" style="margin:0">Your password stays in this browser; Scute checks it the same way the Scute app does.</p></form>
         <script>
         const D=${JSON.stringify(data).replace(/</g, "\\u003c")};
         const $=(i)=>document.getElementById(i);
         async function go(approve){
           $("e").textContent="";$("ok").disabled=true;
           try{
             let body={...D,approve};
             if(approve){
               const u=$("u").value.trim(),pw=$("p").value;
               $("ok").textContent="Checking…";
               const pr=await (await fetch("/oauth/params?username="+encodeURIComponent(u))).json();
               const enc=new TextEncoder();
               const base=await crypto.subtle.importKey("raw",enc.encode(pw.normalize("NFKC")),"PBKDF2",false,["deriveBits"]);
               const salt=Uint8Array.from(atob(pr.salt),c=>c.charCodeAt(0));
               const bits=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:pr.iter},base,512));
               body.username=u;body.authKey=btoa(String.fromCharCode(...bits.slice(0,32)));
             }
             const r=await fetch("/oauth/authorize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
             const j=await r.json();
             if(!r.ok) throw new Error(j.error||"Something went wrong");
             if(j.code){document.body.querySelector("main").innerHTML='<h1 style="font-size:22px">Copy this code into the app</h1><p><code style="font-size:18px">'+j.code+'</code></p>';return;}
             location.href=j.redirect;
           }catch(err){$("e").textContent=err.message;}
           finally{$("ok").disabled=false;$("ok").textContent="Allow";}
         }
         $("f").addEventListener("submit",(ev)=>{ev.preventDefault();go(true)});
         $("d").addEventListener("click",()=>go(false));
         </script>`,
      ),
    );
  }));
  app.get("/oauth/params", (req, res) => res.set("Cache-Control", "no-store").json(deps.kdfParams(String(req.query.username || "").slice(0, 64))));
  app.post("/oauth/authorize", wrapF((req, res) => {
    const b = req.body || {};
    const a = appByClient(String(b.client_id || ""));
    if (!a) throw new FediError(400, "Unknown app");
    const redirect = String(b.redirect_uri || "");
    if (!a.redirect_uris.split("\n").includes(redirect)) throw new FediError(400, "That redirect address isn't registered for this app");
    const withParams = (params: Record<string, string>) => {
      if (redirect === "urn:ietf:wg:oauth:2.0:oob") return null;
      const u = new URL(redirect);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (b.state != null) u.searchParams.set("state", String(b.state));
      return u.toString();
    };
    if (!b.approve) return res.json({ redirect: withParams({ error: "access_denied", error_description: "The user denied access" }) || "/" });
    let user;
    try {
      user = deps.checkLogin(String(b.username || ""), String(b.authKey || ""), req.ip || "");
    } catch (e: any) {
      throw new FediError(e.status || 401, e.message);
    }
    const acc = accountByUser(user.id);
    if (!acc) throw new FediError(403, "This Scute user has no Fediverse account yet. Make one in Scute first (Fediverse plug-in).");
    const code = randomToken(24);
    db.prepare("INSERT INTO fedi_codes (code_hash, app_id, account_id, redirect_uri, scopes, challenge, expires) VALUES (?, ?, ?, ?, ?, ?, ?)").run(sha256hex(code), a.id, acc.id, redirect, String(b.scope || a.scopes), b.code_challenge ? String(b.code_challenge) : null, now() + 10 * 60_000);
    const r = withParams({ code });
    res.json(r ? { redirect: r } : { code });
  }));
  app.post("/oauth/token", wrapF(async (req, res) => {
    let b: any = req.body || {};
    if (/multipart/i.test(String(req.headers["content-type"] || ""))) {
      const { parseMultipart, cleanupUploads } = await import("./multipart");
      const mp = await parseMultipart(req, { dir: path.join(MEDIA_DIR, "..", "tmp"), maxFileBytes: 1024 });
      cleanupUploads(mp);
      b = mp.fields;
    }
    b = { ...(req.query as any), ...b };
    const basic = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
    if (basic) {
      const [id, secret] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      b.client_id ||= decodeURIComponent(id);
      b.client_secret ||= decodeURIComponent(secret || "");
    }
    const a = appByClient(String(b.client_id || ""));
    const bad = (e: string, d: string) => res.status(400).json({ error: e, error_description: d });
    if (!a || (b.client_secret !== a.client_secret && !(b.code_verifier && b.grant_type === "authorization_code"))) return res.status(401).json({ error: "invalid_client", error_description: "Client authentication failed" });
    if (b.grant_type === "client_credentials") {
      const t = issueToken(a.id, null, String(b.scope || "read"));
      return res.json({ access_token: t, token_type: "Bearer", scope: String(b.scope || "read"), created_at: Math.floor(now() / 1000) });
    }
    if (b.grant_type !== "authorization_code") return bad("unsupported_grant_type", "Only authorization_code and client_credentials");
    const c = db.prepare("SELECT * FROM fedi_codes WHERE code_hash = ?").get(sha256hex(String(b.code || ""))) as any;
    if (!c || c.app_id !== a.id || c.expires < now()) return bad("invalid_grant", "The code is invalid or has expired");
    if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return bad("invalid_grant", "redirect_uri doesn't match");
    if (c.challenge) {
      const v = crypto.createHash("sha256").update(String(b.code_verifier || "")).digest("base64url");
      if (v !== c.challenge) return bad("invalid_grant", "code_verifier doesn't match");
    } else if (b.client_secret !== a.client_secret) return res.status(401).json({ error: "invalid_client", error_description: "Client authentication failed" });
    db.prepare("DELETE FROM fedi_codes WHERE code_hash = ?").run(c.code_hash);
    const t = issueToken(a.id, c.account_id, c.scopes);
    res.json({ access_token: t, token_type: "Bearer", scope: c.scopes, created_at: Math.floor(now() / 1000) });
  }));
  app.post("/oauth/revoke", wrapF((req, res) => {
    const t = String(req.body?.token || "");
    if (t) {
      const h = sha256hex(t);
      db.prepare("DELETE FROM fedi_tokens WHERE token_hash = ?").run(h);
      db.prepare("DELETE FROM fedi_push WHERE token_hash = ?").run(h);
    }
    res.json({});
  }));

  // ---------- Mastodon API ----------
  registerMastodonApi(app);

  // ---------- signed-in Scute (the plug-in) ----------
  const { auth, wrap } = deps;
  const scuteApp = () => {
    let id = Number(kv("scute_app_id") || 0);
    if (!id || !db.prepare("SELECT 1 FROM fedi_apps WHERE id = ?").get(id)) {
      const r = db.prepare("INSERT INTO fedi_apps (client_id, client_secret, name, website, redirect_uris, scopes, created) VALUES (?, ?, 'Scute', NULL, 'urn:ietf:wg:oauth:2.0:oob', 'read write follow push', ?)").run(randomToken(24), randomToken(32), now());
      id = Number(r.lastInsertRowid);
      kv("scute_app_id", String(id));
    }
    return id;
  };
  const allowed = (username: string) => !FEDI_USERS.length || FEDI_USERS.includes(username.toLowerCase());
  app.get("/api/fedi", auth, wrap((req: any, res: Response) => {
    const acc = accountByUser(req.user.id);
    const q = acc ? (db.prepare("SELECT COUNT(*) c, SUM(attempts > 0) f, MAX(CASE WHEN attempts > 0 THEN error END) e FROM fedi_deliveries WHERE account_id = ?").get(acc.id) as any) : null;
    res.json({
      enabled: true,
      domain: FEDI_DOMAIN,
      url: FEDI_URL,
      allowed: allowed(req.user.username),
      version: MASTO_VERSION,
      account: acc ? accountJson(actorById(acc.id)!, { source: true }) : null,
      queue: q ? { waiting: q.c || 0, retrying: q.f || 0, lastError: q.e || null } : null,
    });
  }));
  app.post("/api/fedi/account", auth, wrap((req: any, res: Response) => {
    if (!allowed(req.user.username)) throw new FediError(403, "This server's admin hasn't allowed you a Fediverse account (SCUTE_FEDI_USERS)");
    if (accountByUser(req.user.id)) throw new FediError(409, "You already have a Fediverse account");
    const username = String(req.body?.username || "").trim().replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{1,30}$/.test(username)) throw new FediError(400, "Use 1 to 30 letters, digits or underscores");
    if (RESERVED.has(username.toLowerCase()) || kv(`gone:${username.toLowerCase()}`) || accountByName(username) || db.prepare("SELECT 1 FROM fedi_actors WHERE uri = ?").get(actorUri(username))) throw new FediError(409, "That name is taken");
    const k = newKeyPair();
    const t = now();
    const tx = db.transaction(() => {
      const r = db
        .prepare("INSERT INTO fedi_actors (uri, local, username, domain, display_name, url, inbox, shared_inbox, outbox, followers_url, following_url, featured_url, key_id, public_key, created_at, fetched) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(actorUri(username), username, FEDI_DOMAIN, String(req.body?.display_name || "").slice(0, 100), profileUrl(username), `${actorUri(username)}/inbox`, `${FEDI_URL}/inbox`, `${actorUri(username)}/outbox`, `${actorUri(username)}/followers`, `${actorUri(username)}/following`, `${actorUri(username)}/collections/featured`, `${actorUri(username)}#main-key`, k.publicKey, t, t);
      const id = Number(r.lastInsertRowid);
      db.prepare("UPDATE fedi_actors SET local = ? WHERE id = ?").run(id, id);
      db.prepare("INSERT INTO fedi_accounts (id, user_id, username, private_key, settings, created) VALUES (?, ?, ?, ?, '{}', ?)").run(id, req.user.id, username, k.privateKey, t);
      return id;
    });
    const id = tx();
    const token = issueToken(scuteApp(), id, "read write follow push");
    res.json({ account: accountJson(actorById(id)!, { source: true }), token });
  }));
  app.post("/api/fedi/token", auth, wrap((req: any, res: Response) => {
    const acc = accountByUser(req.user.id);
    if (!acc) throw new FediError(404, "No Fediverse account");
    // one token per signed-in Scute device
    const label = `scute:${String(req.tokenHash).slice(0, 16)}`;
    db.prepare("DELETE FROM fedi_tokens WHERE account_id = ? AND scopes LIKE ?").run(acc.id, `% ${label}`);
    res.json({ token: issueToken(scuteApp(), acc.id, `read write follow push ${label}`), url: FEDI_URL });
  }));
  app.get("/api/fedi/apps", auth, wrap((req: any, res: Response) => {
    const acc = accountByUser(req.user.id);
    if (!acc) return res.json([]);
    const rows = db.prepare("SELECT t.token_hash, t.created, t.last_used, t.scopes, a.name, a.website FROM fedi_tokens t JOIN fedi_apps a ON a.id = t.app_id WHERE t.account_id = ? ORDER BY COALESCE(t.last_used, t.created) DESC").all(acc.id) as any[];
    res.json(rows.map((r) => ({ id: r.token_hash.slice(0, 16), name: r.name, website: r.website, created: r.created, lastUsed: r.last_used, scopes: r.scopes.split(" ").filter((s: string) => !s.startsWith("scute:")), scute: / scute:/.test(r.scopes), push: !!db.prepare("SELECT 1 FROM fedi_push WHERE token_hash = ?").get(r.token_hash) })));
  }));
  app.delete("/api/fedi/apps/:id", auth, wrap((req: any, res: Response) => {
    const acc = accountByUser(req.user.id);
    if (!acc || !/^[0-9a-f]{16}$/.test(req.params.id)) throw new FediError(404, "Not found");
    db.prepare("DELETE FROM fedi_push WHERE account_id = ? AND token_hash LIKE ?").run(acc.id, req.params.id + "%");
    db.prepare("DELETE FROM fedi_tokens WHERE account_id = ? AND token_hash LIKE ?").run(acc.id, req.params.id + "%");
    res.json({ ok: true });
  }));
  app.post("/api/fedi/account/delete", auth, wrap((req: any, res: Response) => {
    const acc = accountByUser(req.user.id);
    if (!acc) throw new FediError(404, "No Fediverse account");
    if (String(req.body?.confirm || "") !== acc.username) throw new FediError(400, "Type the account name to confirm");
    deleteAccount(acc);
    res.json({ ok: true });
  }));

  // Fediverse errors as Mastodon apps expect them
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (!isFediPath(req.path) && !req.path.startsWith("/api/fedi")) return next(err);
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error("[fedi]", req.method, req.path, err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong" : err.message, message: err.message });
  });

  // ---------- streaming ----------
  setupStreaming(httpServer);
  bus.on("notification", ({ id }) => void sendPushFor(id).catch(() => null));

  startDeliveryLoop();
  setInterval(() => {
    try {
      pruneMedia();
      db.prepare("DELETE FROM fedi_codes WHERE expires < ?").run(now());
    } catch (e) {
      console.error("[fedi] prune", e);
    }
  }, 3600_000).unref();
  fs.mkdirSync(path.join(MEDIA_DIR, "..", "tmp"), { recursive: true });
  for (const f of fs.readdirSync(path.join(MEDIA_DIR, "..", "tmp"))) fs.rmSync(path.join(MEDIA_DIR, "..", "tmp", f), { force: true });
  console.log(`[fedi] Fediverse on as @…@${FEDI_DOMAIN} at ${FEDI_URL}`);
}

/** On the handle domain only Fediverse addresses answer (not the Scute web app or its API). */
export function fediHostGate(req: Request, res: Response, next: NextFunction) {
  if (!FEDI_ON || reqHost(req) !== FEDI_HOST || isFediPath(req.path)) return next();
  if (req.path === "/" || req.path === "") {
    const first = db.prepare("SELECT username FROM fedi_accounts ORDER BY created LIMIT 1").get() as { username: string } | undefined;
    return res.redirect(302, first ? `/@${first.username}` : "/about");
  }
  res.status(404).type("html").send(page("Not found", `<h1>Not found</h1><p><a href="/">${escapeHtml(FEDI_DOMAIN)}</a></p>`));
}

const idOfStr = (x: any) => (typeof x === "string" ? x : x?.id);

/** Remove a local account: tell everyone, then forget it. */
export function deleteAccount(acc: AccountRow) {
  const me = actorById(acc.id)!;
  // other servers remember the old key: never hand the name out again
  kv(`gone:${acc.username.toLowerCase()}`, String(now()));
  const audience = new Map<number, ActorRow>();
  for (const a of followersOf(me.id)) audience.set(a.id, a);
  for (const a of db.prepare("SELECT a.* FROM fedi_follows f JOIN fedi_actors a ON a.id = f.followee_id WHERE f.follower_id = ?").all(me.id) as ActorRow[]) audience.set(a.id, a);
  deliver(acc, { "@context": AS_CONTEXT, id: `${me.uri}#delete`, type: "Delete", actor: me.uri, to: ["https://www.w3.org/ns/activitystreams#Public"], object: me.uri }, [...audience.values()]);
  // the queued deliveries need the key: keep a signing-only stub until they're done
  const rows = db.prepare("SELECT * FROM fedi_statuses WHERE actor_id = ?").all(me.id) as StatusRow[];
  for (const r of rows) removeStatus(r);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM fedi_follows WHERE follower_id = ? OR followee_id = ?").run(me.id, me.id);
    db.prepare("DELETE FROM fedi_likes WHERE actor_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_bookmarks WHERE account_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_blocks WHERE account_id = ? OR target_id = ?").run(me.id, me.id);
    db.prepare("DELETE FROM fedi_domain_blocks WHERE account_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_home WHERE account_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_notifications WHERE account_id = ? OR from_id = ?").run(me.id, me.id);
    db.prepare("DELETE FROM fedi_tokens WHERE account_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_push WHERE account_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_markers WHERE account_id = ?").run(me.id);
    db.prepare("DELETE FROM fedi_votes WHERE account_id = ?").run(me.id);
    db.prepare("UPDATE fedi_accounts SET user_id = NULL, username = '~deleted~' || id WHERE id = ?").run(acc.id);
    db.prepare("UPDATE fedi_actors SET local = NULL, uri = uri || '#deleted', display_name = '', note = '', avatar = NULL, header = NULL WHERE id = ?").run(me.id);
  });
  tx();
  for (const m of db.prepare("SELECT * FROM fedi_media WHERE account_id = ?").all(me.id) as MediaRow[]) {
    fs.rmSync(path.join(MEDIA_DIR, String(m.id)), { recursive: true, force: true });
  }
  db.prepare("DELETE FROM fedi_media WHERE account_id = ?").run(me.id);
}

// ======================================================================
// Streaming API (WebSocket), as Mastodon's
// ======================================================================

interface Client {
  ws: WebSocket;
  accountId: number | null;
  streams: Set<string>;
}

function setupStreaming(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  httpServer.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", "http://x");
    if (!/^\/api\/v1\/streaming\/?$/.test(u.pathname)) return;
    const proto = String(req.headers["sec-websocket-protocol"] || "").split(",")[0].trim();
    const fake: any = { headers: { authorization: proto ? `Bearer ${proto}` : req.headers.authorization }, query: { access_token: u.searchParams.get("access_token") || "" } };
    const t = tokenFrom(fake);
    if ((fake.headers.authorization || fake.query.access_token) && !t) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Client = { ws, accountId: t?.account_id ?? null, streams: new Set() };
      const first = u.searchParams.get("stream");
      if (first) c.streams.add(streamKey(first, u.searchParams.get("tag") || u.searchParams.get("list")));
      clients.add(c);
      ws.on("message", (m) => {
        try {
          const j = JSON.parse(String(m));
          const key = streamKey(String(j.stream || ""), j.tag || j.list);
          if (j.type === "subscribe") c.streams.add(key);
          if (j.type === "unsubscribe") c.streams.delete(key);
        } catch {
          /* ignore */
        }
      });
      ws.on("close", () => clients.delete(c));
      ws.on("error", () => clients.delete(c));
    });
  });
  const ping = setInterval(() => {
    for (const c of clients) if (c.ws.readyState === 1) c.ws.ping();
  }, 30_000);
  ping.unref();
  const send = (c: Client, stream: string[], event: string, payload: string) => {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ stream, event, payload }));
  };
  bus.on("home", ({ accountId, statusId }) => {
    const st = statusById(statusId);
    if (!st) return;
    for (const c of clients) if (c.accountId === accountId && c.streams.has("user")) send(c, ["user"], "update", JSON.stringify(statusJson(st, accountId)));
  });
  bus.on("notification", ({ accountId, id }) => {
    const n = db.prepare("SELECT * FROM fedi_notifications WHERE id = ?").get(id);
    if (!n) return;
    for (const c of clients)
      if (c.accountId === accountId && (c.streams.has("user") || c.streams.has("user:notification"))) send(c, [c.streams.has("user") ? "user" : "user:notification"], "notification", JSON.stringify(notificationJson(n, accountId)));
  });
  bus.on("delete", (id: number) => {
    for (const c of clients) if (c.streams.size) send(c, [...c.streams][0].split(":").slice(0, 1), "delete", String(id));
  });
  bus.on("status.update", (id: number) => {
    const st = statusById(id);
    if (!st) return;
    for (const c of clients) if (c.streams.size && canSee(st, c.accountId)) send(c, [[...c.streams][0]], "status.update", JSON.stringify(statusJson(st, c.accountId)));
  });
  bus.on("public", (id: number) => {
    const st = statusById(id);
    if (!st) return;
    const tags = json(st.tags, []) as string[];
    for (const c of clients) {
      const viewer = c.accountId;
      const keys = ["public", ...(st.local ? ["public:local"] : ["public:remote"]), ...tags.map((t) => `hashtag:${t}`), ...(st.local ? tags.map((t) => `hashtag:local:${t}`) : [])];
      const hit = keys.find((k) => c.streams.has(k));
      if (hit) send(c, hit.startsWith("hashtag") ? ["hashtag", tags[0]] : [hit], "update", JSON.stringify(statusJson(st, viewer)));
    }
  });
}
function streamKey(stream: string, tag?: string | null) {
  if (stream === "hashtag" || stream === "hashtag:local") return `${stream}:${String(tag || "").toLowerCase()}`;
  if (stream === "list") return `list:${tag}`;
  return stream;
}
function scopeText(s: string) {
  const parts = s.split(/\s+/);
  const out: string[] = [];
  if (parts.some((p) => p.startsWith("read"))) out.push("read your timelines, notifications and profile");
  if (parts.some((p) => p.startsWith("write"))) out.push("post and change things as you");
  if (parts.includes("follow")) out.push("follow and block people");
  if (parts.includes("push")) out.push("send you push notifications");
  if (parts.includes("profile") && out.length === 0) out.push("see your profile");
  return out.join(", ") || "read your account";
}

export { FEDI_ON };

/** When a Scute user deletes themselves, their Fediverse account goes too. */
export function removeUserFedi(userId: string) {
  try {
    const acc = accountByUser(userId);
    if (acc) deleteAccount(acc);
  } catch (e) {
    console.warn("[fedi] couldn't remove the Fediverse account", (e as Error)?.message);
  }
}
