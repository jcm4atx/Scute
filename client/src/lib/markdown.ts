import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Source transforms added by plug-ins (output is still sanitised below). */
let transforms: ((src: string) => string)[] = [];
export function setMarkdownTransforms(fns: ((src: string) => string)[]) {
  transforms = fns;
}

export function renderMarkdown(src: string): string {
  let text = src || "";
  for (const t of transforms) {
    const out = t(text);
    if (typeof out === "string") text = out;
  }
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function plainExcerpt(src: string, max = 280): string {
  const t = (src || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~\-\[\]()!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** A Joplin resource referenced from a note body ("![x](:/id)", "<img src=":/id">", "[x](:/id)"). */
export interface JoplinRef {
  id: string;
  image: boolean;
  name: string;
}

const RES_ID = "([0-9a-fA-F]{32})";
/** Extracts the 32-hex resource id from ":/<id>", ":/<id>#frag", "joplin://<id>" etc. */
export function resourceIdOf(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /^\s*<?(?::\/|joplin:\/\/(?:resource\/)?)([0-9a-fA-F]{32})/.exec(href);
  return m ? m[1].toLowerCase() : null;
}

/** All Joplin resources a note body references, in order, without duplicates. */
export function joplinRefs(src: string): JoplinRef[] {
  const out: JoplinRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    `(!?)\\[([^\\]]*)\\]\\(\\s*<?:\\/${RES_ID}[^)]*\\)|<img\\b[^>]*?\\bsrc\\s*=\\s*["']:\\/${RES_ID}[^>]*>|<a\\b[^>]*?\\bhref\\s*=\\s*["']:\\/${RES_ID}[^>]*>([^<]*)`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src || ""))) {
    const id = (m[3] || m[4] || m[5]).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (m[3]) out.push({ id, image: m[1] === "!", name: m[2] });
    else if (m[4]) out.push({ id, image: true, name: (/\balt\s*=\s*["']([^"']*)/i.exec(m[0]) || [])[1] || "" });
    else out.push({ id, image: false, name: (m[6] || "").trim() });
  }
  return out;
}
