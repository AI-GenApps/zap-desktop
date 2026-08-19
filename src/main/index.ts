import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import type { AuthMode, AuthState } from "../shared/contracts";
import {
  AUTH_ATTEMPT_TTL_MS,
  buildHostedAuthUrl,
  extractDesktopAuthUrl,
  parseDesktopAuthCallback,
  parseStoredAuthAttempt,
  type PendingAuthAttempt,
} from "./desktop-auth.util";
import { canGrantMediaPermission, trustedLocalOrigin } from "./media-permission.util";
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
let windowMode: "onboarding" | "recorder" = "onboarding";
let queuedAuthUrl = extractDesktopAuthUrl(process.argv);
let pendingAuthRequest: {
  attemptId: string;
  resolve: (state: AuthState) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;

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

function getWindowBounds(mode: typeof windowMode) {
  return mode === "recorder"
    ? { width: 1180, height: 780, minWidth: 920, minHeight: 640, resizable: true }
    : { width: 400, height: 340, minWidth: 400, minHeight: 340, resizable: false };
}

function applyWindowMode(mode: typeof windowMode) {
  windowMode = mode;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = getWindowBounds(mode);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(bounds.minWidth, bounds.minHeight);
  mainWindow.setSize(bounds.width, bounds.height, true);
  mainWindow.setResizable(bounds.resizable);
  mainWindow.center();
}

function createMainWindow() {
  const bounds = getWindowBounds(windowMode);
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: bounds.minWidth,
    minHeight: bounds.minHeight,
    resizable: bounds.resizable,
    backgroundColor: "#10100f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
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
  applyWindowMode("recorder");
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

function pendingAuthPath() {
  return join(app.getPath("userData"), "pending-auth.json");
}

async function savePendingAuthAttempt(attempt: PendingAuthAttempt) {
  const path = pendingAuthPath();
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(attempt), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

async function clearPendingAuthAttempt() {
  await unlink(pendingAuthPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function loadPendingAuthAttempt() {
  try {
    const value = JSON.parse(await readFile(pendingAuthPath(), "utf8")) as unknown;
    const attempt = parseStoredAuthAttempt(value);
    if (!attempt) await clearPendingAuthAttempt();
    return attempt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await clearPendingAuthAttempt();
    return null;
  }
}

function settlePendingAuth(attemptId: string, state?: AuthState, error?: Error) {
  if (pendingAuthRequest?.attemptId !== attemptId) return;
  clearTimeout(pendingAuthRequest.timeout);
  const request = pendingAuthRequest;
  pendingAuthRequest = null;
  if (error) request.reject(error);
  else request.resolve(state ?? { authenticated: false, canUpload: false });
}

async function authenticate(mode: AuthMode) {
  if (pendingAuthRequest) {
    clearTimeout(pendingAuthRequest.timeout);
    pendingAuthRequest.reject(new Error("A newer authentication attempt was started."));
    pendingAuthRequest = null;
  }

  const attempt: PendingAuthAttempt = { id: randomUUID(), mode, createdAt: Date.now() };
  await savePendingAuthAttempt(attempt);
  const result = new Promise<AuthState>((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      settlePendingAuth(attempt.id, undefined, new Error("Sign-in timed out. Please try again."));
      void clearPendingAuthAttempt();
    }, AUTH_ATTEMPT_TTL_MS);
    pendingAuthRequest = { attemptId: attempt.id, resolve: resolveRequest, reject: rejectRequest, timeout };
  });

  try {
    await shell.openExternal(buildHostedAuthUrl(mode, attempt.id));
  } catch (error) {
    await clearPendingAuthAttempt();
    settlePendingAuth(attempt.id, undefined, error instanceof Error ? error : new Error("Could not open the browser."));
  }
  return result;
}

function sendAuthState(state: AuthState) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const notify = () => mainWindow?.webContents.send("desktop:auth-state-changed", state);
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", notify);
  else notify();
}

async function handleDesktopAuthCallback(rawUrl: string) {
  const attempt = await loadPendingAuthAttempt();
  if (!attempt) return;

  let matchedAttempt = false;
  try {
    const callback = parseDesktopAuthCallback(rawUrl, attempt);
    matchedAttempt = true;
    if (callback.type === "error") throw new Error(`Authentication failed: ${callback.message}`);

    const response = await session.fromPartition(partition).fetch(`${API_BASE_URL}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: callback.code }),
      credentials: "include",
    });
    const data = (await response.json().catch(() => ({}))) as AuthState & { error?: string; message?: string };
    if (!response.ok || !data.authenticated) {
      throw new Error(data.message || data.error || "Zapture could not complete sign-in.");
    }

    await session.fromPartition(partition).cookies.flushStore();
    await clearPendingAuthAttempt();
    applyWindowMode("recorder");
    const win = showMainWindow();
    sendAuthState(data);
    settlePendingAuth(attempt.id, data);
    win.focus();
  } catch (error) {
    if (!matchedAttempt) return;
    await clearPendingAuthAttempt();
    const authError = error instanceof Error ? error : new Error("Zapture could not complete sign-in.");
    settlePendingAuth(attempt.id, undefined, authError);
    applyWindowMode("onboarding");
    showMainWindow();
  }
}

function configureSession() {
  const appSession = session.fromPartition(partition);
  appSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    permission === "media" && trustedLocalOrigin(requestingOrigin),
  );
  appSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const isMainRenderer = webContents === mainWindow?.webContents;
    callback(canGrantMediaPermission(permission, isMainRenderer, new URL(webContents.getURL()).origin));
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
  ipcMain.handle("desktop:get-auth", async () => {
    const state = await getAuthState();
    if (state.authenticated) applyWindowMode("recorder");
    return state;
  });
  ipcMain.handle("desktop:authenticate", (_event, mode) => authenticate(z.enum(["sign-in", "sign-up"]).parse(mode)));
  ipcMain.handle("desktop:continue-locally", () => applyWindowMode("recorder"));
  ipcMain.handle("desktop:sign-out", async () => {
    await session.fromPartition(partition).fetch(`${API_BASE_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
    await session.fromPartition(partition).clearStorageData({ storages: ["cookies", "localstorage"] });
    applyWindowMode("onboarding");
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

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient("zapture", process.execPath, [resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("zapture");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function startApplication() {
  app.on("second-instance", (_event, commandLine) => {
    const authUrl = extractDesktopAuthUrl(commandLine);
    if (authUrl) void handleDesktopAuthCallback(authUrl);
    else showMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady()) void handleDesktopAuthCallback(url);
    else queuedAuthUrl = url;
  });

  void app.whenReady().then(async () => {
    const appSession = configureSession();
    store = new RecordingStore(join(app.getPath("userData"), "recordings"));
    await store.initialize();
    updater = new DesktopUpdater(appSession, () => mainWindow);
    registerIpc();
    if (queuedAuthUrl) {
      const authUrl = queuedAuthUrl;
      queuedAuthUrl = null;
      await handleDesktopAuthCallback(authUrl);
    }
    const win = mainWindow ?? createMainWindow();
    configureTray();
    globalShortcut.register("CommandOrControl+Shift+5", prepareRecording);
    updater.start();

    if (process.argv.includes("--ci-smoke")) {
      win.webContents.once("did-finish-load", async () => {
        const rendererReady = await win.webContents.executeJavaScript(`(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return typeof window.zapture === "object" && document.querySelector("#root")?.childElementCount > 0;
        })()`);
        if (rendererReady) console.log("Zapture desktop smoke check passed");
        else {
          console.error("Zapture desktop smoke check failed: the preload bridge or renderer did not load");
          process.exitCode = 1;
        }
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
}

if (hasSingleInstanceLock) startApplication();
else app.quit();
