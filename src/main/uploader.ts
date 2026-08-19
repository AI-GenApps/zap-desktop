import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Session } from "electron";
import { UPLOAD_PART_SIZE_BYTES } from "@zapture/recorder-core";
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

export async function uploadRecording(
  store: RecordingStore,
  session: Session,
  id: string,
  input: { title: string; description: string },
  onProgress: (progress: UploadProgress) => void,
) {
  let manifest = await store.requireManifestWithFile(id);
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
    return manifest;
  } catch (error) {
    await store.patch(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await file.close();
  }
}
