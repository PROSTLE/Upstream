import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "upstream.theme";

/** The app opens in light mode unless someone has chosen otherwise. index.html applies the same rule before first paint. */
export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "system" ? v : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Storage can be unavailable; the choice then lasts for this page only.
  }
  window.dispatchEvent(new Event("upstream:theme"));
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

/** The theme actually on screen, following the OS when the preference is "system". */
export function useResolvedTheme(): "light" | "dark" {
  const resolve = () => {
    const p = getThemePref();
    return p === "system" ? (systemDark() ? "dark" : "light") : p;
  };
  const [t, setT] = useState(resolve);
  useEffect(() => {
    const f = () => setT(resolve());
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", f);
    window.addEventListener("upstream:theme", f);
    return () => {
      mq?.removeEventListener("change", f);
      window.removeEventListener("upstream:theme", f);
    };
  }, []);
  return t;
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [p, setP] = useState(getThemePref);
  useEffect(() => {
    const f = () => setP(getThemePref());
    window.addEventListener("upstream:theme", f);
    return () => window.removeEventListener("upstream:theme", f);
  }, []);
  return [p, applyTheme];
}
