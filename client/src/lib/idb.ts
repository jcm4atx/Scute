/**
 * Tiny IndexedDB key/value wrapper used for the offline cache.
 * Only ciphertext (the same blobs the server holds) and non-extractable
 * CryptoKey handles are ever written here.
 * Falls back to memory when IndexedDB is unavailable (e.g. sandboxed iframes).
 */

const DB_NAME = "scute";
const STORE = "kv";
let dbp: Promise<IDBDatabase | null> | null = null;
const mem = new Map<string, unknown>();

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return mem.get(key) as T | undefined;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(mem.get(key) as T | undefined);
    }
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) {
    mem.set(key, value);
    return;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        mem.set(key, value);
        resolve();
      };
    } catch {
      mem.set(key, value);
      resolve();
    }
  });
}

export async function idbDel(key: string): Promise<void> {
  mem.delete(key);
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function idbClearPrefix(prefix: string): Promise<void> {
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
      tx.objectStore(STORE).delete(range);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
