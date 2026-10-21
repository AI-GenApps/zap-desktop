import { describe, expect, it } from "vitest";
import { isTrustedNavigation } from "./navigation.util";

const hosted = { origins: ["https://zapture.app", "https://auth.w3dev.app"] };

describe("desktop navigation policy", () => {
  it("allows exact trusted origins and any path on them", () => {
    expect(isTrustedNavigation("https://zapture.app/editor/abc", hosted)).toBe(true);
    expect(isTrustedNavigation("https://auth.w3dev.app/sign-in?x=1", hosted)).toBe(true);
  });

  it("rejects look-alike hosts that merely share a prefix", () => {
    expect(isTrustedNavigation("https://zapture.app.evil.com/editor", hosted)).toBe(false);
    expect(isTrustedNavigation("https://zapture.app@evil.com/", hosted)).toBe(false);
    expect(isTrustedNavigation("http://zapture.app/editor", hosted)).toBe(false);
    expect(isTrustedNavigation("https://zapture.app:8443/editor", hosted)).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isTrustedNavigation("not a url", hosted)).toBe(false);
    expect(isTrustedNavigation("", hosted)).toBe(false);
  });

  it("allows file URLs only when the policy opts in", () => {
    expect(isTrustedNavigation("file:///Applications/Zapture.app/index.html", { allowFile: true })).toBe(true);
    expect(isTrustedNavigation("file:///Applications/Zapture.app/index.html", hosted)).toBe(false);
  });

  it("matches the dev server origin exactly", () => {
    const dev = { origins: ["http://localhost:5173"], allowFile: true };
    expect(isTrustedNavigation("http://localhost:5173/", dev)).toBe(true);
    expect(isTrustedNavigation("http://localhost:@evil.com/", dev)).toBe(false);
    expect(isTrustedNavigation("http://localhost:5174/", dev)).toBe(false);
  });
});
