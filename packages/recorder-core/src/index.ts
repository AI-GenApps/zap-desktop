export const RECORDING_TIMESLICE_MS = 3_000;
export const MAX_RECORDING_DURATION_MS = 60 * 60 * 1_000;
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1_024 * 1_024 * 1_024;
export const UPLOAD_PART_SIZE_BYTES = 8 * 1_024 * 1_024;

export type CaptureMode = "screen" | "window";
export type CameraSize = "off" | "small" | "medium" | "large";
export type CameraCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type RecordingStatus =
  | "recording"
  | "paused"
  | "finalizing"
  | "ready"
  | "uploading"
  | "uploaded"
  | "failed";

export interface RecordingOptions {
  sourceId: string;
  sourceName: string;
  captureMode: CaptureMode;
  includeSystemAudio: boolean;
  microphoneDeviceId?: string;
  cameraDeviceId?: string;
  cameraSize: CameraSize;
  cameraCorner: CameraCorner;
}

export interface RecordingManifest {
  id: string;
  status: RecordingStatus;
  options: RecordingOptions;
  mimeType: string;
  extension: "webm" | "mp4";
  startedAt: number;
  stoppedAt?: number;
  durationMs: number;
  chunkCount: number;
  totalSize: number;
  finalFile?: string;
  videoId?: string;
  shareUrl?: string;
  error?: string;
}

export interface UploadPart {
  partNumber: number;
  data: Uint8Array;
  size: number;
}

export async function* buildUploadParts(
  chunks: AsyncIterable<Uint8Array>,
  partSize = UPLOAD_PART_SIZE_BYTES,
): AsyncGenerator<UploadPart> {
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new Error("Upload part size must be a positive integer");
  }

  let partNumber = 1;
  let pending = new Uint8Array(partSize);
  let pendingSize = 0;

  for await (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(partSize - pendingSize, chunk.byteLength - offset);
      pending.set(chunk.subarray(offset, offset + take), pendingSize);
      pendingSize += take;
      offset += take;

      if (pendingSize === partSize) {
        yield { partNumber, data: pending, size: pendingSize };
        partNumber += 1;
        pending = new Uint8Array(partSize);
        pendingSize = 0;
      }
    }
  }

  if (pendingSize > 0) {
    yield { partNumber, data: pending.slice(0, pendingSize), size: pendingSize };
  }
}

export function extensionFromMimeType(mimeType: string): "webm" | "mp4" {
  return mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

export function pickRecorderMimeType(isSupported: (mimeType: string) => boolean) {
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find(isSupported) ?? null;
}

export function recordingDuration(startedAt: number, stoppedAt = Date.now()) {
  return Math.max(0, stoppedAt - startedAt);
}
