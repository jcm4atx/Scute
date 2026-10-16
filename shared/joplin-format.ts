// Joplin's sync item format (sync target version 3), shared by the browser
// (Joplin spaces) and the server (notebook links).
// ---------------------------------------------------------------- ids & formats
export const hexOf = (id: string) => id.replace(/-/g, "").toLowerCase();
export const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
export const randHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const iso = (ms: number) => new Date(ms || 0).toISOString();
export const isHexId = (s: string) => /^[0-9a-f]{32}$/.test(s);

export const T = { NOTE: 1, FOLDER: 2, RESOURCE: 4, TAG: 5, NOTE_TAG: 6 } as const;
export const TIME_FIELDS = new Set(["created_time", "updated_time", "user_created_time", "user_updated_time"]);

// Field order exactly as Joplin 3.x writes them.
const FIELDS: Record<number, string[]> = {
  [T.NOTE]: ["id", "parent_id", "created_time", "updated_time", "is_conflict", "latitude", "longitude", "altitude", "author", "source_url", "is_todo", "todo_due", "todo_completed", "source", "source_application", "application_data", "order", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "markup_language", "is_shared", "share_id", "conflict_original_id", "master_key_id", "user_data", "deleted_time", "is_locked", "extracted_resource_ids"],
  [T.FOLDER]: ["id", "created_time", "updated_time", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "parent_id", "is_shared", "share_id", "master_key_id", "icon", "user_data", "deleted_time"],
  [T.TAG]: ["id", "created_time", "updated_time", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "is_shared", "parent_id", "user_data"],
  [T.NOTE_TAG]: ["id", "note_id", "tag_id", "created_time", "updated_time", "user_created_time", "user_updated_time", "encryption_cipher_text", "encryption_applied", "is_shared"],
  [T.RESOURCE]: ["id", "mime", "filename", "created_time", "updated_time", "user_created_time", "user_updated_time", "file_extension", "encryption_cipher_text", "encryption_applied", "encryption_blob_encrypted", "size", "is_shared", "share_id", "master_key_id", "user_data", "blob_updated_time", "ocr_text", "ocr_details", "ocr_status", "ocr_error", "ocr_driver_id", "is_locked"],
};
const DEFAULTS: Record<string, string> = {
  is_conflict: "0", latitude: "0.00000000", longitude: "0.00000000", altitude: "0.0000", is_todo: "0", todo_due: "0",
  todo_completed: "0", source: "scute", source_application: "app.scute", markup_language: "1", encryption_applied: "0",
  encryption_blob_encrypted: "0", is_shared: "0", deleted_time: "0", is_locked: "0", ocr_status: "0", ocr_driver_id: "1",
};

export interface JItem {
  type_: number;
  title?: string;
  body?: string;
  props: Record<string, string>; // raw serialized values (times as ISO strings)
}

const escapeProp = (v: string) => v.replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const unescapeProp = (v: string) => v.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\n/g, "\\n").replace(/\\\r/g, "\\r");

/** Parse a Joplin item file (the same algorithm as BaseItem.unserialize). */
export function parseItem(content: string): JItem {
  const lines = content.split("\n");
  const props: Record<string, string> = {};
  let body: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") {
      body = lines.slice(0, i);
      break;
    }
    const p = line.indexOf(":");
    if (p < 0) throw new Error(`Invalid Joplin property line: ${line.slice(0, 60)}`);
    props[line.slice(0, p).trim()] = unescapeProp(line.slice(p + 1).trim());
  }
  // keep the original key order (bottom-up loop reversed it)
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(props).reverse()) ordered[k] = props[k];
  const type_ = Number(ordered.type_);
  if (!type_) throw new Error("Joplin item has no type_");
  const out: JItem = { type_, props: ordered };
  if (body.length) {
    out.title = body[0];
    if (type_ === T.NOTE) out.body = body.slice(2).join("\n");
  }
  return out;
}

/** Serialize a Joplin item (the same layout as BaseItem.serialize). */
export function serializeItem(it: JItem): string {
  const keys = FIELDS[it.type_] || Object.keys(it.props);
  const extra = Object.keys(it.props).filter((k) => k !== "type_" && !keys.includes(k));
  const props = [...keys, ...extra].map((k) => `${k}: ${escapeProp(it.props[k] ?? DEFAULTS[k] ?? "")}`);
  props.push(`type_: ${it.type_}`);
  const parts: string[] = [];
  if (it.type_ !== T.NOTE_TAG) parts.push((it.title || "").replace(/[\r\n]+/g, " "));
  if (it.type_ === T.NOTE && it.body) parts.push(it.body);
  parts.push(props.join("\n"));
  return parts.join("\n\n");
}

export const timeOf = (it: JItem, k = "updated_time") => {
  const v = it.props[k];
  if (!v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : Number(v) || 0;
};


// ---------------------------------------------------------------- hashing
export function fnv(s: string) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function sniffMime(b: Uint8Array): string | null {
  const h = (n: number) => Array.from(b.slice(0, n), (x) => x.toString(16).padStart(2, "0")).join("");
  if (h(3) === "ffd8ff") return "image/jpeg";
  if (h(8) === "89504e470d0a1a0a") return "image/png";
  if (h(4) === "47494638") return "image/gif";
  if (h(4) === "52494646" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (h(4) === "25504446") return "application/pdf";
  if (String.fromCharCode(...b.slice(4, 8)) === "ftyp") return "video/mp4";
  return null;
}


// Joplin's own info.json for a freshly created (empty) sync target.
export const FRESH_INFO = {
  version: 3,
  e2ee: { value: false, updatedTime: 0 },
  activeMasterKeyId: { value: "", updatedTime: 0 },
  masterKeys: [],
  noteLockKey: null,
  ppk: { value: null, updatedTime: 0 },
  appMinVersion: "3.7.0",
  revisionServiceEnabled: { value: true, updatedTime: 0 },
  revisionServiceTtlDays: { value: 90, updatedTime: 0 },
};

