import { z } from "zod";
import { publicProcedure, router } from "./trpc";
import { ENV } from "./env";
import { getDb } from "../db";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  /**
   * Which pieces of configuration actually reached the running process.
   *
   * Reports presence, never values. A misconfigured deployment otherwise surfaces as an
   * unrelated-looking error deep in a feature — "저장소에 연결할 수 없습니다" for a missing
   * DATABASE_URL — and this turns that into one look.
   */
  config: publicProcedure.query(async () => ({
    database: Boolean(await getDb()),
    /**
     * Which database-ish variables the host actually set — names only, never values.
     * Hosts disagree on the name, and "no database" with an empty list means the variable
     * is missing, while a non-empty list means it is present under a name we do not read.
     */
    databaseVars: [
      "DATABASE_URL",
      "MYSQL_URL",
      "MYSQL_PUBLIC_URL",
      "DATABASE_PUBLIC_URL",
      "MYSQLHOST",
    ].filter(name => Boolean(process.env[name])),
    googleLogin: Boolean(ENV.googleClientId && ENV.googleClientSecret),
    appUrl: Boolean(ENV.appUrl),
    sessionSecret: Boolean(ENV.cookieSecret),
    geminiKey: Boolean(ENV.geminiApiKey),
    inferenceModel: ENV.inferenceModel || null,
    storage: Boolean(
      ENV.r2AccountId &&
        ENV.r2AccessKeyId &&
        ENV.r2SecretAccessKey &&
        ENV.r2Bucket
    ),
    signInRestricted: ENV.allowedEmails.length > 0,
  })),
});
