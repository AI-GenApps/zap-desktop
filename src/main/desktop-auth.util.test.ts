import { describe, expect, it } from "vitest";
import {
  AUTH_ATTEMPT_TTL_MS,
  buildHostedAuthUrl,
  extractDesktopAuthUrl,
  parseDesktopAuthCallback,
  parseStoredAuthAttempt,
  type PendingAuthAttempt,
} from "./desktop-auth.util";

const now = Date.UTC(2026, 7, 20, 0, 0, 0);
const attempt: PendingAuthAttempt = {
  id: "1d323c23-880a-44cf-b50d-efadf97d42be",
  mode: "sign-in",
  createdAt: now,
};

describe("desktop authentication utilities", () => {
  it("builds distinct hosted login and signup URLs with a first-party callback", () => {
    const login = new URL(buildHostedAuthUrl("sign-in", attempt.id));
    const signup = new URL(buildHostedAuthUrl("sign-up", attempt.id));

    expect(login.origin + login.pathname).toBe("https://auth.w3dev.app/login");
    expect(signup.origin + signup.pathname).toBe("https://auth.w3dev.app/signup");
    expect(login.searchParams.get("client_id")).toBe("zapture");
    const returnUrl = new URL(login.searchParams.get("returnUrl")!);
    expect(returnUrl.origin + returnUrl.pathname).toBe("https://zapture.app/desktop/auth/callback");
    expect(returnUrl.searchParams.get("attempt_id")).toBe(attempt.id);
  });

  it("accepts a matching one-time callback", () => {
    expect(parseDesktopAuthCallback(
      `zapture://auth/callback?attempt_id=${attempt.id}&auth_code=code-123`,
      attempt,
      now + 1_000,
    )).toEqual({ type: "success", code: "code-123" });
  });

  it("returns hosted authentication errors", () => {
    expect(parseDesktopAuthCallback(
      `zapture://auth/callback?attempt_id=${attempt.id}&error=access_denied`,
      attempt,
      now,
    )).toEqual({ type: "error", message: "access_denied" });
  });

  it("rejects mismatched, malformed, and expired callbacks", () => {
    expect(() => parseDesktopAuthCallback(
      "zapture://auth/callback?attempt_id=wrong&auth_code=code-123",
      attempt,
      now,
    )).toThrow("does not match");
    expect(() => parseDesktopAuthCallback(
      `https://zapture.app/callback?attempt_id=${attempt.id}&auth_code=code-123`,
      attempt,
      now,
    )).toThrow("invalid authentication callback");
    expect(() => parseDesktopAuthCallback(
      `zapture://auth/callback?attempt_id=${attempt.id}&auth_code=code-123`,
      attempt,
      now + AUTH_ATTEMPT_TTL_MS + 1,
    )).toThrow("expired");
  });

  it("validates persisted attempts and extracts protocol arguments", () => {
    expect(parseStoredAuthAttempt(attempt, now)).toEqual(attempt);
    expect(parseStoredAuthAttempt({ ...attempt, mode: "other" }, now)).toBeNull();
    expect(extractDesktopAuthUrl(["Zapture.exe", "--flag", "zapture://auth/callback?auth_code=1"])).toBe(
      "zapture://auth/callback?auth_code=1",
    );
  });
});
