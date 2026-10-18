"use client";

// Theme and light/dark mode, ported from the whatspoppin design system: five themes sharing one set of token names
// (globals.css), switched with [data-theme] and [data-mode] on <html>. The server renders the default (dark Soft
// Pixel); a stored choice from localStorage is applied right after mount.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export const THEMES = [
  { id: "soft-pixel-finance", name: "Soft Pixel" },
  { id: "peachy-market", name: "Peachy" },
  { id: "candy-radar", name: "Candy" },
  { id: "garden-signals", name: "Garden" },
  { id: "pastel-observatory", name: "Observatory" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];
export type ThemeMode = "light" | "dark";

export const STORAGE_KEY_THEME = "kaizen.theme";
export const STORAGE_KEY_MODE = "kaizen.mode";
export const DEFAULT_THEME: ThemeId = "soft-pixel-finance";
export const DEFAULT_MODE: ThemeMode = "dark";

interface ThemeContextValue {
  theme: ThemeId;
  mode: ThemeMode;
  setTheme: (theme: ThemeId) => void;
  setMode: (mode: ThemeMode) => void;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Server and first client render agree on the defaults (no hydration mismatch); the boot script has already
  // applied the stored choice to <html>, and this picks it up right after mount.
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      let t: ThemeId = DEFAULT_THEME;
      let m: ThemeMode = DEFAULT_MODE;
      try {
        const st = localStorage.getItem(STORAGE_KEY_THEME);
        if (THEMES.some((x) => x.id === st)) t = st as ThemeId;
        const sm = localStorage.getItem(STORAGE_KEY_MODE);
        if (sm === "light" || sm === "dark") m = sm;
      } catch {}
      document.documentElement.setAttribute("data-theme", t);
      document.documentElement.setAttribute("data-mode", m);
      setThemeState(t);
      setModeState(m);
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY_THEME, next);
    } catch {}
  }, []);
  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    document.documentElement.setAttribute("data-mode", next);
    try {
      localStorage.setItem(STORAGE_KEY_MODE, next);
    } catch {}
  }, []);

  const value = useMemo(() => ({ theme, mode, setTheme, setMode }), [theme, mode, setTheme, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

/** Reads a theme CSS variable (canvas and WebGL can't consume var() directly). */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Re-reads the given CSS variables whenever the theme or mode changes. */
export function useThemeColors<K extends string>(vars: Record<K, [string, string]>): Record<K, string> {
  const [colors, setColors] = useState(() => {
    const out = {} as Record<K, string>;
    for (const k of Object.keys(vars) as K[]) out[k] = vars[k][1];
    return out;
  });
  const key = JSON.stringify(vars);
  // Watches <html>'s attributes rather than the context, so it also works inside a separate React renderer
  // (the 3D canvas), where provider context may not reach.
  useEffect(() => {
    const parsed = JSON.parse(key) as Record<K, [string, string]>;
    const read = () => {
      const out = {} as Record<K, string>;
      for (const k of Object.keys(parsed) as K[]) out[k] = cssVar(parsed[k][0], parsed[k][1]);
      setColors(out);
    };
    const id = requestAnimationFrame(read);
    const observer = new MutationObserver(() => requestAnimationFrame(read));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode"] });
    return () => {
      cancelAnimationFrame(id);
      observer.disconnect();
    };
  }, [key]);
  return colors;
}
