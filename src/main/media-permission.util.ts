const allowedMediaPermissions = new Set(["media", "display-capture"]);

/** Which of our own windows is asking. Only the recorder window may capture the screen. */
export type MediaRequester = "main" | "camera-bubble" | "other";

export function trustedLocalOrigin(origin: string) {
  return origin === "null" || origin.startsWith("file://") || origin.startsWith("http://localhost:");
}

/**
 * `mediaTypes` are the kinds a `media` request asks for (Electron's `details.mediaTypes`).
 * The camera bubble may only get camera video: no microphone, no screen.
 */
export function canGrantMediaPermission(permission: string, requester: MediaRequester, origin: string, mediaTypes: readonly string[] = []) {
  if (!trustedLocalOrigin(origin)) return false;
  if (requester === "main") return allowedMediaPermissions.has(permission);
  if (requester === "camera-bubble") return permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "video");
  return false;
}
