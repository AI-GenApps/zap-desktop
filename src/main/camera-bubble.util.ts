import type { CameraBubbleState } from "../shared/contracts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const HUD_SIZE = { width: 320, height: 64 };
export const HUD_BOTTOM_INSET = 28;
const BUBBLE_INSET = 24;
const HUD_GAP = 12;

/** Window height in px for each camera size. */
export const BUBBLE_HEIGHTS = { small: 120, medium: 170, large: 220 } as const;

/** Where the recording HUD sits: bottom-centre of a display's work area. */
export function hudBounds(workArea: Rect): Rect {
  return {
    ...HUD_SIZE,
    x: Math.round(workArea.x + (workArea.width - HUD_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - HUD_SIZE.height - HUD_BOTTOM_INSET),
  };
}

/** Bubble window size: square for a circle, 4:3 wide for the rounded shape. */
export function bubbleSize(state: Pick<CameraBubbleState, "size" | "shape">) {
  const height = BUBBLE_HEIGHTS[state.size];
  return { width: state.shape === "circle" ? height : Math.round((height * 4) / 3), height };
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Initial bubble bounds in the chosen corner of the work area, kept clear of the HUD. */
export function placeBubble(workArea: Rect, state: CameraBubbleState): Rect {
  const { width, height } = bubbleSize(state);
  const x = state.corner.endsWith("right") ? workArea.x + workArea.width - width - BUBBLE_INSET : workArea.x + BUBBLE_INSET;
  let y = state.corner.startsWith("bottom") ? workArea.y + workArea.height - height - BUBBLE_INSET : workArea.y + BUBBLE_INSET;
  const hud = hudBounds(workArea);
  const clearance = { x: hud.x - HUD_GAP, y: hud.y - HUD_GAP, width: hud.width + HUD_GAP * 2, height: hud.height + HUD_GAP * 2 };
  if (intersects({ x, y, width, height }, clearance)) y = Math.max(workArea.y + BUBBLE_INSET, clearance.y - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}
