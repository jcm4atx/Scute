/** A small streaming multipart/form-data parser: fields in memory, files straight to disk. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Request } from "express";

export interface UploadedFile {
  path: string;
  filename: string;
  mime: string;
  size: number;
}
export interface Multipart {
  fields: Record<string, string | string[]>;
  files: Record<string, UploadedFile>;
}

export function cleanupUploads(m: Multipart | null) {
  if (!m) return;
  for (const f of Object.values(m.files)) fs.rmSync(f.path, { force: true });
}

export function parseMultipart(req: Request, opts: { dir: string; maxFileBytes: number; maxFieldBytes?: number }): Promise<Multipart> {
  const ct = String(req.headers["content-type"] || "");
  const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!/^multipart\/form-data/i.test(ct) || !bm) return Promise.reject(Object.assign(new Error("Expected multipart/form-data"), { status: 400 }));
  const delim = Buffer.from("\r\n--" + (bm[1] || bm[2]).trim());
  const maxField = opts.maxFieldBytes ?? 1024 * 1024;
  fs.mkdirSync(opts.dir, { recursive: true });
  const out: Multipart = { fields: {}, files: {} };
  return new Promise((resolve, reject) => {
    let buf = Buffer.from("\r\n");
    let state: "start" | "headers" | "body" | "after" | "done" = "start";
    let part: { name: string; filename?: string; mime: string; fd?: number; path?: string; size: number; chunks: Buffer[] } | null = null;
    let failed = false;
    const fail = (e: any) => {
      if (failed) return;
      failed = true;
      if (part?.fd != null) fs.closeSync(part.fd);
      cleanupUploads(out);
      if (part?.path) fs.rmSync(part.path, { force: true });
      req.resume();
      reject(e);
    };
    const write = (b: Buffer) => {
      if (!part || !b.length) return;
      part.size += b.length;
      if (part.fd != null) {
        if (part.size > opts.maxFileBytes) throw Object.assign(new Error("File too large"), { status: 413 });
        fs.writeSync(part.fd, b);
      } else {
        if (part.size > maxField) throw Object.assign(new Error("Field too large"), { status: 413 });
        part.chunks.push(b);
      }
    };
    const finish = () => {
      if (!part) return;
      if (part.fd != null) {
        fs.closeSync(part.fd);
        out.files[part.name] = { path: part.path!, filename: part.filename || "file", mime: part.mime, size: part.size };
      } else {
        const v = Buffer.concat(part.chunks).toString("utf8");
        const prev = out.fields[part.name];
        out.fields[part.name] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      part = null;
    };
    const step = () => {
      for (;;) {
        if (state === "start") {
          const i = buf.indexOf(delim);
          if (i < 0) {
            if (buf.length > delim.length) buf = buf.subarray(buf.length - delim.length);
            return;
          }
          buf = buf.subarray(i + delim.length);
          state = "after";
        } else if (state === "after") {
          if (buf.length < 2) return;
          if (buf[0] === 0x2d && buf[1] === 0x2d) {
            state = "done";
            return;
          }
          const nl = buf.indexOf("\r\n");
          if (nl < 0) return;
          buf = buf.subarray(nl + 2);
          state = "headers";
        } else if (state === "headers") {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buf.length > 16384) throw Object.assign(new Error("Bad multipart headers"), { status: 400 });
            return;
          }
          const head = buf.subarray(0, end).toString("utf8");
          buf = buf.subarray(end + 4);
          const disp = head.match(/content-disposition:([^\r\n]*)/i)?.[1] || "";
          const name = disp.match(/\bname="([^"]*)"/i)?.[1] ?? disp.match(/\bname=([^;\s]+)/i)?.[1] ?? "";
          const fnStar = disp.match(/filename\*=(?:UTF-8'')?([^;\r\n]+)/i)?.[1];
          const fn = fnStar ? decodeURIComponent(fnStar.replace(/^"|"$/g, "")) : disp.match(/filename="([^"]*)"/i)?.[1];
          const mime = (head.match(/content-type:\s*([^\r\n;]*)/i)?.[1] || "application/octet-stream").trim().toLowerCase();
          part = { name, mime, size: 0, chunks: [] };
          if (fn !== undefined) {
            part.filename = path.basename(fn.replace(/\\/g, "/")) || "file";
            part.path = path.join(opts.dir, `up-${crypto.randomBytes(8).toString("hex")}`);
            part.fd = fs.openSync(part.path, "w");
          }
          state = "body";
        } else if (state === "body") {
          const i = buf.indexOf(delim);
          if (i >= 0) {
            write(buf.subarray(0, i));
            finish();
            buf = buf.subarray(i + delim.length);
            state = "after";
          } else {
            const keep = delim.length;
            if (buf.length > keep) {
              write(buf.subarray(0, buf.length - keep));
              buf = Buffer.from(buf.subarray(buf.length - keep));
            }
            return;
          }
        } else return;
      }
    };
    req.on("data", (c: Buffer) => {
      if (failed) return;
      try {
        buf = buf.length ? Buffer.concat([buf, c]) : c;
        step();
      } catch (e) {
        fail(e);
      }
    });
    req.on("end", () => {
      if (failed) return;
      if (state !== "done") return fail(Object.assign(new Error("Incomplete upload"), { status: 400 }));
      resolve(out);
    });
    req.on("error", fail);
  });
}
