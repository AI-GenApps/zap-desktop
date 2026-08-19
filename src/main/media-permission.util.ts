const allowedMediaPermissions = new Set(["media", "display-capture"]);

export function trustedLocalOrigin(origin: string) {
  return origin === "null" || origin.startsWith("file://") || origin.startsWith("http://localhost:");
}

export function canGrantMediaPermission(permission: string, isMainRenderer: boolean, origin: string) {
  return isMainRenderer && allowedMediaPermissions.has(permission) && trustedLocalOrigin(origin);
}
