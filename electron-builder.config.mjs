const buildVersion = process.env.DESKTOP_BUILD_VERSION || "0.0.0-development";
const isProduction = process.env.DESKTOP_PRODUCTION === "true";

export default {
  appId: "app.zapture.desktop",
  productName: "Zapture",
  extraMetadata: { version: buildVersion },
  directories: { output: "release", buildResources: "build" },
  files: ["out/**/*", "package.json"],
  extraResources: [{ from: "build/tray-icon.png", to: "build/tray-icon.png" }],
  asar: true,
  artifactName: "Zapture-${version}-${os}-${arch}.${ext}",
  protocols: [{ name: "Zapture", schemes: ["zapture"] }],
  publish: [{ provider: "generic", url: "https://zapture.app/api/desktop/updates" }],
  mac: {
    category: "public.app-category.productivity",
    icon: "build/icon.icns",
    target: [{ target: "dmg", arch: ["universal"] }, { target: "zip", arch: ["universal"] }],
    minimumSystemVersion: "13.0",
    hardenedRuntime: true,
    notarize: isProduction,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    identity: isProduction ? undefined : null,
    extendInfo: {
      NSCameraUsageDescription: "Zapture uses the camera for the optional recording bubble.",
      NSMicrophoneUsageDescription: "Zapture uses the microphone while recording.",
      NSScreenCaptureUsageDescription: "Zapture records the screen or window you select.",
      NSAudioCaptureUsageDescription: "Zapture captures system audio when you enable it.",
    },
  },
  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    forceCodeSigning: isProduction,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};
