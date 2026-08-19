import { describe, expect, it, vi } from "vitest";
import { requestDisplayStream } from "./display-capture.util";

describe("requestDisplayStream", () => {
  it("uses the requested system-audio stream when available", async () => {
    const request = vi.fn(async () => "screen-with-audio");

    await expect(requestDisplayStream(request, true)).resolves.toEqual({
      stream: "screen-with-audio",
      systemAudioIncluded: true,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(true);
  });

  it("falls back to video-only capture when system audio is rejected", async () => {
    const request = vi.fn(async (includeSystemAudio: boolean) => {
      if (includeSystemAudio) throw new Error("Permission denied by system");
      return "screen-only";
    });

    await expect(requestDisplayStream(request, true)).resolves.toEqual({
      stream: "screen-only",
      systemAudioIncluded: false,
    });
    expect(request.mock.calls).toEqual([[true], [false]]);
  });

  it("preserves video-only capture failures", async () => {
    const error = new Error("Screen capture denied");
    const request = vi.fn(async () => Promise.reject(error));

    await expect(requestDisplayStream(request, false)).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
  });

  it("identifies a failed video-only fallback", async () => {
    const request = vi.fn(async () => Promise.reject(new Error("Permission denied by system")));

    await expect(requestDisplayStream(request, true)).rejects.toThrow(
      "Screen capture was denied even without system audio: Permission denied by system",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
