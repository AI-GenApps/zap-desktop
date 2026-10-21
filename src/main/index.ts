import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import type { AuthMode, AuthState, MenuCommand, RecordingHudState } from "../shared/contracts";
import {
  AUTH_ATTEMPT_TTL_MS,
  buildDesktopAuthRedirectUrl,
  buildHostedAuthUrl,
  extractDesktopAuthAttemptId,
  extractDesktopAuthUrl,
  parseDesktopAuthCallback,
  parseStoredAuthAttempt,
  unauthenticatedAuthState,
  type PendingAuthAttempt,
} from "./desktop-auth.util";
import { canGrantMediaPermission, trustedLocalOrigin } from "./media-permission.util";
import { isTrustedNavigation } from "./navigation.util";
import { RecordingStore } from "./recording-store";
import { DesktopUpdater } from "./updater";
import { uploadRecording } from "./uploader";

const API_BASE_URL = "https://zapture.app";
const AUTH_ORIGIN = "https://auth.w3dev.app";
const partition = "persist:zapture";

// Development runs as the stock Electron app; use the product name for the
// About panel and menus, but keep the existing development data directory.
if (!app.isPackaged) {
  const userData = app.getPath("userData");
  app.setName("Zapture");
  app.setPath("userData", userData);
}

const isMac = process.platform === "darwin";
const RECORD_SHORTCUT = "CommandOrControl+Shift+5";
const HUD_SIZE = { width: 320, height: 64 };
let mainWindow: BrowserWindow | null = null;
let editorWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let hudState: RecordingHudState | null = null;
let tray: Tray | null = null;
let store: RecordingStore;
let updater: DesktopUpdater;
let isQuitting = false;
let windowMode: "onboarding" | "recorder" = "onboarding";
let queuedAuthUrl = extractDesktopAuthUrl(process.argv);
let pendingAuthFileOperation: Promise<void> = Promise.resolve();
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
  cameraShape: z.enum(["circle", "rounded"]).optional(),
  cameraMode: z.enum(["separate", "burned-in"]).optional(),
});

const cameraTrackSchema = z.object({
  mimeType: z.string().min(1),
  startOffsetMs: z.number().finite(),
  aspect: z.number().finite(),
});

const hudStateSchema = z.object({
  status: z.enum(["countdown", "recording", "paused"]),
  countdown: z.number().int().min(0).max(10).optional(),
  elapsedMs: z.number().min(0),
  updatedAt: z.number(),
}).nullable();

// Must match --window in styles.css so resizing never flashes a mismatched colour.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7";
}

