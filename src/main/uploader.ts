import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Session } from "electron";
import { CAMERA_PART_SIZE_BYTES, UPLOAD_PART_SIZE_BYTES, cameraLayoutFromOptions, type RecordingManifest } from "@zapture/recorder-core";
import type { UploadProgress } from "../shared/contracts";
import type { RecordingStore } from "./recording-store";

const API_BASE_URL = "https://zapture.app";

interface UploadSession {
  videoId: string;
  uploadId: string;
  extension: "webm" | "mp4";
  expectedPartCount: number;
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(data.error || data.message || `Zapture request failed (${response.status})`);
  }
  return data;
}

/** Uploads the separate camera file after the screen upload; throws on failure, the caller decides how fatal that is. */
async function uploadCameraTrack(
  store: RecordingStore,
  session: Session,
  id: string,
  videoId: string,
  onProgress: (progress: UploadProgress) => void,
) {
  const manifest = await store.get(id);
  const camera = manifest.camera;
  if (!camera?.finalFile || camera.uploaded) return manifest;
  const base = `${API_BASE_URL}/api/console/videos/${encodeURIComponent(videoId)}/camera`;
  const layout = cameraLayoutFromOptions(manifest.options);
  if (!layout) return manifest;
  const file = await open(camera.finalFile, "r");
  try {
    const size = (await file.stat()).size;
    if (size <= 0) throw new Error("Camera file is empty");
    onProgress({ phase: "camera", uploadedBytes: 0, totalBytes: size, message: "Uploading camera track" });
    const upload = await responseJson<{ uploadId: string; extension: "webm" | "mp4"; expectedPartCount: number }>(
      await session.fetch(`${base}/init`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension: camera.extension, contentType: camera.mimeType, size }),
      }),
    );

    const parts: { partNumber: number; etag: string }[] = [];
    let uploadedBytes = 0;
    for (let partNumber = 1; partNumber <= upload.expectedPartCount; partNumber += 1) {
      const partSize = Math.min(CAMERA_PART_SIZE_BYTES, size - uploadedBytes);
      const buffer = Buffer.allocUnsafe(partSize);
      const { bytesRead } = await file.read(buffer, 0, partSize, uploadedBytes);
      if (bytesRead !== partSize) throw new Error(`Camera part ${partNumber} is incomplete`);
      const data = buffer.subarray(0, bytesRead);
      onProgress({
        phase: "camera",
        uploadedBytes,
        totalBytes: size,
        message: `Uploading camera track, part ${partNumber} of ${upload.expectedPartCount}`,
      });
      const part = await responseJson<{ partNumber: number; etag: string }>(
        await session.fetch(`${base}/${upload.extension}/${encodeURIComponent(upload.uploadId)}/parts/${partNumber}`, {
          method: "PUT",
          credentials: "include",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-zapture-part-size": String(bytesRead),
            "x-zapture-part-sha256": createHash("sha256").update(data).digest("hex"),
          },
          body: new Uint8Array(data),
        }),
      );
      parts.push({ partNumber, etag: part.etag });
      uploadedBytes += bytesRead;
    }

    await responseJson(
      await session.fetch(`${base}/${upload.extension}/${encodeURIComponent(upload.uploadId)}/complete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size,
          parts,
          durationMs: Math.min(3_600_000, Math.max(0, Math.round(manifest.durationMs))),
          startOffsetMs: camera.startOffsetMs,
          aspect: camera.aspect,
          layout,
        }),
      }),
    );
    const latest = await store.get(id);
    return store.patch(id, { camera: { ...(latest.camera ?? camera), uploaded: true, error: undefined } });
  } finally {
    await file.close();
  }
}

/** Camera upload that never fails the recording: the error is stored on the manifest for a later retry. */
async function uploadCameraNonFatal(
  store: RecordingStore,
  session: Session,
  id: string,
  videoId: string,
  onProgress: (progress: UploadProgress) => void,
  shareUrl: string | undefined,
): Promise<RecordingManifest> {
  try {
    return await uploadCameraTrack(store, session, id, videoId, onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Bookkeeping must not throw: the screen is already uploaded and must not be marked failed.
    const updated = await (async () => {
      try {
        const latest = await store.get(id);
        return latest.camera ? await store.patch(id, { camera: { ...latest.camera, error: message } }) : latest;
      } catch {
        return store.get(id).catch(() => undefined);
      }
    })();
    onProgress({ phase: "complete", uploadedBytes: 0, totalBytes: updated?.totalSize ?? 0, message: "Camera track will retry", shareUrl });
    return updated ?? ({ id } as RecordingManifest);
  }
}

export async function uploadRecording(
  store: RecordingStore,
  session: Session,
  id: string,
  input: { title: string; description: string },
  onProgress: (progress: UploadProgress) => void,
) {
  let manifest = await store.get(id);
  // Retry path: the screen file is already on the server, only the camera track is missing.
  if (manifest.status === "uploaded" && manifest.videoId && manifest.camera?.finalFile && !manifest.camera.uploaded) {
    onProgress({ phase: "camera", uploadedBytes: 0, totalBytes: manifest.camera.totalSize, message: "Uploading camera track" });
    const updated = await uploadCameraTrack(store, session, id, manifest.videoId, onProgress).catch(async (error) => {
      const latest = await store.get(id);
      if (latest.camera) await store.patch(id, { camera: { ...latest.camera, error: error instanceof Error ? error.message : String(error) } });
      throw error;
    });
    onProgress({ phase: "complete", uploadedBytes: 0, totalBytes: updated.totalSize, message: "Camera track uploaded", shareUrl: updated.shareUrl });
    return updated;
  }
  manifest = await store.requireManifestWithFile(id);
  const file = await open(manifest.finalFile!, "r");
  await store.patch(id, { status: "uploading", error: undefined });

  try {
    onProgress({ phase: "preparing", uploadedBytes: 0, totalBytes: manifest.totalSize, message: "Preparing secure upload" });
    const initResponse = await session.fetch(`${API_BASE_URL}/api/console/videos/resumable/init`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        durationMs: manifest.durationMs,
        fileName: `zapture-${manifest.startedAt}.${manifest.extension}`,
        contentType: manifest.mimeType,
        size: manifest.totalSize,
      }),
    });
    const upload = await responseJson<UploadSession>(initResponse);

    let uploadedBytes = 0;
    for (let partNumber = 1; partNumber <= upload.expectedPartCount; partNumber += 1) {
      const remaining = manifest.totalSize - uploadedBytes;
      const partSize = Math.min(UPLOAD_PART_SIZE_BYTES, remaining);
      const buffer = Buffer.allocUnsafe(partSize);
      const { bytesRead } = await file.read(buffer, 0, partSize, uploadedBytes);
      if (bytesRead !== partSize) throw new Error(`Recording part ${partNumber} is incomplete`);
      const data = buffer.subarray(0, bytesRead);
      const sha256 = createHash("sha256").update(data).digest("hex");

      onProgress({
        phase: "uploading",
        uploadedBytes,
        totalBytes: manifest.totalSize,
        message: `Uploading part ${partNumber} of ${upload.expectedPartCount}`,
      });
      const partResponse = await session.fetch(
        `${API_BASE_URL}/api/console/videos/resumable/${upload.videoId}/${upload.extension}/${encodeURIComponent(upload.uploadId)}/parts/${partNumber}`,
        {
          method: "PUT",
          credentials: "include",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-zapture-part-size": String(bytesRead),
            "x-zapture-part-sha256": sha256,
          },
          body: new Uint8Array(data),
        },
      );
      await responseJson(partResponse);
      uploadedBytes += bytesRead;
    }

    onProgress({ phase: "finalizing", uploadedBytes, totalBytes: manifest.totalSize, message: "Verifying recording" });
    const completeResponse = await session.fetch(
      `${API_BASE_URL}/api/console/videos/resumable/${upload.videoId}/${upload.extension}/${encodeURIComponent(upload.uploadId)}/complete`,
      { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    const completed = await responseJson<{ id: string; shareUrl: string }>(completeResponse);
    const shareUrl = new URL(completed.shareUrl || `/share/${completed.id}`, API_BASE_URL).toString();
    manifest = await store.patch(id, { status: "uploaded", videoId: completed.id, shareUrl });
    onProgress({ phase: "complete", uploadedBytes, totalBytes: manifest.totalSize, message: "Ready to edit", shareUrl });
    // Serial on purpose: the camera goes after the screen, and its failure never rolls the screen back.
    if (manifest.camera?.finalFile && !manifest.camera.uploaded) {
      manifest = await uploadCameraNonFatal(store, session, id, completed.id, onProgress, shareUrl);
    }
    return manifest;
  } catch (error) {
    await store.patch(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await file.close();
  }
}
