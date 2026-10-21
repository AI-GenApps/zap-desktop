interface NavigationPolicy {
  origins?: readonly string[];
  allowFile?: boolean;
}

/** Compares parsed origins; a `startsWith` check would accept `https://zapture.app.evil.com`. */
export function isTrustedNavigation(rawUrl: string, policy: NavigationPolicy) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "file:") return policy.allowFile === true;
  return policy.origins?.includes(url.origin) ?? false;
}
