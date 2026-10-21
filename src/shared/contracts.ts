import type { CameraCorner, CameraShape, CameraSize, RecordingManifest, RecordingOptions } from "@zapture/recorder-core";

export interface CameraTrackStart {
  mimeType: string;
  startOffsetMs: number;
  aspect: number;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export interface AuthState {
  authenticated: boolean;
  canUpload: boolean;
  error?: string;
  user?: { id: string; email: string; name?: string; avatar?: string };
}

export type AuthMode = "sign-in" | "sign-up";

export interface UploadProgress {
  phase: "preparing" | "uploading" | "finalizing" | "complete" | "camera";
  uploadedBytes: number;
  totalBytes: number;
  message: string;
  shareUrl?: string;
}

/** What the floating recording HUD shows; `null` hides it. */
export interface RecordingHudState {
  status: "countdown" | "recording" | "paused";
  /** Seconds left while counting down. */
  countdown?: number;
  /** Active recording time at `updatedAt`; the HUD ticks forward from it while recording. */
  elapsedMs: number;
  updatedAt: number;
}

/** What the floating camera bubble shows; `null` hides it. */
export interface CameraBubbleState {
  /** Camera to open; the system default when omitted. */
  deviceId?: string;
  shape: CameraShape;
  size: Exclude<CameraSize, "off">;
  /** Corner of the display where the bubble first appears. */
  corner: CameraCorner;
}

export type RecordingCommand = "pause" | "resume" | "stop" | "cancel";

/** Application menu actions forwarded to the recorder window. */
export type MenuCommand = "stop-recording" | "show-library";

export interface DesktopApi {
  platform: string;
  getSources: () => Promise<CaptureSource[]>;
  beginRecording: (options: RecordingOptions, mimeType: string, camera?: CameraTrackStart) => Promise<RecordingManifest>;
  appendChunk: (id: string, chunk: ArrayBuffer) => Promise<RecordingManifest>;
  appendCameraChunk: (id: string, chunk: ArrayBuffer) => Promise<RecordingManifest>;
  /** Reports a camera-only failure or the measured frame aspect; the screen recording is unaffected. */
  reportCameraTrack: (id: string, report: { error?: string; aspect?: number; startOffsetMs?: number }) => Promise<void>;
  setRecordingStatus: (id: string, status: "paused" | "recording") => Promise<RecordingManifest>;
  finalizeRecording: (id: string) => Promise<RecordingManifest>;
  deleteRecording: (id: string) => Promise<void>;
  listRecordings: () => Promise<RecordingManifest[]>;
  uploadRecording: (id: string, title: string, description: string) => Promise<RecordingManifest>;
  getAuthState: () => Promise<AuthState>;
  authenticate: (mode: AuthMode) => Promise<AuthState>;
  continueLocally: () => Promise<void>;
  signOut: () => Promise<void>;
  openEditor: (videoId: string) => Promise<void>;
  checkForUpdates: () => Promise<{ status: string; message: string }>;
  onPrepareRecording: (listener: () => void) => () => void;
  onAuthStateChanged: (listener: (state: AuthState) => void) => () => void;
  onUploadProgress: (listener: (progress: UploadProgress) => void) => () => void;
  /** Recorder window: show, update, or hide (`null`) the floating HUD. */
  setRecordingHud: (state: RecordingHudState | null) => Promise<void>;
  /** HUD window: ask the recorder window to pause, resume, stop, or cancel. */
  sendRecordingCommand: (command: RecordingCommand) => Promise<void>;
  /** Recorder window: show, update, or hide (`null`) the floating camera bubble. */
  setCameraBubble: (state: CameraBubbleState | null) => Promise<void>;
  /** Camera bubble window: its camera failed, so close it quietly. */
  reportCameraBubbleFailure: (reason: string) => Promise<void>;
  onCameraBubble: (listener: (state: CameraBubbleState | null) => void) => () => void;
  onRecordingHud: (listener: (state: RecordingHudState | null) => void) => () => void;
  onRecordingCommand: (listener: (command: RecordingCommand) => void) => () => void;
  onMenuCommand: (listener: (command: MenuCommand) => void) => () => void;
}
