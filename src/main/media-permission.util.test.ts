import { describe, expect, it } from "vitest";
import { canGrantMediaPermission, trustedLocalOrigin } from "./media-permission.util";

describe("desktop media permissions", () => {
  it("allows media and display capture from the trusted main renderer", () => {
    expect(canGrantMediaPermission("media", "main", "http://localhost:5173")).toBe(true);
    expect(canGrantMediaPermission("display-capture", "main", "http://localhost:5173")).toBe(true);
    expect(canGrantMediaPermission("display-capture", "main", "null")).toBe(true);
  });

  it("rejects other permissions, windows, and origins", () => {
    expect(canGrantMediaPermission("geolocation", "main", "http://localhost:5173")).toBe(false);
    expect(canGrantMediaPermission("display-capture", "other", "http://localhost:5173")).toBe(false);
    expect(canGrantMediaPermission("display-capture", "main", "https://zapture.app")).toBe(false);
  });

  it("lets the camera bubble open the camera only", () => {
    const origin = "http://localhost:5173";
    expect(canGrantMediaPermission("media", "camera-bubble", origin, ["video"])).toBe(true);
    expect(canGrantMediaPermission("media", "camera-bubble", "null", ["video"])).toBe(true);
    expect(canGrantMediaPermission("media", "camera-bubble", origin, ["video", "audio"])).toBe(false);
    expect(canGrantMediaPermission("media", "camera-bubble", origin, ["audio"])).toBe(false);
    expect(canGrantMediaPermission("media", "camera-bubble", origin, [])).toBe(false);
    expect(canGrantMediaPermission("display-capture", "camera-bubble", origin, ["video"])).toBe(false);
    expect(canGrantMediaPermission("media", "camera-bubble", "https://zapture.app", ["video"])).toBe(false);
  });

  it("recognizes only packaged and localhost renderer origins", () => {
    expect(trustedLocalOrigin("file:///Applications/Zapture.app/index.html")).toBe(true);
    expect(trustedLocalOrigin("http://localhost:5173")).toBe(true);
    expect(trustedLocalOrigin("http://127.0.0.1:5173")).toBe(false);
  });
});