function loadRenderer(win: BrowserWindow, hash?: string) {
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash ? `#${hash}` : ""}`);
  else void win.loadFile(join(__dirname, "../renderer/index.html"), hash ? { hash } : undefined);
}

/** Local renderer windows may only show the bundled UI; links open in the browser. */
function guardRendererWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedNavigation(url, { origins: [API_BASE_URL] })) void shell.openExternal(url);
    return { action: "deny" };
  });
  const rendererOrigin = process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : undefined;
  win.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedNavigation(url, { origins: rendererOrigin ? [rendererOrigin] : [], allowFile: true })) event.preventDefault();
  });
  // Pinch and Cmd+/- zoom make the UI read as a web page; keep it at 100%.
  win.webContents.on("did-finish-load", () => void win.webContents.setVisualZoomLevelLimits(1, 1));
}

function getWindowBounds(mode: typeof windowMode) {
  return mode === "recorder"
    ? { width: 1080, height: 720, minWidth: 880, minHeight: 600, resizable: true }
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
    backgroundColor: windowBackground(),
    titleBarStyle: isMac ? "hiddenInset" : "default",
    // Vertically centre the traffic lights in the 52px toolbar.
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The recorder composites and encodes in this renderer; it must keep
      // running while the window is hidden behind the recording HUD.
      backgroundThrottling: false,
    },
  });
  guardRendererWindow(win);
  loadRenderer(win);
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

function sendMenuCommand(command: MenuCommand) {
  const win = showMainWindow();
  const notify = () => win.webContents.send("desktop:menu-command", command);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", notify);
  else notify();
}

function createHudWindow() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const win = new BrowserWindow({
    ...HUD_SIZE,
    x: Math.round(workArea.x + (workArea.width - HUD_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - HUD_SIZE.height - 28),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    // Controls must work on the first click while another app is focused.
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the recording controls out of the recording itself.
  win.setContentProtection(true);
  guardRendererWindow(win);
  win.webContents.on("did-finish-load", () => win.webContents.send("desktop:recording-hud", hudState));
  win.once("ready-to-show", () => win.showInactive());
  win.on("closed", () => {
    if (hudWindow === win) hudWindow = null;
  });
  loadRenderer(win, "hud");
  hudWindow = win;
  return win;
}

function applyRecordingHud(next: RecordingHudState | null) {
  const wasActive = hudState !== null;
  hudState = next;
  if (!next) {
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
    hudWindow = null;
    if (wasActive) showMainWindow();
    return;
  }
  const hud = hudWindow && !hudWindow.isDestroyed() ? hudWindow : createHudWindow();
  if (!hud.webContents.isLoading()) hud.webContents.send("desktop:recording-hud", next);
  // Get the recorder out of the way once capture starts; the HUD and tray bring it back.
  if (next.status !== "countdown" && mainWindow?.isVisible()) mainWindow.hide();
}

function buildApplicationMenu() {
  const recording: MenuItemConstructorOptions[] = [
    { label: "New Recording…", accelerator: "CommandOrControl+N", click: prepareRecording },
    { label: "Stop Recording", accelerator: "CommandOrControl+.", click: () => sendMenuCommand("stop-recording") },
    { type: "separator" },
    { label: "Recordings Library", accelerator: "CommandOrControl+L", click: () => sendMenuCommand("show-library") },
  ];
  const checkForUpdates: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: async () => {
      const result = await updater.check().catch((error: Error) => ({ status: "error", message: error.message }));
      await dialog.showMessageBox({ type: "info", message: "Zapture Updates", detail: result.message });
    },
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            checkForUpdates,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    { label: "File", submenu: [...recording, { type: "separator" }, isMac ? { role: "close" } : { role: "quit" }] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(app.isPackaged ? [] : [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] satisfies MenuItemConstructorOptions[]),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(isMac ? [] : [checkForUpdates]),
        { label: "Zapture Website", click: () => void shell.openExternal(API_BASE_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function prepareRecording() {
  applyWindowMode("recorder");
  const win = showMainWindow();
  const notify = () => win.webContents.send("desktop:prepare-recording");
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", notify);
  else notify();
}

function createEditorWindow(videoId: string) {
  const url = `${API_BASE_URL}/editor/${encodeURIComponent(videoId)}`;
  if (editorWindow && !editorWindow.isDestroyed()) {
    if (editorWindow.isMinimized()) editorWindow.restore();
    editorWindow.focus();
    // Switching videos can be cancelled from the unsaved-changes prompt below.
    if (editorWindow.webContents.getURL() !== url) void editorWindow.loadURL(url).catch(() => undefined);
    return;
  }

  const hostedOrigins = [API_BASE_URL, AUTH_ORIGIN];
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#090909",
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isTrustedNavigation(target, { origins: hostedOrigins })) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!isTrustedNavigation(target, { origins: hostedOrigins })) event.preventDefault();
  });
  // Electron silently cancels any close or navigation that a `beforeunload`
  // handler vetoes, so the editor's unsaved-changes guard would otherwise leave
  // the window impossible to close.
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Leave", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "You have unsaved changes. Leave without saving?",
    });
    if (choice === 0) event.preventDefault();
  });
  win.on("closed", () => {
    if (editorWindow === win) editorWindow = null;
  });
  void win.loadURL(url);
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

function withPendingAuthFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingAuthFileOperation.then(operation, () => operation());
  pendingAuthFileOperation = result.then(() => undefined, () => undefined);
  return result;
}

async function savePendingAuthAttempt(attempt: PendingAuthAttempt) {
  return withPendingAuthFileLock(async () => {
    const path = pendingAuthPath();
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(attempt), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  });
}

async function clearPendingAuthAttemptFile(expectedAttemptId?: string) {
  if (expectedAttemptId) {
    try {
      const value = JSON.parse(await readFile(pendingAuthPath(), "utf8")) as unknown;
      const currentAttempt = parseStoredAuthAttempt(value);
      if (currentAttempt && currentAttempt.id !== expectedAttemptId) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
  }

  await unlink(pendingAuthPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function clearPendingAuthAttempt(expectedAttemptId?: string) {
  return withPendingAuthFileLock(() => clearPendingAuthAttemptFile(expectedAttemptId));
}

async function loadPendingAuthAttempt() {
  return withPendingAuthFileLock(async () => {
    try {
      const value = JSON.parse(await readFile(pendingAuthPath(), "utf8")) as unknown;
      const attempt = parseStoredAuthAttempt(value);
      if (!attempt) await clearPendingAuthAttemptFile();
      return attempt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await clearPendingAuthAttemptFile();
      return null;
    }
  });
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
      void clearPendingAuthAttempt(attempt.id);
    }, AUTH_ATTEMPT_TTL_MS);
    pendingAuthRequest = { attemptId: attempt.id, resolve: resolveRequest, reject: rejectRequest, timeout };
  });

  try {
    await shell.openExternal(buildHostedAuthUrl(mode, attempt.id));
  } catch (error) {
    await clearPendingAuthAttempt(attempt.id);
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

function showAuthFailure(message: string) {
  applyWindowMode("onboarding");
  const win = showMainWindow();
  sendAuthState(unauthenticatedAuthState(message));
  win.focus();
}

async function handleDesktopAuthCallback(rawUrl: string) {
  const attempt = await loadPendingAuthAttempt();
  // Ignore stale or unsolicited protocol URLs. A browser or another process
  // can deliver these after an attempt has completed; they must not interrupt
  // an active recorder or cancel a newer sign-in attempt.
  if (!attempt) return;
  if (extractDesktopAuthAttemptId(rawUrl) !== attempt.id) return;

  let callback: ReturnType<typeof parseDesktopAuthCallback>;
  try {
    callback = parseDesktopAuthCallback(rawUrl, attempt);
  } catch {
    // An attempt-id match is not enough: malformed callbacks must not consume
    // the pending attempt or change the renderer state.
    return;
  }

  if (callback.type === "error") {
    await clearPendingAuthAttempt(attempt.id);
    const authError = new Error(`Authentication failed: ${callback.message}`);
    settlePendingAuth(attempt.id, undefined, authError);
    showAuthFailure(authError.message);
    return;
  }

  try {
    const response = await session.fromPartition(partition).fetch(`${API_BASE_URL}/api/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: callback.code,
        client_id: "zapture",
        redirect_uri: buildDesktopAuthRedirectUrl(attempt.id),
      }),
      credentials: "include",
    });
    const data = (await response.json().catch(() => ({}))) as AuthState & { error?: string; message?: string };
    if (!response.ok || !data.authenticated) {
      throw new Error(data.message || data.error || "Zapture could not complete sign-in.");
    }

    await session.fromPartition(partition).cookies.flushStore();
    await clearPendingAuthAttempt(attempt.id);
    applyWindowMode("recorder");
    const win = showMainWindow();
    sendAuthState(data);
    settlePendingAuth(attempt.id, data);
    win.focus();
  } catch (error) {
    await clearPendingAuthAttempt(attempt.id);
    const authError = error instanceof Error ? error : new Error("Zapture could not complete sign-in.");
    settlePendingAuth(attempt.id, undefined, authError);
    showAuthFailure(authError.message);
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
  ipcMain.handle("desktop:begin-recording", (_event, options, mimeType, camera) => store.create(
    optionsSchema.parse(options),
    z.string().min(1).parse(mimeType),
    cameraTrackSchema.optional().parse(camera ?? undefined),
  ));
  ipcMain.handle("desktop:append-camera-chunk", (_event, id, chunk) => store.appendCameraChunk(z.string().uuid().parse(id), new Uint8Array(chunk)));
  ipcMain.handle("desktop:report-camera-track", async (_event, id, report) => {
    const parsed = z.object({
      error: z.string().max(500).optional(),
      aspect: z.number().finite().optional(),
      startOffsetMs: z.number().finite().optional(),
    }).parse(report);
    const recordingId = z.string().uuid().parse(id);
    if (parsed.aspect !== undefined || parsed.startOffsetMs !== undefined) {
      await store.setCameraInfo(recordingId, { aspect: parsed.aspect, startOffsetMs: parsed.startOffsetMs });
    }
    if (parsed.error) await store.setCameraError(recordingId, parsed.error);
  });
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
  ipcMain.handle("desktop:set-recording-hud", (event, state) => {
    if (event.sender !== mainWindow?.webContents) throw new Error("Only the recorder window can control the HUD");
    applyRecordingHud(hudStateSchema.parse(state));
  });
  ipcMain.handle("desktop:recording-command", (event, command) => {
    if (event.sender !== hudWindow?.webContents) throw new Error("Only the HUD can send recording commands");
    mainWindow?.webContents.send("desktop:recording-command", z.enum(["pause", "resume", "stop", "cancel"]).parse(command));
  });
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
    { label: "Start Recording…", accelerator: RECORD_SHORTCUT, click: prepareRecording },
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
    buildApplicationMenu();
    nativeTheme.on("updated", () => {
      for (const win of [mainWindow, editorWindow]) if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
    });
    const win = mainWindow ?? createMainWindow();
    configureTray();
    if (!globalShortcut.register(RECORD_SHORTCUT, prepareRecording)) {
      console.warn(`Could not register ${RECORD_SHORTCUT}; another app or the OS already uses it.`);
    }
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
