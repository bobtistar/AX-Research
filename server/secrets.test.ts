import { beforeAll, describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "test-secret-for-encryption-round-trip";

const { decryptSecret, encryptSecret, keyHint } = await import(
  "./_core/secrets"
);

describe("api key encryption", () => {
  it("round-trips a key", () => {
    const key = "AIzaSyExampleKeyValueThatIsLongEnough";
    expect(decryptSecret(encryptSecret(key))).toBe(key);
  });

  it("produces a different ciphertext each time", () => {
    // A fixed IV would let identical keys be spotted as identical in a database dump.
    const key = "AIzaSyExampleKeyValueThatIsLongEnough";
    expect(encryptSecret(key)).not.toBe(encryptSecret(key));
  });

  it("refuses a tampered ciphertext rather than returning a wrong key", () => {
    const stored = encryptSecret("AIzaSyExampleKeyValueThatIsLongEnough");
    const [iv, tag, payload] = stored.split(".");
    const flipped = `${iv}.${tag}.${payload.slice(0, -4)}AAAA`;
    expect(decryptSecret(flipped)).toBeNull();
  });

  it("returns null for absent or malformed values instead of throwing", () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBeNull();
    expect(decryptSecret("not-a-ciphertext")).toBeNull();
  });

  it("exposes only the last four characters as a hint", () => {
    expect(keyHint("AIzaSyExampleKeyValue1234")).toBe("1234");
  });
});
