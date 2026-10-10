/**
 * Web fetcher for bookmarks: link previews and saved copies ("archive").
 *
 * Browsers can't read other sites (CORS), so the client asks the server to GET a
 * URL and hand back the raw bytes. Everything else (parsing the page, inlining
 * its styles and images, making thumbnails) happens in the browser, and the
 * result is encrypted there like any other attachment. The server keeps
 * nothing: it only sees which URL was fetched.
 *
 *   SCUTE_ARCHIVE=off           turn the fetcher off (no previews, no saved copies)
 *   SCUTE_ARCHIVE_PRIVATE=on    also allow private/LAN addresses (off by default,
 *                               so users can't use the server to probe your network)
 *   SCUTE_ARCHIVE_MAX_MB        largest single download (default: SCUTE_MAX_UPLOAD_MB)
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";
import dns from "node:dns/promises";
import net from "node:net";

const off = (v: string | undefined, dflt: boolean) => (v == null || v === "" ? dflt : !["off", "0", "false", "no"].includes(v.toLowerCase()));
export const WEB_ON = off(process.env.SCUTE_ARCHIVE, true);
const ALLOW_PRIVATE = off(process.env.SCUTE_ARCHIVE_PRIVATE, false);
const MAX_MB = Number(process.env.SCUTE_ARCHIVE_MAX_MB || process.env.SCUTE_MAX_UPLOAD_MB || 200);
const TIMEOUT_MS = 45_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Scute";

function privateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
export function privateIp(ip: string) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
}

export async function checkHost(u: URL, HttpError: any) {
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only http:// and https:// links can be fetched");
  if (u.username || u.password) throw new HttpError(400, "Links with a user name or password can't be fetched");
  if (ALLOW_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new HttpError(403, `${host} is a local address; the server only fetches public sites (SCUTE_ARCHIVE_PRIVATE=on allows it)`);
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new HttpError(502, `Couldn't find ${host}`);
    }
  }
  if (addrs.some(privateIp)) throw new HttpError(403, `${host} points to a private address; the server only fetches public sites (SCUTE_ARCHIVE_PRIVATE=on allows it)`);
}

export function registerWebRoutes(
  app: Express,
  { auth, wrap, HttpError }: { auth: RequestHandler; wrap: (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) => RequestHandler; HttpError: any },
) {
  /**
   * GET a public URL on the client's behalf.
   * Body: { url, maxBytes?, partial?, accept?, headers? }. partial=true returns the first maxBytes
   * (for sniffing a page's <head> or a video's first frames) instead of failing.
   * The body streams back; headers carry X-Final-Url, X-Upstream-Status,
   * X-Upstream-Type and X-Upstream-Length.
   */
  app.post(
    "/api/web/fetch",
    auth,
    express.json({ limit: "64kb" }),
    wrap(async (req, res) => {
      if (!WEB_ON) throw new HttpError(403, "Fetching web pages is off on this server (SCUTE_ARCHIVE=off)");
      const b = req.body || {};
      let u: URL;
      try {
        u = new URL(String(b.url || ""));
      } catch {
        throw new HttpError(400, "That isn't a valid link");
      }
      const cap = MAX_MB * 1024 * 1024;
      const max = Math.max(1024, Math.min(cap, Number(b.maxBytes) || cap));
      const partial = !!b.partial;
      // Extra request headers (plug-in API 4), e.g. an API key for a public web API.
      const extra: Record<string, string> = {};
      if (b.headers && typeof b.headers === "object") {
        for (const [k, v] of Object.entries(b.headers).slice(0, 16)) {
          if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || /^(host|cookie|connection|content-length|transfer-encoding|te|upgrade|range|user-agent|proxy-.*|x-forwarded-.*|forwarded|via)$/i.test(k)) continue;
          if (typeof v === "string" && v.length <= 4096 && !/[\r\n]/.test(v)) extra[k] = v;
        }
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      res.on("close", () => ctl.abort());
      let r: globalThis.Response | null = null;
      try {
        // follow redirects by hand so every hop is checked
        for (let hop = 0; hop < 8; hop++) {
          await checkHost(u, HttpError);
          r = await fetch(u.href, {
            redirect: "manual",
            signal: ctl.signal,
            headers: {
              "User-Agent": UA,
              Accept: String(b.accept || "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8"),
              "Accept-Language": String(req.headers["accept-language"] || "en;q=0.9"),
              ...(partial ? { Range: `bytes=0-${max - 1}` } : {}),
              ...extra,
            },
          });
          const loc = r.headers.get("location");
          if (r.status >= 300 && r.status < 400 && loc) {
            r.body?.cancel().catch(() => {});
            u = new URL(loc, u);
            r = null;
            continue;
          }
          break;
        }
      } catch (e) {
        clearTimeout(timer);
        const err = e instanceof HttpError ? e : new HttpError(502, `Couldn't reach ${u.host}: ${((e as Error).cause as Error)?.message || (e as Error).message}`);
        console.warn(`[web] ${u.href.slice(0, 200)}: ${err.message}`);
        throw err;
      }
      if (!r) {
        clearTimeout(timer);
        throw new HttpError(502, "Too many redirects");
      }
      const len = Number(r.headers.get("content-length") || 0);
      const whole = r.status === 206 ? Number((r.headers.get("content-range") || "").split("/")[1]) || 0 : len;
      if (!partial && len > max) {
        r.body?.cancel().catch(() => {});
        clearTimeout(timer);
        throw new HttpError(413, `That file is ${Math.round(len / 1048576)} MB; this server saves up to ${Math.round(max / 1048576)} MB (SCUTE_ARCHIVE_MAX_MB)`);
      }
      res.status(200);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Final-Url", encodeURI(u.href));
      res.setHeader("X-Upstream-Status", String(r.status));
      res.setHeader("X-Upstream-Type", r.headers.get("content-type") || "");
      if (whole) res.setHeader("X-Upstream-Length", String(whole));
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      let got = 0;
      try {
        if (r.body) {
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const room = max - got;
            if (value.length >= room) {
              res.write(Buffer.from(value.subarray(0, room)));
              got = max;
              reader.cancel().catch(() => {});
              break;
            }
            res.write(Buffer.from(value));
            got += value.length;
          }
        }
      } catch {
        /* client left or upstream broke */
      } finally {
        clearTimeout(timer);
        res.end();
      }
    }),
  );
}
