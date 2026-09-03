/**
 * Encrypts user-supplied API keys before they touch the database.
 *
 * A stored API key is a live credential that bills its owner, so it is not kept in
 * plaintext: a database dump alone must not hand an attacker every user's key. The
 * encryption key is derived from JWT_SECRET, which already has to be secret and is held
 * outside the database.
 *
 * AES-256-GCM: the tag detects tampering, so a modified ciphertext fails to decrypt rather
 * than silently yielding a wrong key.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { ENV } from "./env";

const IV_BYTES = 12;

function encryptionKey() {
  if (!ENV.cookieSecret)
    throw new Error("JWT_SECRET이 없어 API 키를 안전하게 저장할 수 없습니다.");
  // A separate label keeps this key distinct from the one signing session cookies, so the
  // same secret is never used for two purposes.
  return createHash("sha256")
    .update(`api-key-encryption:${ENV.cookieSecret}`)
    .digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

/** Returns null for anything that does not decrypt, including a rotated JWT_SECRET. */
export function decryptSecret(stored: string | null): string | null {
  if (!stored) return null;
  const [iv, tag, payload] = stored.split(".");
  if (!iv || !tag || !payload) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, "base64")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return null;
  }
}

/** The only part of a key ever shown back to its owner. */
export function keyHint(plaintext: string) {
  return plaintext.slice(-4);
}
