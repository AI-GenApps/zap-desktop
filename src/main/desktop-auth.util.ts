import type { AuthMode, AuthState } from "../shared/contracts";

export const AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;

export interface PendingAuthAttempt {
  id: string;
  mode: AuthMode;
  createdAt: number;
}

const ATTEMPT_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export function unauthenticatedAuthState(error?: string): AuthState {
  return {
    authenticated: false,
    canUpload: false,
    ...(error ? { error } : {}),
  };
}

export type DesktopAuthCallback =
  | { type: "success"; code: string }
  | { type: "error"; message: string };

export function buildDesktopAuthRedirectUrl(attemptId: string) {
  const returnUrl = new URL("https://zapture.app/desktop/auth/callback");
  returnUrl.searchParams.set("attempt_id", attemptId);
  return returnUrl.toString();
}

export function buildHostedAuthUrl(mode: AuthMode, attemptId: string) {
  const authUrl = new URL(mode === "sign-up" ? "https://auth.w3dev.app/signup" : "https://auth.w3dev.app/login");
  authUrl.searchParams.set("returnUrl", buildDesktopAuthRedirectUrl(attemptId));
  authUrl.searchParams.set("client_id", "zapture");
  return authUrl.toString();
}

export function parseStoredAuthAttempt(value: unknown, now = Date.now()): PendingAuthAttempt | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PendingAuthAttempt>;
  if (typeof candidate.id !== "string" || !ATTEMPT_ID_PATTERN.test(candidate.id)) return null;
  if (candidate.mode !== "sign-in" && candidate.mode !== "sign-up") return null;
  if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) return null;
  if (candidate.createdAt > now || now - candidate.createdAt > AUTH_ATTEMPT_TTL_MS) return null;
  return candidate as PendingAuthAttempt;
}

export function extractDesktopAuthUrl(commandLine: readonly string[]) {
  return commandLine.find((argument) => argument.startsWith("zapture://")) ?? null;
}

export function extractDesktopAuthAttemptId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "zapture:" || url.hostname !== "auth" || url.pathname !== "/callback") return null;
    return url.searchParams.get("attempt_id") || null;
  } catch {
    return null;
  }
}

export function parseDesktopAuthCallback(
  rawUrl: string,
  pendingAttempt: PendingAuthAttempt,
  now = Date.now(),
): DesktopAuthCallback {
  const attempt = parseStoredAuthAttempt(pendingAttempt, now);
  if (!attempt) throw new Error("This sign-in attempt has expired. Please try again.");

  const attemptId = extractDesktopAuthAttemptId(rawUrl);
  if (!attemptId) {
    throw new Error("Zapture received an invalid authentication callback.");
  }
  if (attemptId !== attempt.id) {
    throw new Error("This authentication callback does not match the active sign-in attempt.");
  }

  const url = new URL(rawUrl);

  const authError = url.searchParams.get("error");
  if (authError) return { type: "error", message: authError };

  const code = url.searchParams.get("auth_code");
  if (!code) throw new Error("The authentication callback did not include a sign-in code.");
  return { type: "success", code };
}
