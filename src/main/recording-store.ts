import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CameraTrackManifest, RecordingManifest, RecordingOptions, RecordingStatus } from "@zapture/recorder-core";
import { clampCameraOffsetMs, extensionFromMimeType, pauseTimingFor, recordingDuration } from "@zapture/recorder-core";

function normalizeAspect(aspect: number) {
  return Number.isFinite(aspect) && aspect >= 0.25 && aspect <= 4 ? aspect : 16 / 9;
}

const RECORDING_ID = /^[0-9a-f-]{36}$/i;

export interface CameraTrackInit {
  mimeType: string;
  startOffsetMs: number;
  aspect: number;
}

export class RecordingStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  /** Screen and camera chunks both rewrite the manifest, so mutations per recording run one at a time. */
  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
    const tail: Promise<unknown> = run.catch(() => undefined).finally(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    this.locks.set(id, tail);
    return run;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
  }

  private directory(id: string) {
    if (!RECORDING_ID.test(id)) throw new Error("Invalid recording ID");
    return join(this.root, id);
  }

  private manifestPath(id: string) {
    return join(this.directory(id), "manifest.json");
  }

  private async writeManifest(manifest: RecordingManifest) {
    const path = this.manifestPath(manifest.id);
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
    return manifest;
  }

  async create(options: RecordingOptions, mimeType: string, camera?: CameraTrackInit) {
    const id = crypto.randomUUID();
    await mkdir(this.directory(id), { recursive: true });
    return this.writeManifest({
      id,
      status: "recording",
      options,
      mimeType: mimeType.split(";")[0],
      extension: extensionFromMimeType(mimeType),
      startedAt: Date.now(),
      durationMs: 0,
      chunkCount: 0,
      totalSize: 0,
      ...(camera ? {
        camera: {
          mimeType: camera.mimeType.split(";")[0],
          extension: extensionFromMimeType(camera.mimeType),
          chunkCount: 0,
          totalSize: 0,
          startOffsetMs: clampCameraOffsetMs(camera.startOffsetMs),
          aspect: normalizeAspect(camera.aspect),
        },
      } : {}),
    });
  }

  async get(id: string) {
    const data = await readFile(this.manifestPath(id), "utf8");
    return JSON.parse(data) as RecordingManifest;
  }

  private async patchNow(id: string, changes: Partial<RecordingManifest>) {
    const current = await this.get(id);
    return this.writeManifest({ ...current, ...changes, id: current.id });
  }

  appendChunk(id: string, data: Uint8Array) {
    return this.serial(id, () => this.appendChunkNow(id, data));
  }

  appendCameraChunk(id: string, data: Uint8Array) {
    return this.serial(id, async () => {
      const current = await this.get(id);
      if (current.status !== "recording" && current.status !== "paused") {
        throw new Error(`Cannot append to a ${current.status} recording`);
      }
      if (!current.camera) throw new Error("Recording has no camera track");
      const chunkName = `camera-chunk-${String(current.camera.chunkCount).padStart(6, "0")}.bin`;
      await writeFile(join(this.directory(id), chunkName), data, { flag: "wx" });
      return this.writeManifest({
        ...current,
        camera: {
          ...current.camera,
          chunkCount: current.camera.chunkCount + 1,
          totalSize: current.camera.totalSize + data.byteLength,
        },
      });
    });
  }

  /** Records a camera-only failure; the screen recording is unaffected. */
  setCameraError(id: string, error: string) {
    return this.serial(id, async () => {
      const current = await this.get(id);
      if (!current.camera) return current;
      return this.writeManifest({ ...current, camera: { ...current.camera, error } });
    });
  }

  /** Sets the measured start skew and frame aspect once the camera recorder has started or stopped. */
  setCameraInfo(id: string, info: { aspect?: number; startOffsetMs?: number }) {
    return this.serial(id, async () => {
      const current = await this.get(id);
      if (!current.camera) return current;
      const camera = { ...current.camera };
      if (info.aspect !== undefined) camera.aspect = normalizeAspect(info.aspect);
      if (info.startOffsetMs !== undefined) camera.startOffsetMs = clampCameraOffsetMs(info.startOffsetMs);
      return this.writeManifest({ ...current, camera });
    });
  }

  private async appendChunkNow(id: string, data: Uint8Array) {
    const current = await this.get(id);
    if (current.status !== "recording" && current.status !== "paused") {
      throw new Error(`Cannot append to a ${current.status} recording`);
    }
    const chunkName = `chunk-${String(current.chunkCount).padStart(6, "0")}.bin`;
    await writeFile(join(this.directory(id), chunkName), data, { flag: "wx" });
    return this.writeManifest({
      ...current,
      chunkCount: current.chunkCount + 1,
      totalSize: current.totalSize + data.byteLength,
      durationMs: recordingDuration(current),
    });
  }

  setStatus(id: string, status: Extract<RecordingStatus, "paused" | "recording">) {
    return this.serial(id, async () => {
      const current = await this.get(id);
      const timing = pauseTimingFor(current, status);
      return this.writeManifest({ ...current, ...timing, status, durationMs: recordingDuration({ ...current, ...timing }) });
    });
  }

  patch(id: string, changes: Partial<RecordingManifest>) {
    return this.serial(id, () => this.patchNow(id, changes));
  }

  finalize(id: string) {
    return this.serial(id, () => this.finalizeNow(id));
  }

  private async finalizeCamera(id: string, camera: CameraTrackManifest | undefined): Promise<CameraTrackManifest | undefined> {
    if (!camera) return undefined;
    if (camera.finalFile) return camera;
    if (camera.chunkCount === 0) {
      // Never produced media: drop the track unless a write error explains why.
      return camera.error ? camera : undefined;
    }
    try {
      const finalFile = join(this.directory(id), `camera.${camera.extension}`);
      await writeFile(finalFile, new Uint8Array(), { flag: "w" });
      for (let index = 0; index < camera.chunkCount; index += 1) {
        await appendFile(finalFile, await readFile(join(this.directory(id), `camera-chunk-${String(index).padStart(6, "0")}.bin`)));
      }
      const size = (await stat(finalFile)).size;
      if (size === 0) return { ...camera, error: camera.error ?? "Camera track was empty" };
      return { ...camera, finalFile, totalSize: size };
    } catch (error) {
      return { ...camera, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async finalizeNow(id: string) {
    let manifest = await this.patchNow(id, { status: "finalizing" });
    if (manifest.chunkCount === 0) throw new Error("Recording contains no media chunks");

    const finalFile = join(this.directory(id), `recording.${manifest.extension}`);
    await writeFile(finalFile, new Uint8Array(), { flag: "w" });
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const chunk = await readFile(join(this.directory(id), `chunk-${String(index).padStart(6, "0")}.bin`));
      await appendFile(finalFile, chunk);
    }

    const stoppedAt = Date.now();
    const timing = pauseTimingFor(manifest, "recording", stoppedAt);
    const camera = await this.finalizeCamera(id, manifest.camera);
    manifest = await this.patchNow(id, {
      ...timing,
      camera,
      status: "ready",
      stoppedAt,
      durationMs: recordingDuration({ ...manifest, ...timing }, stoppedAt),
      finalFile,
      totalSize: (await stat(finalFile)).size,
      error: undefined,
    });
    return manifest;
  }

  async list() {
    await this.initialize();
    const entries = await readdir(this.root, { withFileTypes: true });
    const manifests: RecordingManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RECORDING_ID.test(entry.name)) continue;
      try {
        const manifest = await this.get(entry.name);
        if (["recording", "paused", "finalizing"].includes(manifest.status) && manifest.chunkCount > 0) {
          manifests.push(await this.finalize(entry.name));
        } else {
          manifests.push(manifest);
        }
      } catch (error) {
        console.warn("Could not load recording manifest", entry.name, error);
      }
    }
    return manifests.sort((a, b) => b.startedAt - a.startedAt);
  }

  async delete(id: string) {
    await rm(this.directory(id), { recursive: true, force: true });
  }

  async requireManifestWithFile(id: string) {
    const manifest = await this.get(id);
    if (!manifest.finalFile) throw new Error("Recording has not been finalized");
    await stat(manifest.finalFile);
    return manifest;
  }

}
