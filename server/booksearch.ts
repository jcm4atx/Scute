// Book search: finds ebooks on an IRC network (IRCHighway's #ebooks by default)
// and fetches them for the Library, the way OpenBooks does.
//
// The browser can't speak IRC, so the server keeps one IRC connection per Scute
// user while they're searching (closed again after a few idle minutes):
//
//   search    "@search <words>" in the channel; the search bot answers with a
//             DCC SEND of a zipped text file, one "!server file ::INFO:: size" per line
//   download  the chosen "!server file" line in the channel; that server answers
//             with a DCC SEND of the book (sometimes a .zip or .rar)
//
// DCC files are fetched by connecting out to the address the bot gives (no ports
// need opening here). Files wait under $SCUTE_LIBRARY_DIR/.irc/<user>/ until the
// Library plug-in picks them up and adds them like any other upload.
//
// SCUTE_BOOKSEARCH          admins (default) | all | off
// SCUTE_BOOKSEARCH_SERVER   irc.irchighway.net:6697 (TLS when the port is 6697 or 7000, or SCUTE_BOOKSEARCH_TLS=on)
// SCUTE_BOOKSEARCH_CHANNEL  #ebooks
// SCUTE_BOOKSEARCH_BOT      search (the nick that answers @search)

import type { Express } from "express";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { unzipSync } from "fflate";
import { privateIp } from "./web";
import type { UserRow as User } from "./storage";

const MODE_RAW = (process.env.SCUTE_BOOKSEARCH || "admins").toLowerCase();
export const BOOKSEARCH_MODE: "admins" | "all" | "off" = ["off", "0", "false", "no"].includes(MODE_RAW) ? "off" : ["all", "everyone", "on", "1", "true", "yes"].includes(MODE_RAW) ? "all" : "admins";
const [IRC_HOST, IRC_PORT_S] = (process.env.SCUTE_BOOKSEARCH_SERVER || "irc.irchighway.net:6697").split(/:(?=\d+$)/);
const IRC_PORT = Number(IRC_PORT_S || 6697);
const TLS_ON = process.env.SCUTE_BOOKSEARCH_TLS ? !["off", "0", "false", "no"].includes(process.env.SCUTE_BOOKSEARCH_TLS.toLowerCase()) : [6697, 7000, 9999].includes(IRC_PORT);
const CHANNEL = process.env.SCUTE_BOOKSEARCH_CHANNEL || "#ebooks";
const SEARCH_BOT = (process.env.SCUTE_BOOKSEARCH_BOT || "search").toLowerCase();
const MAX_CONNECTIONS = 3; // IRC networks limit connections per address
const IDLE_MS = 10 * 60_000;
const KEEP_MS = 60 * 60_000; // finished jobs (and their files) are kept this long
const SEARCH_TIMEOUT = 3 * 60_000;
const DOWNLOAD_TIMEOUT = 12 * 60_000; // servers queue requests
const OFFLINE_TIMEOUT = 2 * 60_000;
const STALL_MS = 90_000;
const MAX_RESULTS = 5000;

type Status = "queued" | "sent" | "receiving" | "done" | "error";
export interface Result {
  bot: string;
  command: string;
  file: string;
  title: string;
  author: string;
  series: string | null;
  format: string;
  archive: string | null;
  size: number | null;
  sizeText: string;
}
interface Job {
  id: string;
  kind: "search" | "download";
  query?: string;
  command?: string;
  bot?: string;
  label: string;
  title?: string;
  author?: string;
  status: Status;
  message: string;
  received: number;
  size: number;
  name: string;
  created: number;
  finished: number;
  results?: Result[];
  matches?: number;
  file?: string;
  timer?: NodeJS.Timeout;
  sock?: net.Socket;
}

