"use client";

import { Grid } from "@react-three/drei";

import { useThemeColors } from "@/components/theme/ThemeProvider";

import { BOARD_BOTTOM } from "./pcbScene.shared";

/**
 * CAD reference plane. The board rests on it, so it stays level with the grid
 * from any angle, and fades toward the horizon so it gives depth without competing
 * with the copper.
 */
export function WorldGrid() {
  const c = useThemeColors({ cell: ["--border", "#3a4459"], section: ["--grid-dot", "#52607c"] });
  return (
    <Grid
      position={[0, BOARD_BOTTOM - 0.004, 0]}
      args={[80, 80]}
      infiniteGrid
      cellSize={1}
      cellThickness={0.7}
      cellColor={c.cell}
      sectionSize={5}
      sectionThickness={1.2}
      sectionColor={c.section}
      fadeDistance={60}
      fadeStrength={1.4}
      fadeFrom={0}
    />
  );
}
