import { useEffect, useState } from "react";
import { idbGet, idbSet } from "./idb";

export type Theme = "light" | "dark" | "system";

function apply(t: Theme) {
  const dark = t === "dark" || (t === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", !!dark);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#101614" : "#f6f4ef"));
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    idbGet<Theme>("theme").then((t) => {
      if (t) setTheme(t);
    });
  }, []);
  useEffect(() => {
    apply(theme);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => theme === "system" && apply("system");
    mq?.addEventListener?.("change", on);
    return () => mq?.removeEventListener?.("change", on);
  }, [theme]);
  return {
    theme,
    setTheme: (t: Theme) => {
      setTheme(t);
      void idbSet("theme", t);
    },
  };
}
