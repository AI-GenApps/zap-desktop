import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordingOptions } from "@zapture/recorder-core";
import { RecordingStore } from "./recording-store";

const options: RecordingOptions = {
  sourceId: "screen:1",
  sourceName: "Screen",
  captureMode: "screen",
  includeSystemAudio: false,
  cameraSize: "medium",
  cameraCorner: "bottom-left",
};

describe("RecordingStore camera track", () => {
  let root: string;
  let store: RecordingStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zapture-store-"));
    store = new RecordingStore(root);
    await store.initialize();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("appends camera chunks and finalizes camera.webm", async () => {
    const created = await store.create(options, "video/webm;codecs=vp9,opus", { mimeType: "video/webm;codecs=vp8", startOffsetMs: 9_999, aspect: 4 / 3 });
    expect(created.camera).toMatchObject({ extension: "webm", mimeType: "video/webm", startOffsetMs: 2_000, chunkCount: 0 });
    await store.appendChunk(created.id, Uint8Array.from([1, 2]));
    await Promise.all([
      store.appendCameraChunk(created.id, Uint8Array.from([7, 8])),
      store.appendChunk(created.id, Uint8Array.from([3])),
      store.appendCameraChunk(created.id, Uint8Array.from([9])),
    ]);
    const done = await store.finalize(created.id);
    expect(done.chunkCount).toBe(2);
    expect(done.camera).toMatchObject({ chunkCount: 2, totalSize: 3 });
    expect([...await readFile(done.camera!.finalFile!)]).toEqual([7, 8, 9]);
    expect([...await readFile(done.finalFile!)]).toEqual([1, 2, 3]);
  });

  it("stores measured camera info with clamping", async () => {
    const created = await store.create(options, "video/webm", { mimeType: "video/webm", startOffsetMs: 0, aspect: 16 / 9 });
    const updated = await store.setCameraInfo(created.id, { aspect: 1.5, startOffsetMs: -4_000 });
    expect(updated.camera).toMatchObject({ aspect: 1.5, startOffsetMs: -2_000 });
  });

  it("drops an empty camera track without failing the screen recording", async () => {
    const created = await store.create(options, "video/webm", { mimeType: "video/webm", startOffsetMs: 0, aspect: 16 / 9 });
    await store.appendChunk(created.id, Uint8Array.from([1]));
    const done = await store.finalize(created.id);
    expect(done.status).toBe("ready");
    expect(done.camera).toBeUndefined();
  });

  it("keeps the screen recording when the camera reports an error", async () => {
    const created = await store.create(options, "video/webm", { mimeType: "video/webm", startOffsetMs: 0, aspect: 16 / 9 });
    await store.appendChunk(created.id, Uint8Array.from([1]));
    await store.setCameraError(created.id, "disk full");
    const done = await store.finalize(created.id);
    expect(done.status).toBe("ready");
    expect(done.camera?.error).toBe("disk full");
  });

  it("works for recordings without a camera", async () => {
    const created = await store.create(options, "video/webm");
    await store.appendChunk(created.id, Uint8Array.from([1]));
    const done = await store.finalize(created.id);
    expect(done.camera).toBeUndefined();
    await expect(store.appendCameraChunk(created.id, Uint8Array.from([1]))).rejects.toThrow();
  });
});
