/**
 * Web Push for Mastodon apps (RFC 8030/8291/8292): the apps' push relays get
 * encrypted notifications, so phones hear about mentions and follows without
 * keeping a connection open. Both encodings are supported: "aesgcm" (what
 * Mastodon sends unless the app asks for the standard) and "aes128gcm".
 */
import crypto from "node:crypto";
import { db } from "../storage";
import { FEDI_URL, FEDI_DOMAIN, kv, json, now, checkRemote, UA, htmlToText, actorById, statusById } from "./core";

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");

export function vapidKeys() {
  let priv = kv("vapid_private");
  let pub = kv("vapid_public");
  if (!priv || !pub) {
    const k = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = k.publicKey.export({ format: "jwk" }) as any;
    pub = kv("vapid_public", b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])));
    priv = kv("vapid_private", k.privateKey.export({ format: "pem", type: "pkcs8" }) as string);
  }
  return { priv, pub };
}

function vapidJwt(endpoint: string) {
  const { priv } = vapidKeys();
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now() / 1000) + 12 * 3600, sub: `mailto:admin@${FEDI_DOMAIN}` })));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: priv, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
};

/** Encrypt a payload for one subscription. */
export function encryptPush(payload: Buffer, p256dh: string, auth: string, standard: boolean) {
  const ua = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const as = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(ua);
  const salt = crypto.randomBytes(16);
  if (standard) {
    const ikm = hkdf(authSecret, secret, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32);
    const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
    const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
    const ct = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);
    return { body: Buffer.concat([salt, rs, Buffer.from([as.length]), as, ct]), headers: { "Content-Encoding": "aes128gcm" } as Record<string, string> };
  }
  const ikm = hkdf(authSecret, secret, Buffer.from("Content-Encoding: auth\0"), 32);
  const len = (b: Buffer) => {
    const x = Buffer.alloc(2);
    x.writeUInt16BE(b.length);
    return x;
  };
  const context = Buffer.concat([Buffer.from("P-256\0"), len(ua), ua, len(as), as]);
  const cek = hkdf(salt, ikm, Buffer.concat([Buffer.from("Content-Encoding: aesgcm\0"), context]), 16);
  const nonce = hkdf(salt, ikm, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), context]), 12);
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.alloc(2), payload])), c.final(), c.getAuthTag()]);
  return { body: ct, headers: { "Content-Encoding": "aesgcm", Encryption: `salt=${b64u(salt)}`, "Crypto-Key": `dh=${b64u(as)}` } as Record<string, string> };
}

export interface PushRow {
  token_hash: string;
  account_id: number;
  access_token: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  alerts: string;
  policy: string;
  standard: number;
  created: number;
}

export function pushJson(p: PushRow) {
  return { id: p.created, endpoint: p.endpoint, standard: !!p.standard, alerts: json(p.alerts, {}), policy: p.policy, server_key: vapidKeys().pub };
}

const TITLES: Record<string, (n: string) => string> = {
  mention: (n) => `${n} mentioned you`,
  status: (n) => `${n} just posted`,
  reblog: (n) => `${n} boosted your post`,
  follow: (n) => `${n} followed you`,
  follow_request: (n) => `${n} wants to follow you`,
  favourite: (n) => `${n} favourited your post`,
  poll: () => "A poll has ended",
  update: (n) => `${n} edited a post`,
};

export async function sendPushFor(notificationId: number) {
  const n = db.prepare("SELECT * FROM fedi_notifications WHERE id = ?").get(notificationId) as any;
  if (!n) return;
  const subs = db.prepare("SELECT * FROM fedi_push WHERE account_id = ?").all(n.account_id) as PushRow[];
  if (!subs.length) return;
  const from = actorById(n.from_id);
  const name = from?.display_name || from?.username || "Someone";
  const st = n.status_id ? statusById(n.status_id) : null;
  for (const s of subs) {
    const alerts = json(s.alerts, {});
    if (!alerts[n.type]) continue;
    if (s.policy === "none") continue;
    if (s.policy === "followed" || s.policy === "follower") {
      const rel = s.policy === "followed" ? [n.account_id, n.from_id] : [n.from_id, n.account_id];
      if (!db.prepare("SELECT 1 FROM fedi_follows WHERE follower_id = ? AND followee_id = ? AND state = 'accepted'").get(...rel)) continue;
    }
    const payload = {
      access_token: s.access_token,
      preferred_locale: "en",
      notification_id: String(n.id),
      notification_type: n.type,
      icon: from?.avatar || `${FEDI_URL}/fedi/static/avatar.png`,
      title: (TITLES[n.type] || ((x: string) => x))(name),
      body: st ? htmlToText(st.spoiler || st.content).slice(0, 140) : "",
    };
    try {
      const u = new URL(s.endpoint);
      await checkRemote(u);
      const enc = encryptPush(Buffer.from(JSON.stringify(payload)), s.p256dh, s.auth, !!s.standard);
      const jwt = vapidJwt(s.endpoint);
      const headers: Record<string, string> = { ...enc.headers, TTL: "172800", Urgency: "normal", "Content-Type": "application/octet-stream", "User-Agent": UA };
      if (s.standard) headers.Authorization = `vapid t=${jwt}, k=${vapidKeys().pub}`;
      else {
        headers.Authorization = `WebPush ${jwt}`;
        headers["Crypto-Key"] += `;p256ecdsa=${vapidKeys().pub}`;
      }
      const r = await fetch(s.endpoint, { method: "POST", headers, body: enc.body });
      if (r.status === 404 || r.status === 410) db.prepare("DELETE FROM fedi_push WHERE token_hash = ?").run(s.token_hash);
    } catch (e) {
      console.warn("[fedi] push failed", String((e as Error)?.message || e));
    }
  }
}
