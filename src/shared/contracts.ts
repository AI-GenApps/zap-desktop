import type { RecordingManifest, RecordingOptions } from "@zapture/recorder-core";

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
  phase: "preparing" | "uploading" | "finalizing" | "complete";
  uploadedBytes: number;
  totalBytes: number;
  message: string;
  shareUrl?: string;
}

export interface DesktopApi {
  platform: string;
  getSources: () => Promise<CaptureSource[]>;
  beginRecording: (options: RecordingOptions, mimeType: string) => Promise<RecordingManifest>;
  appendChunk: (id: string, chunk: ArrayBuffer) => Promise<RecordingManifest>;
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
}
