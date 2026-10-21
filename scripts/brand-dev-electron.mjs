// Development runs from the stock Electron.app, so macOS shows "Electron" in the
// menu bar and Dock. Rename that local bundle to the product name. Packaged
// builds get their name from electron-builder's productName instead.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PRODUCT_NAME = "Zapture";

if (process.platform !== "darwin") process.exit(0);

const electronDir = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
const appBundle = join(electronDir, "dist", "Electron.app");
const plist = join(appBundle, "Contents", "Info.plist");
if (!existsSync(plist)) process.exit(0);

const read = (key) => {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};

if (read("CFBundleName") === PRODUCT_NAME && read("CFBundleDisplayName") === PRODUCT_NAME) process.exit(0);

for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  const command = read(key) === undefined ? `Add :${key} string ${PRODUCT_NAME}` : `Set :${key} ${PRODUCT_NAME}`;
  execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist]);
}
// Editing Info.plist breaks the bundle's ad-hoc signature, and Apple Silicon
// refuses to launch unsigned code. macOS will ask for Screen Recording and
// camera access again once, because the signature changed.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], { stdio: "ignore" });
console.log(`Renamed the development Electron bundle to ${PRODUCT_NAME}.`);
