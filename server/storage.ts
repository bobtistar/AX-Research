/**
 * Object storage on Cloudflare R2, reached through the S3 API.
 *
 * Replaces the Manus Forge storage helpers. The difference that matters is `storageDelete`:
 * Forge exposed only put and presign, so deleting a note could never remove its raw
 * Markdown copy — the leftovers were merely recorded in `deleted_storage_objects` for a
 * purge path that did not exist. Owning the bucket makes deletion real, which is what
 * lets the app honestly promise a user that removing a note removes the file.
 */
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

const SIGNED_URL_TTL_SECONDS = 300;

let client: S3Client | null = null;

function r2() {
  if (client) return client;
  const { r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket } = ENV;
  if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey || !r2Bucket) {
    throw new Error(
      "저장소 설정이 없습니다: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET를 설정하세요."
    );
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });
  return client;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/** Keeps two uploads of the same filename from overwriting each other. */
function appendHashSuffix(relKey: string): string {
  const hash = randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  await r2().send(
    new PutObjectCommand({
      Bucket: ENV.r2Bucket,
      Key: key,
      Body: typeof data === "string" ? Buffer.from(data, "utf-8") : data,
      ContentType: contentType,
    })
  );
  return { key, url: `/storage/${key}` };
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/storage/${key}` };
}

/**
 * A short-lived direct link to the object. The bucket stays private: without this the
 * only way to serve a note would be to make the bucket public, where knowing a key would
 * be enough to read someone else's research notes.
 */
export async function storageGetSignedUrl(relKey: string): Promise<string> {
  return getSignedUrl(
    r2(),
    new GetObjectCommand({
      Bucket: ENV.r2Bucket,
      Key: normalizeKey(relKey),
    }),
    { expiresIn: SIGNED_URL_TTL_SECONDS }
  );
}

/**
 * Permanently removes an object. Deleting an absent key is treated as success so a
 * retried purge does not fail on work it already finished.
 */
export async function storageDelete(relKey: string): Promise<void> {
  await r2().send(
    new DeleteObjectCommand({
      Bucket: ENV.r2Bucket,
      Key: normalizeKey(relKey),
    })
  );
}
