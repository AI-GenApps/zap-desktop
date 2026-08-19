import { join } from "node:path";
import { z } from "zod";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import type { AuthState } from "../shared/contracts";
import { RecordingStore } from "./recording-store";
import { DesktopUpdater } from "./updater";
import { uploadRecording } from "./uploader";

const API_BASE_URL = "https://zapture.app";
const AUTH_ORIGIN = "https://auth.w3dev.app";
const partition = "persist:zapture";
let mainWindow: BrowserWindow | null = null;
let editorWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: RecordingStore;
let updater: DesktopUpdater;
let isQuitting = false;

const optionsSchema = z.object({
  sourceId: z.string().min(1),
  sourceName: z.string().min(1),
  captureMode: z.enum(["screen", "window"]),
  includeSystemAudio: z.boolean(),
  microphoneDeviceId: z.string().optional(),
  cameraDeviceId: z.string().optional(),
  cameraSize: z.enum(["off", "small", "medium", "large"]),
  cameraCorner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
});

function trustedLocalOrigin(origin: string) {
  return origin === "null" || origin.startsWith("file://") || origin.startsWith("http://localhost:");
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#10100f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(API_BASE_URL)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("http://localhost:")) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  win.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function showMainWindow() {
  const win = !mainWindow || mainWindow.isDestroyed() ? createMainWindow() : mainWindow;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function prepareRecording() {
  const win = showMainWindow();
  const notify = () => win.webContents.send("desktop:prepare-recording");
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", notify);
  else notify();
}

function createEditorWindow(videoId: string) {
  editorWindow?.close();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#090909",
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(API_BASE_URL) || url.startsWith(AUTH_ORIGIN)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(API_BASE_URL) && !url.startsWith(AUTH_ORIGIN)) event.preventDefault();
  });
  void win.loadURL(`${API_BASE_URL}/editor/${encodeURIComponent(videoId)}`);
  editorWindow = win;
}

async function getAuthState(): Promise<AuthState> {
  try {
    const response = await session.fromPartition(partition).fetch(`${API_BASE_URL}/api/user`, { credentials: "include" });
    if (!response.ok) return { authenticated: false, canUpload: false };
    return (await response.json()) as AuthState;
  } catch {
    return { authenticated: false, canUpload: false };
  }
}

async function signIn() {
  const authWindow = new BrowserWindow({
    width: 520,
    height: 760,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  authWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await authWindow.loadURL(`${API_BASE_URL}/console`);

  return new Promise<AuthState>((resolve) => {
    let settled = false;
    const check = async () => {
      const state = await getAuthState();
      if (state.authenticated && !settled) {
        settled = true;
        authWindow.close();
        resolve(state);
      }
    };
    authWindow.webContents.on("did-navigate", () => void check());
    authWindow.webContents.on("did-navigate-in-page", () => void check());
    authWindow.on("closed", async () => {
      if (!settled) resolve(await getAuthState());
    });
  });
}

function configureSession() {
  const appSession = session.fromPartition(partition);
  appSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    permission === "media" && trustedLocalOrigin(requestingOrigin),
  );
  appSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const isMainRenderer = webContents === mainWindow?.webContents;
    callback(permission === "media" && isMainRenderer && trustedLocalOrigin(new URL(webContents.getURL()).origin));
  });
  return appSession;
}

function registerIpc() {
  ipcMain.handle("desktop:get-sources", async () => {
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
      throw new Error("Screen Recording permission is denied. Enable Zapture in System Settings > Privacy & Security.");
    }
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: source.thumbnail.toDataURL(),
    }));
  });
  ipcMain.handle("desktop:begin-recording", (_event, options, mimeType) => store.create(optionsSchema.parse(options), z.string().min(1).parse(mimeType)));
  ipcMain.handle("desktop:append-chunk", (_event, id, chunk) => store.appendChunk(z.string().uuid().parse(id), new Uint8Array(chunk)));
  ipcMain.handle("desktop:set-status", (_event, id, status) => store.setStatus(z.string().uuid().parse(id), z.enum(["paused", "recording"]).parse(status)));
  ipcMain.handle("desktop:finalize", (_event, id) => store.finalize(z.string().uuid().parse(id)));
  ipcMain.handle("desktop:delete", (_event, id) => store.delete(z.string().uuid().parse(id)));
  ipcMain.handle("desktop:list-recordings", () => store.list());
  ipcMain.handle("desktop:upload", async (event, id, title, description) => uploadRecording(
    store,
    session.fromPartition(partition),
    z.string().uuid().parse(id),
    { title: z.string().trim().min(1).max(180).parse(title), description: z.string().max(2_000).parse(description) },
    (progress) => event.sender.send("desktop:upload-progress", progress),
  ));
  ipcMain.handle("desktop:get-auth", () => getAuthState());
  ipcMain.handle("desktop:sign-in", () => signIn());
  ipcMain.handle("desktop:sign-out", async () => {
    await session.fromPartition(partition).fetch(`${API_BASE_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
    await session.fromPartition(partition).clearStorageData({ storages: ["cookies", "localstorage"] });
  });
  ipcMain.handle("desktop:open-editor", (_event, id) => createEditorWindow(z.string().uuid().parse(id)));
  ipcMain.handle("desktop:check-updates", () => updater.check());
}

function configureTray() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "build", "tray-icon.png")
    : join(__dirname, "../../build/tray-icon.png");
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Zapture");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Start Recording…", accelerator: "CommandOrControl+Shift+5", click: prepareRecording },
    { label: "Open Zapture", click: showMainWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", showMainWindow);
}

app.whenReady().then(async () => {
  const appSession = configureSession();
  store = new RecordingStore(join(app.getPath("userData"), "recordings"));
  await store.initialize();
  updater = new DesktopUpdater(appSession, () => mainWindow);
  registerIpc();
  const win = createMainWindow();
  configureTray();
  globalShortcut.register("CommandOrControl+Shift+5", prepareRecording);
  updater.start();

  if (process.argv.includes("--ci-smoke")) {
    win.webContents.once("did-finish-load", () => {
      console.log("Zapture desktop smoke check passed");
      app.quit();
    });
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", showMainWindow);
app.on("before-quit", () => {
  isQuitting = true;
});
app.on("will-quit", () => {
  updater?.stop();
  globalShortcut.unregisterAll();
});
