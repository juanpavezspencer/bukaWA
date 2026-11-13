import { describe, expect, it } from "vitest";
import { contactKey, displayContactName } from "../src/index.js";

describe("contactKey", () => {
  it("ignores honorifics, case, spacing and punctuation", () => {
    for (const n of ["Bu Sari", "bu sari", "Ibu Sari", "SARI", "sari.", "  Bu  Sari "]) expect(contactKey(n), n).toBe("sari");
    expect(contactKey("Pak Budi Santoso")).toBe("budi santoso");
    expect(contactKey("Mbak Dewi")).toBe(contactKey("mba dewi"));
    expect(contactKey("Kak Rani")).toBe("rani");
    expect(contactKey("Koh Ahong")).toBe("ahong");
  });

  it("keeps the name when it is only an honorific or a business name", () => {
    expect(contactKey("Toko Jaya Abadi")).toBe("toko jaya abadi");
    expect(contactKey("Pak")).toBe("pak");
    expect(contactKey("Bu Haji Ani")).toBe("haji ani");
  });

  it("returns empty for blank input", () => {
    expect(contactKey("  ")).toBe("");
  });
});

describe("displayContactName", () => {
  it("tidies spacing and capitalizes words, keeping the honorific", () => {
    expect(displayContactName("  bu   sari ")).toBe("Bu Sari");
    expect(displayContactName("TOKO JAYA")).toBe("Toko Jaya");
    expect(displayContactName("Mbak Dewi")).toBe("Mbak Dewi");
  });
});

describe("similarContact", () => {
  it("matches initials and missing surnames, not different first names", async () => {
    const { similarContact } = await import("../src/index.js");
    expect(similarContact("SARI W", "Bu Sari")).toBe(true);
    expect(similarContact("Budi", "Pak Budi Santoso")).toBe(true);
    expect(similarContact("Sari Wulandari", "Sari W")).toBe(true);
    expect(similarContact("Sari B", "Sari Wulandari")).toBe(false);
    expect(similarContact("Sari", "Sarah")).toBe(false);
    expect(similarContact("Bu Ani", "Bu Sari")).toBe(false);
  });
});
