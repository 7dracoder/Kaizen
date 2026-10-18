// Shared by the graph page (server-rendered) and the canvas (browser-only): types and the label palette.

export interface NetNode {
  id: string;
  label: string;
  name: string;
  props: Record<string, unknown>;
}
export interface NetLink {
  source: string;
  target: string;
  type: string;
}

/**
 * Fixed categorical palette per node label. Like whatspoppin's relationship palette it avoids the locked status
 * hues, except Check (red: a failure) and Lesson (green: something learned), which carry exactly that meaning.
 */
export const LABEL_COLORS: Record<string, string> = {
  Build: "#4C7BD9",
  Run: "#7C8AA5",
  Agent: "#2BA8B8",
  Lesson: "#3dae7a",
  Check: "#d9685f",
  Config: "#8B5CF6",
  Rule: "#A78BFA",
  Subcircuit: "#cc9a3d",
  Spec: "#C34FC7",
  WorkItem: "#E0529E",
  Worker: "#94A3B8",
  Request: "#38BDF8",
  BoardVersion: "#64748B",
  User: "#F472B6",
};
