import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordingManifest, RecordingOptions, RecordingStatus } from "@zapture/recorder-core";
import { extensionFromMimeType, recordingDuration } from "@zapture/recorder-core";

const RECORDING_ID = /^[0-9a-f-]{36}$/i;

export class RecordingStore {
  constructor(private readonly root: string) {}

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

  async create(options: RecordingOptions, mimeType: string) {
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
    });
  }

  async get(id: string) {
    const data = await readFile(this.manifestPath(id), "utf8");
    return JSON.parse(data) as RecordingManifest;
  }

  async patch(id: string, changes: Partial<RecordingManifest>) {
    const current = await this.get(id);
    return this.writeManifest({ ...current, ...changes, id: current.id });
  }

  async appendChunk(id: string, data: Uint8Array) {
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
      durationMs: recordingDuration(current.startedAt),
    });
  }

  async setStatus(id: string, status: RecordingStatus) {
    return this.patch(id, { status });
  }

  async finalize(id: string) {
    let manifest = await this.patch(id, { status: "finalizing" });
    if (manifest.chunkCount === 0) throw new Error("Recording contains no media chunks");

    const finalFile = join(this.directory(id), `recording.${manifest.extension}`);
    await writeFile(finalFile, new Uint8Array(), { flag: "w" });
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const chunk = await readFile(join(this.directory(id), `chunk-${String(index).padStart(6, "0")}.bin`));
      await appendFile(finalFile, chunk);
    }

    const stoppedAt = Date.now();
    manifest = await this.patch(id, {
      status: "ready",
      stoppedAt,
      durationMs: recordingDuration(manifest.startedAt, stoppedAt),
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
