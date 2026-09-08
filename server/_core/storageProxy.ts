import type { Express } from "express";
import { storageGetSignedUrl } from "../storage";
import { authenticateRequest } from "./auth";
import { userOwnsStorageKey } from "../noteDb";

/**
 * Serves a stored object by redirecting to a short-lived signed URL.
 *
 * The bucket is private, so this indirection is what lets the app hand out a stable path
 * without making the object publicly readable. It is also the only route that reaches raw
 * note bytes, so it repeats the ownership check the tRPC routes do rather than trusting
 * the path: an unauthenticated signer turns a leaked key into a permanent download grant,
 * since a new signed URL can be minted after the old one expires.
 */
export function registerStorageProxy(app: Express) {
  app.get("/storage/*", async (req, res) => {
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).type("text/plain").send("Missing storage key");
      return;
    }
    try {
      const user = await authenticateRequest(req);
      if (!user) {
        res.status(401).type("text/plain").send("로그인이 필요합니다.");
        return;
      }
      // 404 rather than 403: a distinct "exists but not yours" tells an unauthorised
      // caller which keys are real.
      if (!(await userOwnsStorageKey(user.id, key))) {
        res.status(404).type("text/plain").send("파일을 찾을 수 없습니다.");
        return;
      }
      const url = await storageGetSignedUrl(key);
      res.set("Cache-Control", "no-store");
      res.redirect(307, url);
    } catch (error) {
      console.error("[StorageProxy] failed:", error);
      res.status(502).type("text/plain").send("Storage proxy error");
    }
  });
}
