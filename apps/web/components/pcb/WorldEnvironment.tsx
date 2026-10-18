"use client";

import { useThemeColors } from "@/components/theme/ThemeProvider";

/**
 * Surround for the board: a flat scene background in the active theme's elevated surface colour. Set on the scene
 * itself rather than drawn as geometry, so three's colour management renders the exact sRGB value.
 */
export const WORLD_BACKGROUND = "#1b2333";

export function WorldEnvironment() {
  const { bg } = useThemeColors({ bg: ["--surface-elevated", WORLD_BACKGROUND] });
  return <color attach="background" args={[bg]} />;
}
