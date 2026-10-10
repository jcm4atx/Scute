/**
 * Encryption for shared saved copies (Scute 1.18.0), used by the app (to share)
 * and by the viewer page (to open). Same scheme as the photo album shares:
 * AES-256-GCM with a random content key, each file is iv (12 bytes) + ciphertext.
 * With a password the content key is wrapped with PBKDF2-SHA-256; with a secret
 * link it travels in the link's #fragment, which browsers never send to a server.
 */
const te = new TextEncoder();
const td = new TextDecoder();
export const PBKDF2_ITER = 600_000;

export function b64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const newContentKey = () => b64u(randomBytes(32));

export const aesKey = (raw: string | Uint8Array) => crypto.subtle.importKey("raw", buf(typeof raw === "string" ? unb64u(raw) : raw), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(key: CryptoKey, data: Uint8Array | string): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const plain = typeof data === "string" ? te.encode(data) : data;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf(plain)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}
export async function unseal(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(data.subarray(0, 12)) }, key, buf(data.subarray(12))));
}
export const unsealText = async (key: CryptoKey, data: Uint8Array) => td.decode(await unseal(key, data));

async function passwordKey(password: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey("raw", te.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export interface Wrap {
  salt: string;
  iter: number;
  sealed: string;
}
export async function wrapKey(contentKey: string, password: string): Promise<Wrap> {
  const salt = randomBytes(16);
  const k = await passwordKey(password, salt, PBKDF2_ITER);
  return { salt: b64u(salt), iter: PBKDF2_ITER, sealed: b64u(await seal(k, unb64u(contentKey))) };
}
/** The content key, or throws if the password is wrong. */
export async function unwrapKey(w: Wrap, password: string): Promise<CryptoKey> {
  const k = await passwordKey(password, unb64u(w.salt), w.iter);
  return aesKey(await unseal(k, unb64u(w.sealed)));
}

/** share.json: public, so it says nothing about what's shared. */
export interface SavedHeader {
  v: 1;
  kind: "scute-saved-copy";
  mode: "link" | "password";
  wrap?: Wrap;
  manifest: string; // encrypted Manifest
}
export interface SavedManifest {
  v: 1;
  title: string;
  kind: "page" | "image" | "video" | "audio" | "file";
  name: string; // file name for downloads
  type: string; // MIME type
  size: number;
  parts: string[]; // encrypted pieces of the file, in order
  savedAt: number;
  sharedAt: number;
  /** Shown only if the owner chose to show where it came from. */
  source?: { url: string; site?: string; uploader?: string; description?: string };
  duration?: number;
  width?: number;
  height?: number;
  download: boolean;
}
/** Pieces are at most this big, so no single upload hits a proxy's or the server's size limit. */
export const PART_BYTES = 32 * 1024 * 1024;