const strip = (s: string) => s.replace(/\x03(\d{1,2}(,\d{1,2})?)?|[\x02\x0f\x16\x1d\x1e\x1f]/g, "").trim();
const lc = (s: string) => s.toLowerCase();
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const BOOKISH = /^(epub|kepub|mobi|azw|azw3|kfx|pdf|cbz|cbr|cb7|fb2|djvu|txt|rtf|html?|docx|doc|odt|lit|pdb|lrf|chm)$/;

/** One line of a search results file. */
export function parseResult(raw: string): Result | null {
  const line = raw.replace(/\s+$/, "");
  if (!line.startsWith("!")) return null;
  const [head, ...info] = line.split(/\s*::INFO::\s*/i);
  const command = head.split(/\s*::HASH::/i)[0].trim();
  const sp = command.indexOf(" ");
  if (sp < 2) return null;
  const bot = command.slice(1, sp);
  let file = command.slice(sp + 1).trim();
  file = file.replace(/^[0-9a-f]{8,}\s*\|\s*/i, "").replace(/^%[0-9a-f]+%\s*/i, "").replace(/^[A-Za-z0-9+/]{20,24}={0,2}\s+-\s+/, "").trim();
  // "Author - Title [eng]  (EPUB) 277.7 KB - [tags]" (no file name, no ::INFO::)
  let tagged: string | null = null;
  let sizeText = (info.join(" ").split(/::HASH::/i)[0] || "").trim();
  const tm = file.match(/^(.*?)\s+\(([A-Za-z0-9]{2,5})\)\s+([\d.,]+\s*[KMG]?i?B)\s*(?:-\s*\[.*)?$/i);
  if (tm) {
    file = tm[1].trim();
    tagged = tm[2].toLowerCase();
    sizeText ||= tm[3];
  }
  if (!file) return null;
  const sm = sizeText.match(/([\d.,]+)\s*(B|KB|KIB|MB|MIB|GB|GIB)\b/i);
  const size = sm ? Math.round(parseFloat(sm[1].replace(",", ".")) * ({ b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 } as Record<string, number>)[sm[2].toLowerCase()]) : null;
  const ext = tagged || (file.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toLowerCase();
  let format = ext;
  let archive: string | null = null;
  if (/^(rar|zip|7z)$/.test(ext)) {
    archive = ext;
    const inner = file.match(/[([](epub|kepub|mobi|azw3?|pdf|cbz|cbr|fb2|djvu|txt|rtf|lit|pdb|docx?)[)\]][^()[\]]*\.(rar|zip|7z)$/i) || file.match(/\.(epub|mobi|azw3?|pdf|fb2|lit|pdb)\.(rar|zip|7z)$/i);
    format = inner ? inner[1].toLowerCase() : ext;
  }
  let name = (tagged ? file : file.replace(/\.[a-z0-9]{2,5}$/i, "")).replace(/\.(epub|mobi|azw3?|pdf|fb2)$/i, "").replace(/\s*\[(eng?|english|[a-z]{2,3})\]\s*$/i, "");
  name = name.replace(/\s*[([](retail|epub|mobi|azw3|pdf|v\d[\d.]*|html|lit|rtf)[)\]]\s*/gi, " ").replace(/\s{2,}/g, " ").trim();
  // "Author - Title", "Author - [Series 03] - Title", sometimes "Title - Author" (sorted out per server below)
  const parts = name.split(/ +- +/).map((x) => x.trim()).filter(Boolean);
  let series: string | null = null;
  const si = parts.findIndex((x, i) => i > 0 && /^[\[(].+[\])]$/.test(x));
  if (si > 0 && parts.length > 2) series = parts.splice(si, 1)[0].slice(1, -1).trim();
  else if (parts.length >= 2 && /^[\[(].+[\])]$/.test(parts[0])) series = parts.shift()!.slice(1, -1).trim();
  let author = "";
  let title = name;
  if (parts.length >= 2) {
    author = parts[0].replace(/_/g, " ");
    title = parts.slice(1).join(" - ");
  } else if (parts.length === 1) title = parts[0];
  return { bot, command, file, title: title || file, author, series, format, archive, size, sizeText };
}

export function parseResults(text: string): Result[] {
  const out: Result[] = [];
  const seen = new Set<string>();
  for (const l of text.split(/\r?\n/)) {
    const r = parseResult(l);
    if (!r || seen.has(r.command)) continue;
    seen.add(r.command);
    out.push(r);
    if (out.length >= MAX_RESULTS) break;
  }
  // Some servers name files "Title - Author". Vote per server on which side looks like a person.
  const vote = new Map<string, number>();
  for (const r of out) {
    if (!r.author) continue;
    const a = nameLike(r.author);
    const t = nameLike(r.title);
    if (a !== t) vote.set(r.bot, (vote.get(r.bot) || 0) + (t ? 1 : -1));
  }
  for (const r of out) {
    if (!r.author) continue;
    const v = vote.get(r.bot) || 0;
    if (!nameLike(r.author) && (nameLike(r.title) || v > 0)) [r.author, r.title] = [r.title.replace(/_/g, " "), r.author];
    // "Austen, Jane" → "Jane Austen"
    r.author = r.author.replace(/^([^,&;]+), ([^,&;]+)$/, "$2 $1");
  }
  return out;
}

/** "Jane Austen", "Le Guin, Ursula K.", "J. R. R. Tolkien", "Frank Herbert & Brian Herbert" */
function nameLike(s: string): boolean {
  const x = s.replace(/\s*\[[a-z]{2,3}\]$/i, "").trim();
  if (/\d|[\[\]()!?:]/.test(x)) return false;
  return x.split(/\s*(?:&|;| and |, (?=[A-Z][a-z]+ [A-Z]))\s*/).every((one) => {
    const p = one.trim();
    if (/^[A-Z][\p{L}'’-]+, ([A-Z][\p{L}'’.-]*\.? ?){1,3}$/u.test(p)) return true;
    const w = p.split(/\s+/);
    return w.length >= 2 && w.length <= 4 && w.every((t) => /^(\p{Lu}[\p{L}'’-]*\.?|\p{Lu}\.(\p{Lu}\.)*|de|van|von|der|le|la|du|da|di|del|St\.)$/u.test(t)) && /\p{Ll}{2}/u.test(w[w.length - 1]);
  });
}

/** The text of a results file (it usually arrives zipped). */
function resultsText(buf: Buffer): string {
  let data: Uint8Array = buf;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const files = unzipSync(buf);
    const name = Object.keys(files).find((n) => /\.txt$/i.test(n)) || Object.keys(files)[0];
    if (!name) throw new Error("The results file was empty");
    data = files[name];
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

function dccAddress(s: string): string | null {
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0 || n > 0xffffffff) return null;
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  return net.isIP(s) ? s : null;
}

function validNick(s: string): string {
  let n = (s || "").replace(/[^A-Za-z0-9_\-\[\]\\^{}|`]/g, "");
  if (!/^[A-Za-z\[\]\\^{}|`_]/.test(n)) n = "r" + n;
  return n.slice(0, 16) || "reader" + Math.floor(Math.random() * 9000 + 1000);
}

class Irc {
  nick: string;
  base: string;
  state: "connecting" | "ready" | "closed" = "connecting";
  error = "";
  members = new Map<string, string>();
  jobs = new Map<string, Job>();
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private out: string[] = [];
  private lastSay = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private search: Job | null = null;
  private registered = false;
  lastUse = Date.now();
  private idle: NodeJS.Timeout;

  constructor(
    readonly uid: string,
    nick: string,
    private dir: string,
    private maxBytes: number,
    private onClose: () => void,
  ) {
    this.base = this.nick = validNick(nick);
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.ready.catch(() => {});
    const opts = { host: IRC_HOST, port: IRC_PORT };
    this.sock = TLS_ON ? tls.connect({ ...opts, servername: IRC_HOST, rejectUnauthorized: false }) : net.connect(opts);
    this.sock.setTimeout(5 * 60_000);
    this.sock.on(TLS_ON ? "secureConnect" : "connect", () => {
      this.raw(`NICK ${this.nick}`);
      this.raw(`USER ${this.nick} 0 * :Scute reader`);
    });
    this.sock.on("data", (d: Buffer) => this.data(d));
    this.sock.on("timeout", () => this.raw("PING :scute"));
    this.sock.on("error", (e) => this.fail(`Couldn't talk to ${IRC_HOST}: ${e.message}`));
    this.sock.on("close", () => this.fail(this.error || "The IRC connection closed"));
    const t = setTimeout(() => this.state === "connecting" && this.fail(`${IRC_HOST} didn't let us into ${CHANNEL} within 45 seconds`), 45_000);
    t.unref?.();
    this.idle = setInterval(() => {
      const busy = [...this.jobs.values()].some((j) => j.status !== "done" && j.status !== "error");
      if (!busy && Date.now() - this.lastUse > IDLE_MS) this.quit("idle");
      this.expire();
    }, 30_000);
    this.idle.unref?.();
  }

  whenReady() {
    return this.ready;
  }

  private raw(line: string) {
    if (!this.sock.destroyed) this.sock.write(line.replace(/[\r\n]/g, " ") + "\r\n");
  }
  /** Channel messages are spaced out so the network doesn't take us for a flood. */
  private say(text: string) {
    this.out.push(`PRIVMSG ${CHANNEL} :${text}`);
    this.flush();
  }
  private flush() {
    if (this.flushTimer || !this.out.length) return;
    const wait = Math.max(0, this.lastSay + 2500 - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const l = this.out.shift();
      if (l) {
        this.raw(l);
        this.lastSay = Date.now();
      }
      this.flush();
    }, wait);
  }

  private data(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 1 << 20) this.buf = Buffer.alloc(0);
    let i;
    while ((i = this.buf.indexOf(10)) >= 0) {
      const line = this.buf.subarray(0, i).toString("utf8").replace(/\r$/, "");
      this.buf = this.buf.subarray(i + 1);
      if (line) this.line(line);
    }
  }

  private line(line: string) {
    let prefix = "";
    let rest = line;
    if (rest[0] === ":") {
      const i = rest.indexOf(" ");
      prefix = rest.slice(1, i < 0 ? undefined : i);
      rest = i < 0 ? "" : rest.slice(i + 1);
    }
    const p: string[] = [];
    while (rest) {
      if (rest[0] === ":") {
        p.push(rest.slice(1));
        break;
      }
      const i = rest.indexOf(" ");
      if (i < 0) {
        p.push(rest);
        break;
      }
      p.push(rest.slice(0, i));
      rest = rest.slice(i + 1).replace(/^ +/, "");
    }
    const cmd = (p.shift() || "").toUpperCase();
    const from = prefix.split("!")[0];
    switch (cmd) {
      case "PING":
        return this.raw(`PONG :${p[0] || ""}`);
      case "001":
        this.registered = true;
        this.nick = p[0] || this.nick;
        return;
      case "433":
      case "432":
        if (!this.registered) {
          this.nick = validNick(this.base.slice(0, 11) + Math.floor(Math.random() * 9000 + 1000));
          this.raw(`NICK ${this.nick}`);
        }
        return;
      case "376":
      case "422":
        return this.raw(`JOIN ${CHANNEL}`);
      case "353":
        for (const n of (p[3] || "").split(" ")) {
          const x = n.replace(/^[~&@%+]+/, "");
          if (x) this.members.set(lc(x), x);
        }
        return;
      case "366":
        if (this.state === "connecting") {
          this.state = "ready";
          this.resolveReady();
          this.next();
        }
        return;
      case "471":
      case "473":
      case "474":
      case "475":
      case "477":
        return this.fail(`${IRC_HOST} wouldn't let us into ${CHANNEL}: ${strip(p[2] || p[1] || cmd)}`);
      case "JOIN":
        if (lc(p[0] || "") === lc(CHANNEL)) this.members.set(lc(from), from);
        return;
      case "PART":
      case "QUIT":
        this.members.delete(lc(from));
        return;
      case "KICK":
        if (lc(p[1] || "") === lc(this.nick)) return this.fail(`Removed from ${CHANNEL}: ${strip(p[2] || "")}`);
        this.members.delete(lc(p[1] || ""));
        return;
      case "NICK": {
        const to = p[0] || "";
        if (lc(from) === lc(this.nick)) this.nick = to;
        if (this.members.delete(lc(from))) this.members.set(lc(to), to);
        return;
      }
      case "ERROR":
        this.error ||= strip(p[0] || "Closed by the server");
        return;
      case "NOTICE":
        if (lc(p[0] || "") === lc(this.nick) && from && !from.includes(".")) this.notice(from, strip(p[1] || ""));
        return;
      case "PRIVMSG": {
        const text = p[1] || "";
        if (lc(p[0] || "") !== lc(this.nick)) return;
        if (text.startsWith("\x01")) this.ctcp(from, text.replace(/^\x01|\x01$/g, ""));
        else this.notice(from, strip(text));
        return;
      }
    }
  }

  private ctcp(from: string, text: string) {
    const [word] = text.split(" ");
    if (word === "VERSION") return this.raw(`NOTICE ${from} :\x01VERSION Scute\x01`);
    if (word === "PING") return this.raw(`NOTICE ${from} :\x01${text}\x01`);
    if (word === "DCC") this.dcc(from, text);
  }

  private notice(from: string, text: string) {
    if (!text) return;
    const f = lc(from);
    if (this.search && (f === SEARCH_BOT || f === "searchook")) {
      const s = this.search;
      const m = text.match(/returned\s+([\d,]+)\s+match/i);
      if (/returned no matches|no matches|0 matches|nothing found|sorry/i.test(text) && !m) return this.finish(s, "done", "Nothing found", []);
      if (m) {
        s.matches = Number(m[1].replace(/,/g, ""));
        s.message = `${s.matches} found; fetching the list…`;
      } else if (/accepted|searching/i.test(text)) s.message = "Searching…";
      else s.message = text.replace(/<<[^>]*>>\s*/g, "").slice(0, 200);
      return;
    }
    const dl = [...this.jobs.values()].find((j) => j.kind === "download" && lc(j.bot || "") === f && (j.status === "sent" || j.status === "receiving"));
    if (dl) dl.message = text.slice(0, 240);
  }

  private dcc(from: string, text: string) {
    const m = text.match(/^DCC SEND\s+(?:"([^"]+)"|(\S+))\s+(\S+)\s+(\d+)(?:\s+(\d+))?/i);
    if (!m) return;
    const name = path.basename((m[1] || m[2] || "file").replace(/\\/g, "/"));
    const ip = dccAddress(m[3]);
    const port = Number(m[4]);
    const size = Number(m[5] || 0);
    const f = lc(from);
    let job: Job | undefined;
    if (this.search && (f === SEARCH_BOT || f === "searchook" || /results_for/i.test(name))) job = this.search;
    else job = [...this.jobs.values()].filter((j) => j.kind === "download" && j.status === "sent" && lc(j.bot || "") === f).sort((a, b) => a.created - b.created)[0];
    if (!job) return; // nothing asked for from that nick: ignore
    if (!ip || !port) return this.finish(job, "error", "The server offered a kind of transfer Scute can't take (passive DCC)");
    if (privateIp(ip)) return this.finish(job, "error", `The server gave a private address (${ip}); refused`);
    if (size > this.maxBytes) return this.finish(job, "error", `The file is ${fmtBytes(size)}, more than this server's limit`);
    job.name = name;
    job.size = size;
    job.status = "receiving";
    job.message = "";
    job.received = 0;
    const file = path.join(this.dir, job.id);
    fs.mkdirSync(this.dir, { recursive: true });
    const out = fs.createWriteStream(file);
    const s = net.connect({ host: ip, port });
    job.sock = s;
    s.setTimeout(STALL_MS);
    let done = false;
    const end = (err?: string) => {
      if (done) return;
      done = true;
      s.destroy();
      out.end(() => {
        if (err) return this.finish(job!, "error", err);
        if (size && job!.received < size) return this.finish(job!, "error", `The transfer stopped at ${fmtBytes(job!.received)} of ${fmtBytes(size)}`);
        job!.file = file;
        if (job!.kind === "search") return this.searchDone(job!);
        this.finish(job!, "done", "");
      });
    };
    s.on("data", (d: Buffer) => {
      job!.received += d.length;
      if (job!.received > this.maxBytes) return end("The file is bigger than this server's limit");
      out.write(d);
      const ack = Buffer.alloc(4);
      ack.writeUInt32BE(job!.received % 2 ** 32);
      s.write(ack);
      this.lastUse = Date.now();
      if (size && job!.received >= size) end();
    });
    s.on("timeout", () => end("The transfer stalled"));
    s.on("error", (e) => end(`Couldn't fetch it: ${e.message}`));
    s.on("close", () => end());
  }

  private searchDone(job: Job) {
    try {
      const results = parseResults(resultsText(fs.readFileSync(job.file!)));
      fs.rmSync(job.file!, { force: true });
      job.file = undefined;
      this.finish(job, "done", results.length ? "" : "Nothing found", results);
    } catch (e) {
      this.finish(job, "error", `Couldn't read the results: ${(e as Error).message}`);
    }
  }

  private finish(job: Job, status: "done" | "error", message: string, results?: Result[]) {
    if (job.status === "done" || job.status === "error") return;
    clearTimeout(job.timer);
    job.sock?.destroy();
    job.sock = undefined;
    job.status = status;
    job.message = message;
    job.finished = Date.now();
    if (results) job.results = results;
    if (status === "error" && job.file) {
      fs.rmSync(job.file, { force: true });
      job.file = undefined;
    }
    if (job === this.search) {
      this.search = null;
      this.next();
    }
  }

  /** Start the next queued job (one search at a time; the search bot allows no more). */
  private next() {
    if (this.state !== "ready") return;
    for (const j of [...this.jobs.values()].sort((a, b) => a.created - b.created)) {
      if (j.status !== "queued") continue;
      if (j.kind === "search") {
        if (this.search) continue;
        this.search = j;
        j.status = "sent";
        j.message = "Asking the search bot…";
        this.say(`@${SEARCH_BOT} ${j.query}`);
        j.timer = setTimeout(() => this.finish(j, "error", "The search bot didn't answer; try again in a minute"), SEARCH_TIMEOUT);
      } else {
        j.status = "sent";
        const online = this.members.has(lc(j.bot!));
        j.message = online ? "Requested; waiting for the server…" : `${j.bot} isn't in ${CHANNEL} right now, so this will probably go unanswered`;
        this.say(j.command!);
        j.timer = setTimeout(() => this.finish(j, "error", online ? "The server didn't send it in time (it may be busy); try another copy" : `${j.bot} didn't answer`), online ? DOWNLOAD_TIMEOUT : OFFLINE_TIMEOUT);
      }
    }
  }

  add(job: Job) {
    this.lastUse = Date.now();
    this.jobs.set(job.id, job);
    this.next();
  }

  expire() {
    const now = Date.now();
    for (const j of this.jobs.values()) {
      if (j.finished && now - j.finished > KEEP_MS) this.drop(j.id);
    }
  }

  drop(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    clearTimeout(j.timer);
    j.sock?.destroy();
    if (j.file) fs.rmSync(j.file, { force: true });
    if (j === this.search) {
      this.search = null;
      this.next();
    }
    this.jobs.delete(id);
  }

  private fail(msg: string) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.error = msg;
    this.rejectReady(new Error(msg));
    for (const j of this.jobs.values()) if (j.status !== "done" && j.status !== "error") this.finish(j, "error", msg);
    clearInterval(this.idle);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.sock.destroy();
    this.onClose();
  }

  quit(why: string) {
    if (this.state === "closed") return;
    this.raw(`QUIT :${why}`);
    setTimeout(() => this.sock.destroy(), 500).unref?.();
    this.fail("Disconnected");
  }
}

export function registerBookSearchRoutes(
  app: Express,
  deps: { auth: any; wrap: any; HttpError: new (status: number, message: string) => Error; need: () => void; libDir: string; maxBytes: number },
) {
  const { auth, wrap, HttpError, need, libDir, maxBytes } = deps;
  const conns = new Map<string, Irc>();
  // finished jobs of a connection that has closed, so their files can still be collected
  const orphans = new Map<string, Map<string, Job>>();
  const root = path.join(libDir, ".irc");
  fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  setInterval(() => {
    for (const [uid, m] of orphans) {
      for (const [id, j] of m) if (Date.now() - (j.finished || j.created) > KEEP_MS) {
        if (j.file) fs.rmSync(j.file, { force: true });
        m.delete(id);
      }
      if (!m.size) orphans.delete(uid);
    }
  }, 5 * 60_000).unref?.();

  const allowed = (u: User) => BOOKSEARCH_MODE === "all" || (BOOKSEARCH_MODE === "admins" && !!u.is_admin);
  const gate = (u: User) => {
    need();
    if (BOOKSEARCH_MODE === "off") throw new HttpError(403, "Book search is turned off on this server (SCUTE_BOOKSEARCH=off)");
    if (!allowed(u)) throw new HttpError(403, "Book search is only for this server's admin (SCUTE_BOOKSEARCH=all opens it to everyone)");
  };
  const jobsOf = (uid: string) => conns.get(uid)?.jobs || orphans.get(uid) || new Map<string, Job>();
  const view = (j: Job, full = false) => ({
    id: j.id,
    kind: j.kind,
    query: j.query,
    command: j.command,
    bot: j.bot,
    label: j.label,
    title: j.title,
    author: j.author,
    status: j.status,
    message: j.message,
    received: j.received,
    size: j.size,
    name: j.name,
    created: j.created,
    finished: j.finished || null,
    count: j.results?.length ?? null,
    matches: j.matches ?? null,
    ready: !!j.file,
    ...(full && j.results ? { results: j.results } : {}),
  });
  const status = (u: User) => {
    const c = conns.get(u.id);
    return {
      enabled: BOOKSEARCH_MODE !== "off",
      allowed: allowed(u),
      server: IRC_HOST,
      port: IRC_PORT,
      channel: CHANNEL,
      state: c ? c.state : "closed",
      nick: c?.nick || null,
      error: c?.error || null,
      people: c?.members.size || 0,
      online: c && c.state === "ready" ? [...c.members.values()] : [],
      jobs: [...jobsOf(u.id).values()].sort((a, b) => b.created - a.created).map((j) => view(j)),
    };
  };
  const connect = async (u: User, nick?: string) => {
    let c = conns.get(u.id);
    if (c && c.state !== "closed") return c;
    if ([...conns.values()].filter((x) => x.state !== "closed").length >= MAX_CONNECTIONS) throw new HttpError(429, `This server already has ${MAX_CONNECTIONS} people searching; try again in a few minutes`);
    const prev = jobsOf(u.id);
    c = new Irc(u.id, nick || u.username, path.join(root, u.id), maxBytes, () => {
      // keep finished jobs (and downloaded files) after the connection closes
      const keep = new Map([...c!.jobs].filter(([, j]) => j.status === "done" || j.status === "error"));
      if (conns.get(u.id) === c) conns.delete(u.id);
      if (keep.size) orphans.set(u.id, keep);
    });
    for (const [k, j] of prev) c.jobs.set(k, j);
    orphans.delete(u.id);
    conns.set(u.id, c);
    return c;
  };
  const newJob = (kind: Job["kind"], label: string, extra: Partial<Job>): Job => ({ id: crypto.randomBytes(9).toString("hex"), kind, label, status: "queued", message: "Connecting…", received: 0, size: 0, name: "", created: Date.now(), finished: 0, ...extra });

  app.get(
    "/api/library/irc",
    auth,
    wrap((req: any, res: any) => {
      need();
      res.json(status(req.user));
    }),
  );
  app.post(
    "/api/library/irc/connect",
    auth,
    express.json(),
    wrap(async (req: any, res: any) => {
      gate(req.user);
      const c = await connect(req.user, typeof req.body?.nick === "string" ? req.body.nick : undefined);
      try {
        await c.whenReady();
      } catch (e) {
        throw new HttpError(409, (e as Error).message); // not 502: the app reads that as "server down"
      }
      res.json(status(req.user));
    }),
  );
  app.post(
    "/api/library/irc/disconnect",
    auth,
    wrap((req: any, res: any) => {
      need();
      conns.get(req.user.id)?.quit("bye");
      res.json(status(req.user));
    }),
  );
  app.post(
    "/api/library/irc/search",
    auth,
    express.json(),
    wrap(async (req: any, res: any) => {
      gate(req.user);
      const q = String(req.body?.q || "").replace(/[\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim();
      if (q.length < 2) throw new HttpError(400, "Type at least two letters");
      if (q.length > 200) throw new HttpError(400, "That search is too long");
      const c = await connect(req.user, req.body?.nick);
      const job = newJob("search", q, { query: q });
      c.add(job);
      res.json(view(job));
    }),
  );
  app.post(
    "/api/library/irc/download",
    auth,
    express.json(),
    wrap(async (req: any, res: any) => {
      gate(req.user);
      const command = String(req.body?.command || "").trim();
      const m = command.match(/^!(\S{1,40}) \S/);
      if (!m || /[\r\n\x00]/.test(command) || command.length > 400) throw new HttpError(400, "That isn't a line from the search results");
      const c = await connect(req.user, req.body?.nick);
      const dup = [...c.jobs.values()].find((j) => j.command === command && j.status !== "error");
      if (dup) return res.json(view(dup));
      const r = parseResult(command);
      const job = newJob("download", r ? (r.author ? `${r.title} – ${r.author}` : r.title) : command.slice(m[0].length - 1), { command, bot: m[1], title: r?.title, author: r?.author });
      c.add(job);
      res.json(view(job));
    }),
  );
  app.get(
    "/api/library/irc/jobs/:id",
    auth,
    wrap((req: any, res: any) => {
      need();
      const j = jobsOf(req.user.id).get(req.params.id);
      if (!j) throw new HttpError(404, "That search or download has gone (they're kept for an hour)");
      res.json(view(j, true));
    }),
  );
  app.get(
    "/api/library/irc/jobs/:id/file",
    auth,
    wrap((req: any, res: any) => {
      need();
      const j = jobsOf(req.user.id).get(req.params.id);
      if (!j?.file) throw new HttpError(404, "That file isn't here (any more)");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-File-Name", encodeURIComponent(j.name));
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(j.name)}`);
      res.setHeader("Cache-Control", "no-store");
      fs.createReadStream(j.file).on("error", () => res.destroy()).pipe(res);
    }),
  );
  app.delete(
    "/api/library/irc/jobs/:id",
    auth,
    wrap((req: any, res: any) => {
      need();
      const c = conns.get(req.user.id);
      if (c) c.drop(req.params.id);
      else {
        const m = orphans.get(req.user.id);
        const j = m?.get(req.params.id);
        if (j?.file) fs.rmSync(j.file, { force: true });
        m?.delete(req.params.id);
      }
      res.json({ ok: true });
    }),
  );

  return {
    removeUser(uid: string) {
      conns.get(uid)?.quit("bye");
      orphans.delete(uid);
      fsp.rm(path.join(root, uid), { recursive: true, force: true }).catch(() => {});
    },
  };
}
