/**
 * Scute client-side cryptography (WebCrypto only, no dependencies).
 *
 *  password + salt --PBKDF2-SHA256 (600k)--> 512 bits
 *     first 256 bits  -> authKey  (sent to server, server re-hashes with scrypt)
 *     second 256 bits -> KEK      (never leaves the browser)
 *  KEK wraps a random 256-bit master key (AES-GCM).
 *  master key wraps the user's ECDH P-256 private key.
 *  Each space has a random key, sealed to each member's ECDH public key.
 *  Each note has its own random key, wrapped with its space key.
 *  Note data / board data / space data are AES-256-GCM encrypted JSON.
 */

const subtle = () => {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "WebCrypto is unavailable. Scute must be served over HTTPS (or http://localhost) for encryption to work.",
    );
  }
  return globalThis.crypto.subtle;
};

export const KDF_ITER = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}
export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function deriveFromPassword(password: string, saltB64: string, iter: number) {
  const base = await subtle().importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = new Uint8Array(
    await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations: iter }, base, 512),
  );
  const authKey = toB64(bits.slice(0, 32));
  const kek = await subtle().importKey("raw", bits.slice(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { authKey, kek };
}

export async function newAesKey(extractable = true): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}
export async function importAesRaw(raw: Uint8Array, extractable = true): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"]);
}
export async function exportRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey("raw", key));
}

// v1 binary format: [0x01][12-byte IV][ciphertext+tag]
export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}
export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data[0] !== 1) throw new Error("Unknown ciphertext version");
  const iv = data.slice(1, 13);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, key, data.slice(13)));
}
export async function encryptJson(key: CryptoKey, obj: unknown): Promise<string> {
  return toB64(await encryptBytes(key, enc.encode(JSON.stringify(obj))));
}
export async function decryptJson<T>(key: CryptoKey, b64: string): Promise<T> {
  return JSON.parse(dec.decode(await decryptBytes(key, fromB64(b64)))) as T;
}
export async function wrapKey(wrapping: CryptoKey, key: CryptoKey): Promise<string> {
  return toB64(await encryptBytes(wrapping, await exportRaw(key)));
}
export async function unwrapKey(wrapping: CryptoKey, b64: string, extractable = true): Promise<CryptoKey> {
  return importAesRaw(await decryptBytes(wrapping, fromB64(b64)), extractable);
}

// ---------- asymmetric (ECDH P-256 "sealed box") ----------
export async function newKeyPair() {
  return subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]) as Promise<CryptoKeyPair>;
}
export async function exportPublic(k: CryptoKey): Promise<string> {
  return toB64(await subtle().exportKey("spki", k));
}
export async function importPublic(b64: string): Promise<CryptoKey> {
  return subtle().importKey("spki", fromB64(b64), { name: "ECDH", namedCurve: "P-256" }, true, []);
}
export async function wrapPrivate(master: CryptoKey, priv: CryptoKey): Promise<string> {
  const pk = new Uint8Array(await subtle().exportKey("pkcs8", priv));
  return toB64(await encryptBytes(master, pk));
}
export async function unwrapPrivate(master: CryptoKey, b64: string): Promise<CryptoKey> {
  const pk = await decryptBytes(master, fromB64(b64));
  return subtle().importKey("pkcs8", pk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
}

async function ecdhAes(priv: CryptoKey, pub: CryptoKey) {
  return subtle().deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Seal a symmetric key so only the holder of `recipientPubB64`'s private key can open it. */
export async function sealKey(recipientPubB64: string, key: CryptoKey): Promise<string> {
  const recipient = await importPublic(recipientPubB64);
  const eph = await newKeyPair();
  const shared = await ecdhAes(eph.privateKey, recipient);
  const ct = await encryptBytes(shared, await exportRaw(key));
  const epk = new Uint8Array(await subtle().exportKey("raw", eph.publicKey)); // 65 bytes
  const out = new Uint8Array(1 + epk.length + ct.length);
  out[0] = 2;
  out.set(epk, 1);
  out.set(ct, 1 + epk.length);
  return toB64(out);
}
export async function openSealedKey(priv: CryptoKey, b64: string): Promise<CryptoKey> {
  const data = fromB64(b64);
  if (data[0] !== 2) throw new Error("Unknown sealed-key version");
  const epkRaw = data.slice(1, 66);
  const epk = await subtle().importKey("raw", epkRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await ecdhAes(priv, epk);
  return importAesRaw(await decryptBytes(shared, data.slice(66)), true);
}

/** Short, human-comparable fingerprint of a public key (for verifying shares). */
export async function fingerprint(pubB64: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", fromB64(pubB64)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("").replace(/(.{4})/g, "$1 ").trim();
}

// ---------- account bootstrap ----------
export async function createAccountMaterial(password: string) {
  const salt = toB64(randomBytes(16));
  const { authKey, kek } = await deriveFromPassword(password, salt, KDF_ITER);
  const master = await newAesKey(true);
  const pair = await newKeyPair();
  return {
    kdfSalt: salt,
    kdfIter: KDF_ITER,
    authKey,
    encMaster: await wrapKey(kek, master),
    publicKey: await exportPublic(pair.publicKey),
    encPrivate: await wrapPrivate(master, pair.privateKey),
    master,
    privateKey: pair.privateKey,
  };
}
