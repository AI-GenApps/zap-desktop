export const RECORDING_TIMESLICE_MS = 3_000;
export const MAX_RECORDING_DURATION_MS = 60 * 60 * 1_000;
export const MAX_UPLOAD_SIZE_BYTES = 5 * 1_024 * 1_024 * 1_024;
export const UPLOAD_PART_SIZE_BYTES = 8 * 1_024 * 1_024;

/** Must match the video-handler camera upload part size. */
export const CAMERA_PART_SIZE_BYTES = UPLOAD_PART_SIZE_BYTES;
export const CAMERA_MAX_OFFSET_MS = 2_000;

export type CaptureMode = "screen" | "window";
export type CameraSize = "off" | "small" | "medium" | "large";
export type CameraCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CameraShape = "circle" | "rounded";
/** `separate` records the camera as its own file; `burned-in` composites it into the screen video. */
export type CameraMode = "separate" | "burned-in";
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
  /** Absent in old manifests; treated as "circle". */
  cameraShape?: CameraShape;
  /** Absent in old manifests; treated as "separate" when a camera is on. */
  cameraMode?: CameraMode;
}

export interface CameraLayout {
  visible: boolean;
  corner: CameraCorner;
  size: Exclude<CameraSize, "off">;
  shape: CameraShape;
}

export interface CameraTrackManifest {
  mimeType: string;
  extension: "webm" | "mp4";
  chunkCount: number;
  totalSize: number;
  /** cameraRecorderStartedAt - screenRecorderStartedAt, clamped; positive means the camera started later. */
  startOffsetMs: number;
  /** Width / height of the camera frames. */
  aspect: number;
  finalFile?: string;
  uploaded?: boolean;
  /** Camera-only failure; never blocks the screen recording. */
  error?: string;
}

export interface RecordingManifest {
  id: string;
  status: RecordingStatus;
  options: RecordingOptions;
  mimeType: string;
  extension: "webm" | "mp4";
  startedAt: number;
  stoppedAt?: number;
  /** Set while paused; the pause is folded into `pausedMs` on resume or stop. */
  pausedAt?: number;
  /** Total completed pause time, excluded from `durationMs`. */
  pausedMs?: number;
  durationMs: number;
  chunkCount: number;
  totalSize: number;
  finalFile?: string;
  videoId?: string;
  shareUrl?: string;
  error?: string;
  camera?: CameraTrackManifest;
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

/** Active recording time: wall time since start, minus completed and in-progress pauses. */
export function recordingDuration(
  timing: Pick<RecordingManifest, "startedAt" | "pausedAt" | "pausedMs">,
  now = Date.now(),
) {
  const currentPause = timing.pausedAt ? Math.max(0, now - timing.pausedAt) : 0;
  return Math.max(0, now - timing.startedAt - (timing.pausedMs ?? 0) - currentPause);
}

/** Pause bookkeeping for a status change; a repeated status is a no-op. */
export function pauseTimingFor(
  timing: Pick<RecordingManifest, "pausedAt" | "pausedMs">,
  status: "paused" | "recording",
  now = Date.now(),
): Pick<RecordingManifest, "pausedAt" | "pausedMs"> {
  if (status === "paused") return { pausedAt: timing.pausedAt ?? now, pausedMs: timing.pausedMs ?? 0 };
  const completed = timing.pausedAt ? Math.max(0, now - timing.pausedAt) : 0;
  return { pausedAt: undefined, pausedMs: (timing.pausedMs ?? 0) + completed };
}

/** Layout to publish for a separate camera track; null when there is no separate camera. */
export function cameraLayoutFromOptions(
  options: Pick<RecordingOptions, "cameraSize" | "cameraCorner" | "cameraShape" | "cameraMode">,
): CameraLayout | null {
  if (options.cameraSize === "off" || options.cameraMode === "burned-in") return null;
  return { visible: true, corner: options.cameraCorner, size: options.cameraSize, shape: options.cameraShape ?? "circle" };
}

/** Clamps the camera start skew to an integer within +-2000 ms. */
export function clampCameraOffsetMs(ms: number) {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-CAMERA_MAX_OFFSET_MS, Math.min(CAMERA_MAX_OFFSET_MS, Math.round(ms))) || 0;
}

export function pickCameraRecorderMimeType(isSupported: (mimeType: string) => boolean) {
  return ["video/webm;codecs=vp8", "video/webm"].find(isSupported) ?? null;
}
