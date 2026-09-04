/**
 * Applies pending database migrations at boot.
 *
 * The deployment target replaces the container on every release and there is no host to
 * run a migration command on, so running them here keeps schema and code in one deploy.
 *
 * A failure is reported, not fatal. Exiting on a bad database config produced the worst
 * possible debugging shape: the new build crash-looped, the host kept serving the previous
 * one, and the diagnostics that would have named the cause were in the build that could
 * not stay up. Serving with a broken database is not good, but it is visible — every
 * database-backed route fails loudly and `system.config` reports why.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ENV } from "./env";

export type MigrationStatus =
  | { state: "ok" }
  | { state: "skipped"; reason: string }
  | { state: "failed"; reason: string };

let lastStatus: MigrationStatus = { state: "skipped", reason: "not run yet" };

export function migrationStatus() {
  return lastStatus;
}

export async function runMigrations(): Promise<MigrationStatus> {
  if (!ENV.databaseUrl) {
    // An unresolved Railway reference stores an empty string rather than failing, so the
    // variable is present and blank. Reporting that as "not set" sent several rounds of
    // debugging after a variable that was already there.
    const present = ["DATABASE_URL", "MYSQL_URL"].filter(
      name => name in process.env
    );
    lastStatus = {
      state: "skipped",
      reason: present.length
        ? `${present.join(", ")} 변수는 있으나 값이 비어 있습니다. Railway 참조가 풀리지 않았을 때 빈 문자열이 들어갑니다 — 값을 직접 붙여넣거나 \${{서비스명.MYSQL_URL}} 형식을 다시 확인하세요.`
        : "DATABASE_URL / MYSQL_URL 변수 자체가 없습니다.",
    };
    console.warn("[Migrate]", lastStatus.reason);
    return lastStatus;
  }

  // Bundled next to the server output in production, at the repo root in development.
  const candidates = [
    resolve(process.cwd(), "drizzle"),
    resolve(import.meta.dirname, "drizzle"),
    resolve(import.meta.dirname, "..", "drizzle"),
  ];
  const migrationsFolder = candidates.find(existsSync);
  if (!migrationsFolder) {
    lastStatus = {
      state: "failed",
      reason: `마이그레이션 폴더를 찾을 수 없습니다: ${candidates.join(", ")}`,
    };
    console.error("[Migrate]", lastStatus.reason);
    return lastStatus;
  }

  try {
    const db = drizzle(ENV.databaseUrl);
    await migrate(db, { migrationsFolder });
    lastStatus = { state: "ok" };
    console.log("[Migrate] 데이터베이스 스키마가 최신 상태입니다.");
  } catch (error) {
    lastStatus = {
      state: "failed",
      reason: error instanceof Error ? error.message : "unknown",
    };
    console.error("[Migrate] 마이그레이션 실패:", error);
  }
  return lastStatus;
}
