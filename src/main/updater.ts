import type { BrowserWindow, Session } from "electron";
import { app } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export class DesktopUpdater {
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly session: Session,
    private readonly getWindow: () => BrowserWindow | null,
  ) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", () => this.notify("update-downloaded", "Update ready. Restart Zapture when convenient."));
    autoUpdater.on("error", (error) => this.notify("error", error.message));
  }

  private notify(status: string, message: string) {
    this.getWindow()?.webContents.send("desktop:update-status", { status, message });
  }

  private async cookieHeader() {
    const cookies = await this.session.cookies.get({ url: "https://zapture.app" });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async check() {
    if (!app.isPackaged || app.getVersion().startsWith("0.0.0-pr.")) {
      return { status: "disabled", message: "Updates are enabled in production builds." };
    }
    const cookie = await this.cookieHeader();
    if (!cookie) return { status: "authentication-required", message: "Sign in before checking for updates." };
    autoUpdater.requestHeaders = { Cookie: cookie };
    this.notify("checking", "Checking for updates");
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo
      ? { status: "available", message: `Version ${result.updateInfo.version} is available.` }
      : { status: "current", message: "Zapture is up to date." };
  }

  start() {
    this.interval = setInterval(() => void this.check().catch(() => undefined), UPDATE_INTERVAL_MS);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}
