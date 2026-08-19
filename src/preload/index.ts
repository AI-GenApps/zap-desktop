import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, UploadProgress } from "../shared/contracts";

const api: DesktopApi = {
  platform: process.platform,
  getSources: () => ipcRenderer.invoke("desktop:get-sources"),
  beginRecording: (options, mimeType) => ipcRenderer.invoke("desktop:begin-recording", options, mimeType),
  appendChunk: (id, chunk) => ipcRenderer.invoke("desktop:append-chunk", id, chunk),
  setRecordingStatus: (id, status) => ipcRenderer.invoke("desktop:set-status", id, status),
  finalizeRecording: (id) => ipcRenderer.invoke("desktop:finalize", id),
  deleteRecording: (id) => ipcRenderer.invoke("desktop:delete", id),
  listRecordings: () => ipcRenderer.invoke("desktop:list-recordings"),
  uploadRecording: (id, title, description) => ipcRenderer.invoke("desktop:upload", id, title, description),
  getAuthState: () => ipcRenderer.invoke("desktop:get-auth"),
  authenticate: (mode) => ipcRenderer.invoke("desktop:authenticate", mode),
  continueLocally: () => ipcRenderer.invoke("desktop:continue-locally"),
  signOut: () => ipcRenderer.invoke("desktop:sign-out"),
  openEditor: (videoId) => ipcRenderer.invoke("desktop:open-editor", videoId),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
  onPrepareRecording: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("desktop:prepare-recording", handler);
    return () => ipcRenderer.removeListener("desktop:prepare-recording", handler);
  },
  onAuthStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("desktop:auth-state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:auth-state-changed", handler);
  },
  onUploadProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: UploadProgress) => listener(progress);
    ipcRenderer.on("desktop:upload-progress", handler);
    return () => ipcRenderer.removeListener("desktop:upload-progress", handler);
  },
};

contextBridge.exposeInMainWorld("zapture", Object.freeze(api));
