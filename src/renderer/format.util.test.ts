import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format.util";

describe("format helpers", () => {
  it("formats durations as mm:ss, adding hours only when needed", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65_400)).toBe("01:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(-5)).toBe("00:00");
  });

  it("formats sizes with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(2_048)).toBe("2 KB");
    expect(formatBytes(5.5 * 1024 ** 2)).toBe("5.5 MB");
  });
});
