import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Loader2, Maximize, Minimize, Pause, Play, Shuffle, X } from "lucide-react";
import { useVault, type Note } from "@/lib/vault";

const SPEEDS = [3, 5, 8, 15];

function shuffled<T>(xs: T[]) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Full-screen slideshow of image notes. Images are decrypted on demand (current + next are
 * prepared ahead of time); the thumbnail is shown blurred while the full image decrypts.
 */
export function Slideshow({ notes, start, onClose }: { notes: Note[]; start: number; onClose: () => void }) {
  const v = useVault();
  const [order, setOrder] = useState<Note[]>(notes);
  const [idx, setIdx] = useState(() => Math.min(Math.max(0, start), notes.length - 1));
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(() => Number(localStorage.getItem("scute:slide-speed")) || 5);
  const [shuffle, setShuffle] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [chrome, setChrome] = useState(true);
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const idle = useRef<number>();
  const touchX = useRef<number | null>(null);

  const n = order.length;
  const cur = order[idx];
  const curReady = !!(cur && (urls[cur.id] || failed[cur.id]));

  const load = useCallback(
    async (note?: Note) => {
      if (!note || urls[note.id] || failed[note.id]) return;
      try {
        const url = await v.getFileUrl(note);
        setUrls((u) => ({ ...u, [note.id]: url }));
      } catch {
        setFailed((f) => ({ ...f, [note.id]: true }));
      }
    },
    [urls, failed, v],
  );

  // Decrypt the current slide and the next one.
  useEffect(() => {
    if (!n) return;
    void load(order[idx]);
    void load(order[(idx + 1) % n]);
  }, [idx, order, n]); // eslint-disable-line

  const go = useCallback((delta: number) => setIdx((i) => (n ? (i + delta + n) % n : 0)), [n]);

  // Auto-advance, but only once the current image has actually appeared.
  useEffect(() => {
    if (!playing || n < 2 || !curReady) return;
    const t = window.setTimeout(() => go(1), speed * 1000);
    return () => window.clearTimeout(t);
  }, [playing, speed, idx, curReady, n, go]);

  // Hide controls after a moment without mouse movement.
  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setChrome(false), 2500);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(idle.current);
  }, [poke]);

  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => {
      document.removeEventListener("fullscreenchange", f);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  function toggleShuffle() {
    const id = cur?.id;
    const next = shuffle ? notes : shuffled(notes);
    setShuffle(!shuffle);
    setOrder(next);
    setIdx(Math.max(0, next.findIndex((x) => x.id === id)));
  }

  function changeSpeed(s: number) {
    setSpeed(s);
    localStorage.setItem("scute:slide-speed", String(s));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) onClose();
      else if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === " " || e.key === "k") setPlaying((p) => !p);
      else if (e.key === "f") toggleFull();
      else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(n - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
      poke();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, n, onClose, poke, toggleFull]);

  // Keep the page behind from scrolling.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const title = useMemo(() => (cur ? cur.data.title || cur.data.file?.name || "Untitled" : ""), [cur]);
  if (!cur) return null;
  const src = urls[cur.id];
  const btn = "inline-flex h-10 w-10 items-center justify-center rounded-full text-white/85 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Slideshow"
      className={`fixed inset-0 z-[70] bg-black text-white select-none ${chrome ? "" : "cursor-none"}`}
      onMouseMove={poke}
      onTouchStart={(e) => {
        touchX.current = e.touches[0].clientX;
        poke();
      }}
      onTouchEnd={(e) => {
        const x0 = touchX.current;
        touchX.current = null;
        if (x0 == null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      }}
      data-testid="slideshow"
    >
      {/* Slide */}
      <div className="absolute inset-0 flex items-center justify-center" onClick={() => setPlaying((p) => !p)}>
        {!src && cur.data.thumb && <img src={cur.data.thumb} alt="" className="absolute h-full w-full object-contain blur-md opacity-60" />}
        {src && <img key={cur.id} src={src} alt={title} className="slide-in max-h-full max-w-full object-contain" draggable={false} data-testid="img-slide" />}
        {!src && !failed[cur.id] && <Loader2 className="relative h-8 w-8 animate-spin text-white/70" />}
        {failed[cur.id] && <p className="relative text-sm text-white/70">This image couldn't be decrypted.</p>}
      </div>

      {/* Progress bar for the current slide */}
      {playing && n > 1 && curReady && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-white/10">
          <div key={`${cur.id}-${speed}`} className="h-full bg-white/70 slide-progress" style={{ animationDuration: `${speed}s` }} />
        </div>
      )}

      <div className={`transition-opacity duration-300 ${chrome ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
        {/* Top bar */}
        <div className="absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 pb-10 pt-3" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" data-testid="text-slide-title">{title}</p>
            <p className="text-xs text-white/60 tabular-nums" data-testid="text-slide-count">
              {idx + 1} / {n}
            </p>
          </div>
          <button type="button" className={btn} onClick={toggleFull} aria-label={full ? "Exit full screen" : "Full screen"} data-testid="button-slide-fullscreen">
            {full ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </button>
          <button type="button" className={btn} onClick={onClose} aria-label="Close slideshow" data-testid="button-slide-close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Side arrows */}
        {n > 1 && (
          <>
            <button type="button" className={`${btn} absolute left-2 top-1/2 -translate-y-1/2 h-12 w-12 bg-black/30`} onClick={() => go(-1)} aria-label="Previous image" data-testid="button-slide-prev">
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button type="button" className={`${btn} absolute right-2 top-1/2 -translate-y-1/2 h-12 w-12 bg-black/30`} onClick={() => go(1)} aria-label="Next image" data-testid="button-slide-next">
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}

        {/* Bottom bar */}
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-4 pt-10" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          <button type="button" className={btn} onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"} data-testid="button-slide-play">
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-0.5" />}
          </button>
          <button type="button" className={`${btn} ${shuffle ? "bg-white/20 text-white" : ""}`} onClick={toggleShuffle} aria-label="Shuffle" aria-pressed={shuffle} data-testid="button-slide-shuffle">
            <Shuffle className="h-4 w-4" />
          </button>
          <div className="ml-2 flex items-center gap-1 rounded-full bg-white/10 p-1" role="group" aria-label="Seconds per image">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => changeSpeed(s)}
                className={`rounded-full px-2.5 py-1 text-xs tabular-nums ${speed === s ? "bg-white text-black" : "text-white/80 hover:bg-white/15"}`}
                aria-pressed={speed === s}
                data-testid={`button-slide-speed-${s}`}
              >
                {s}s
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
