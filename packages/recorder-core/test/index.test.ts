import { describe, expect, it } from "vitest";
import { buildUploadParts, cameraLayoutFromOptions, clampCameraOffsetMs, pickCameraRecorderMimeType, extensionFromMimeType, pauseTimingFor, pickRecorderMimeType, recordingDuration } from "../src";

async function* chunks(values: number[][]) {
  for (const value of values) yield Uint8Array.from(value);
}

describe("buildUploadParts", () => {
  it("preserves bytes across uneven recording chunks", async () => {
    const result = [];
    for await (const part of buildUploadParts(chunks([[1, 2, 3], [4, 5], [6, 7]]), 4)) {
      result.push({ partNumber: part.partNumber, data: [...part.data] });
    }
    expect(result).toEqual([
      { partNumber: 1, data: [1, 2, 3, 4] },
      { partNumber: 2, data: [5, 6, 7] },
    ]);
  });

  it("rejects invalid part sizes", async () => {
    const iterator = buildUploadParts(chunks([[1]]), 0);
    await expect(iterator.next()).rejects.toThrow("positive integer");
  });
});

describe("media helpers", () => {
  it("chooses the first supported recorder format", () => {
    expect(pickRecorderMimeType((value) => value.includes("vp8"))).toContain("vp8");
  });

  it("maps MIME types to upload extensions", () => {
    expect(extensionFromMimeType("video/mp4")).toBe("mp4");
    expect(extensionFromMimeType("video/webm;codecs=vp9")).toBe("webm");
  });
});

describe("recording timing", () => {
  it("excludes completed and in-progress pauses from the duration", () => {
    const paused = { startedAt: 0, ...pauseTimingFor({}, "paused", 10_000) };
    expect(recordingDuration(paused, 15_000)).toBe(10_000);

    const resumed = { startedAt: 0, ...pauseTimingFor(paused, "recording", 15_000) };
    expect(resumed).toEqual({ startedAt: 0, pausedAt: undefined, pausedMs: 5_000 });
    expect(recordingDuration(resumed, 20_000)).toBe(15_000);
  });

  it("treats a repeated status as a no-op", () => {
    const paused = pauseTimingFor({}, "paused", 10_000);
    expect(pauseTimingFor(paused, "paused", 12_000)).toEqual(paused);
    expect(pauseTimingFor({ pausedMs: 3_000 }, "recording", 12_000)).toEqual({ pausedAt: undefined, pausedMs: 3_000 });
  });
});

describe("camera helpers", () => {
  const base = { cameraSize: "medium", cameraCorner: "bottom-left" } as const;

  it("derives the separate-track layout with defaults", () => {
    expect(cameraLayoutFromOptions(base)).toEqual({ visible: true, corner: "bottom-left", size: "medium", shape: "circle" });
    expect(cameraLayoutFromOptions({ ...base, cameraSize: "large", cameraCorner: "top-right", cameraShape: "rounded", cameraMode: "separate" }))
      .toEqual({ visible: true, corner: "top-right", size: "large", shape: "rounded" });
  });

  it("returns no layout when off or burned in", () => {
    expect(cameraLayoutFromOptions({ ...base, cameraSize: "off" })).toBeNull();
    expect(cameraLayoutFromOptions({ ...base, cameraMode: "burned-in" })).toBeNull();
  });

  it("clamps and rounds the start offset", () => {
    expect(clampCameraOffsetMs(12.6)).toBe(13);
    expect(clampCameraOffsetMs(5_000)).toBe(2_000);
    expect(clampCameraOffsetMs(-9_000)).toBe(-2_000);
    expect(clampCameraOffsetMs(Number.NaN)).toBe(0);
  });

  it("prefers vp8 webm for the camera", () => {
    expect(pickCameraRecorderMimeType(() => true)).toBe("video/webm;codecs=vp8");
    expect(pickCameraRecorderMimeType((v) => v === "video/webm")).toBe("video/webm");
    expect(pickCameraRecorderMimeType(() => false)).toBeNull();
  });
});
