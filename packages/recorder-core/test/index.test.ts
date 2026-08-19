import { describe, expect, it } from "vitest";
import { buildUploadParts, extensionFromMimeType, pickRecorderMimeType } from "../src";

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
