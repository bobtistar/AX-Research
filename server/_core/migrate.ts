/**
 * Applies pending database migrations at boot.
 *
 * The deployment target replaces the container on every release, so there is no host to
 * run a migration command on. Running them here keeps schema and code in one deploy: a
 * release can never reach traffic with the schema it expects still missing.
 *
 * Failing to migrate stops the process. Serving against a schema the code does not match
 * produces confusing partial failures; refusing to start is louder and safer.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ENV } from "./env";

export async function runMigrations() {
  if (!ENV.databaseUrl) {
    console.warn("[Migrate] DATABASE_URL이 없어 마이그레이션을 건너뜁니다.");
    return;
  }
  // Bundled next to the server output in production, at the repo root in development.
  const candidates = [
    resolve(process.cwd(), "drizzle"),
    resolve(import.meta.dirname, "drizzle"),
  ];
  const migrationsFolder = candidates.find(existsSync);
  if (!migrationsFolder) {
    console.error(
      "[Migrate] 마이그레이션 폴더를 찾을 수 없습니다.",
      candidates
    );
    process.exit(1);
  }

  try {
    const db = drizzle(ENV.databaseUrl);
    await migrate(db, { migrationsFolder });
    console.log("[Migrate] 데이터베이스 스키마가 최신 상태입니다.");
  } catch (error) {
    console.error("[Migrate] 마이그레이션 실패:", error);
    process.exit(1);
  }
}
