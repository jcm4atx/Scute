import type { Request, Response } from "express";
import { db } from "./storage";

/**
 * Change notifications (1.21.0).
 *
 * Signed-in browsers keep one streaming request open to GET /api/events and
 * hear "sync" when something changes in one of their spaces, so they fetch the
 * change at once instead of waiting for their 20-second check. Only the space
 * id is sent, never content. Background jobs (Joplin notebook links) listen to
 * space changes here too.
 */

type Listener = (spaceId: string, origin: string | null) => void;
const streams = new Map<string, Set<Response>>(); // user id -> open streams
const listeners = new Set<Listener>();
const pending = new Map<string, NodeJS.Timeout>(); // "user|event" -> debounce

export function onSpaceChange(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Something in a space changed. `origin` names the job that made the change, so it can ignore its own. */
export function spaceChanged(spaceId: string | null | undefined, origin: string | null = null) {
  if (!spaceId) return;
  for (const fn of listeners) {
    try {
      fn(spaceId, origin);
    } catch (e) {
      console.error("[events] listener failed:", e);
    }
  }
  spaceEvent(spaceId, "sync");
}

/** Send an event to every open browser of a space's members (debounced per user and event). */
export function spaceEvent(spaceId: string, event: "sync" | "link") {
  if (!streams.size) return;
  const users = db.prepare("SELECT user_id FROM members WHERE space_id = ? AND status = 'active'").all(spaceId) as { user_id: string }[];
  for (const { user_id } of users) {
    const k = `${user_id}|${event}`;
    if (!streams.has(user_id) || pending.has(k)) continue;
    pending.set(
      k,
      setTimeout(() => {
        pending.delete(k);
        for (const res of streams.get(user_id) || []) res.write(`event: ${event}\ndata: ${JSON.stringify({ spaceId })}\n\n`);
      }, 250),
    );
  }
}

/** Tell one user's browsers to sync (membership changes, invites). */
export function userChanged(userId: string) {
  for (const res of streams.get(userId) || []) res.write(`event: sync\ndata: {}\n\n`);
}

/** A per-user event ("bitwarden": the Bitwarden vault changed in an app), debounced. */
export function userEvent(userId: string, event: "bitwarden") {
  const k = `${userId}|${event}`;
  if (!streams.has(userId) || pending.has(k)) return;
  pending.set(
    k,
    setTimeout(() => {
      pending.delete(k);
      for (const res of streams.get(userId) || []) res.write(`event: ${event}\ndata: {}\n\n`);
    }, 500),
  );
}

export function eventStream(req: Request & { user: { id: string } }, res: Response) {
  const uid = req.user.id;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // no-transform keeps proxies (Apache mod_deflate, nginx) from buffering the stream
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`retry: 5000\nevent: hello\ndata: {}\n\n`);
  let set = streams.get(uid);
  if (!set) streams.set(uid, (set = new Set()));
  set.add(res);
  // a comment every 25 s keeps reverse proxies from closing an idle stream
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  const close = () => {
    clearInterval(ping);
    set!.delete(res);
    if (!set!.size) streams.delete(uid);
  };
  req.on("close", close);
  res.on("error", close);
}
