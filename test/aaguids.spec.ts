import { describe, it, expect } from "vitest";
import { aaguidToName, AAGUIDS } from "../src/aaguids";

describe("aaguidToName", () => {
  it("returns 'Passkey' for null", () => {
    expect(aaguidToName(null)).toBe("Passkey");
  });

  it("returns 'Passkey' for undefined", () => {
    expect(aaguidToName(undefined)).toBe("Passkey");
  });

  it("returns 'Passkey' for an empty string", () => {
    expect(aaguidToName("")).toBe("Passkey");
  });

  it("returns 'Passkey' for an unknown AAGUID (fallback branch)", () => {
    expect(aaguidToName("00000000-0000-0000-0000-000000000000")).toBe("Passkey");
  });

  it("returns the friendly name for a known AAGUID", () => {
    expect(aaguidToName("fbfc3007-154e-4ecc-8032-51d60de6b4c2")).toBe("iCloud Keychain");
  });

  it("matches a known AAGUID case-insensitively", () => {
    expect(aaguidToName("FBFC3007-154E-4ECC-8032-51D60DE6B4C2")).toBe(
      AAGUIDS["fbfc3007-154e-4ecc-8032-51d60de6b4c2"]
    );
  });
});
