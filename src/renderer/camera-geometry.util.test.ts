import { describe, expect, it } from "vitest";
import { cameraBubbleRect, cameraShapeBox, containedImageRect, thumbnailBubbleRect } from "./camera-geometry.util";

describe("camera geometry", () => {
  it("sizes circles as D x D with D from the frame width", () => {
    expect(cameraBubbleRect(1920, 1080, "small", "top-left", "circle")).toEqual({ x: 48, y: 48, width: 269, height: 269, radius: 134.5 });
    expect(cameraBubbleRect(1920, 1080, "medium", "top-left", "circle")).toMatchObject({ width: 384, height: 384 });
    expect(cameraBubbleRect(1920, 1080, "large", "top-left", "circle")).toMatchObject({ width: 518, height: 518 });
  });

  it("sizes rounded boxes 4:3 with a 16% corner radius", () => {
    expect(cameraShapeBox(384, "rounded")).toEqual({ width: 512, height: 384, radius: 61 });
  });

  it("anchors each corner with a margin of 2.5% of the width", () => {
    const margin = 48;
    const d = 384;
    expect(cameraBubbleRect(1920, 1080, "medium", "top-right", "circle")).toMatchObject({ x: 1920 - d - margin, y: margin });
    expect(cameraBubbleRect(1920, 1080, "medium", "bottom-left", "circle")).toMatchObject({ x: margin, y: 1080 - d - margin });
    expect(cameraBubbleRect(1920, 1080, "medium", "bottom-right", "rounded")).toMatchObject({ x: 1920 - 512 - margin, y: 1080 - d - margin });
  });

  it("computes the letterboxed image rect for object-fit: contain", () => {
    expect(containedImageRect(200, 125, 200, 125)).toEqual({ x: 0, y: 0, width: 200, height: 125 });
    expect(containedImageRect(200, 100, 100, 100)).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    expect(containedImageRect(200, 100, 400, 100)).toEqual({ x: 0, y: 25, width: 200, height: 50 });
  });

  it("falls back to the full container before the image size is known", () => {
    expect(containedImageRect(200, 100, 0, 0)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it("scales the bubble into the displayed image rect, offset by the letterbox", () => {
    // 1000x500 frame letterboxed into 200x125: scale .2, 12.5px bars top and bottom.
    const rect = thumbnailBubbleRect({ width: 200, height: 125 }, { width: 1000, height: 500 }, "medium", "bottom-right", "circle");
    expect(rect.width).toBeCloseTo(40);
    expect(rect.height).toBeCloseTo(40);
    expect(rect.x).toBeCloseTo(200 - 40 - 25 * 0.2);
    expect(rect.y).toBeCloseTo(12.5 + (500 - 200 - 25) * 0.2);
    expect(rect.radius).toBeCloseTo(20);
  });
});
