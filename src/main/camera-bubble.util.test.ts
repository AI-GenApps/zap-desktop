import { describe, expect, it } from "vitest";
import { bubbleSize, hudBounds, placeBubble } from "./camera-bubble.util";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

describe("camera bubble window", () => {
  it("sizes the window by camera size and shape", () => {
    expect(bubbleSize({ size: "small", shape: "circle" })).toEqual({ width: 120, height: 120 });
    expect(bubbleSize({ size: "medium", shape: "circle" })).toEqual({ width: 170, height: 170 });
    expect(bubbleSize({ size: "large", shape: "rounded" })).toEqual({ width: 293, height: 220 });
  });

  it("insets the bubble 24px from the chosen corner", () => {
    expect(placeBubble(workArea, { size: "small", shape: "circle", corner: "top-left" })).toEqual({ x: 24, y: 49, width: 120, height: 120 });
    expect(placeBubble(workArea, { size: "small", shape: "circle", corner: "top-right" })).toMatchObject({ x: 1296, y: 49 });
    expect(placeBubble(workArea, { size: "small", shape: "circle", corner: "bottom-right" })).toMatchObject({ x: 1296, y: 756 });
  });

  it("offsets for the display origin", () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 };
    expect(placeBubble(second, { size: "medium", shape: "circle", corner: "bottom-left" })).toMatchObject({ x: 1464, y: 886 });
  });

  it("never overlaps the bottom-centre HUD", () => {
    const narrow = { x: 0, y: 0, width: 520, height: 700 };
    const hud = hudBounds(narrow);
    const bubble = placeBubble(narrow, { size: "large", shape: "rounded", corner: "bottom-left" });
    const overlaps = bubble.x < hud.x + hud.width && hud.x < bubble.x + bubble.width && bubble.y < hud.y + hud.height && hud.y < bubble.y + bubble.height;
    expect(overlaps).toBe(false);
  });
});
