import type { Express } from "express";
import { storageGetSignedUrl } from "../storage";

/**
 * Serves a stored object by redirecting to a short-lived signed URL.
 *
 * The bucket is private, so this indirection is what lets the app hand out a stable path
 * without ever making the object publicly readable.
 */
export function registerStorageProxy(app: Express) {
  app.get("/storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }
    try {
      const url = await storageGetSignedUrl(key);
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (error) {
      console.error("[StorageProxy] failed:", error);
      res.status(502).send("Storage proxy error");
    }
  });
}
