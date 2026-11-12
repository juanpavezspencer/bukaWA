import { describe, expect, it } from "vitest";
import { maskSensitiveIds } from "../src/index.js";

describe("maskSensitiveIds", () => {
  it("masks a 16-digit NIK", () => {
    expect(maskSensitiveIds("NIK saya 3174012345678901 ya")).toBe("NIK saya [ID] ya");
  });

  it("masks formatted and raw NPWP", () => {
    expect(maskSensitiveIds("npwp 01.234.567.8-901.000")).toBe("npwp [ID]");
    expect(maskSensitiveIds("npwp 012345678901000")).toBe("npwp [ID]");
  });

  it("masks NIK written with spaces", () => {
    expect(maskSensitiveIds("3174 0123 4567 8901")).toBe("[ID]");
  });

  it("leaves amounts, phone numbers and dates alone", () => {
    const s = "jual 25 x 18rb = 450.000 tgl 12/11 wa 081234567890 total 1500000";
    expect(maskSensitiveIds(s)).toBe(s);
  });
});
