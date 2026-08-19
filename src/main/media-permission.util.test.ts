import { describe, expect, it } from "vitest";
import { canGrantMediaPermission, trustedLocalOrigin } from "./media-permission.util";

describe("desktop media permissions", () => {
  it("allows media and display capture from the trusted main renderer", () => {
    expect(canGrantMediaPermission("media", true, "http://localhost:5173")).toBe(true);
    expect(canGrantMediaPermission("display-capture", true, "http://localhost:5173")).toBe(true);
    expect(canGrantMediaPermission("display-capture", true, "null")).toBe(true);
  });

  it("rejects other permissions, windows, and origins", () => {
    expect(canGrantMediaPermission("geolocation", true, "http://localhost:5173")).toBe(false);
    expect(canGrantMediaPermission("display-capture", false, "http://localhost:5173")).toBe(false);
    expect(canGrantMediaPermission("display-capture", true, "https://zapture.app")).toBe(false);
  });

  it("recognizes only packaged and localhost renderer origins", () => {
    expect(trustedLocalOrigin("file:///Applications/Zapture.app/index.html")).toBe(true);
    expect(trustedLocalOrigin("http://localhost:5173")).toBe(true);
    expect(trustedLocalOrigin("http://127.0.0.1:5173")).toBe(false);
  });
});
