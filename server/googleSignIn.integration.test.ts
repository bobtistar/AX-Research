import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { COOKIE_NAME } from "@shared/const";

/**
 * Everything a Google sign-in does after Google itself hands back a profile.
 *
 * This is the half that actually broke in production: Google authenticated the user, and
 * the flow then failed storing them because there was no database — and said so with a
 * message that named nothing. Google's own consent step cannot be driven from a test, but
 * it is also not the part that failed; this covers the rest against a real database.
 *
 *   DATABASE_URL="mysql://..." RUN_DB_TESTS=1 pnpm test
 */
const runDbTests =
  process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);

const suffix = nanoid(8);
const ownerEmail = `owner-${suffix}@example.com`;
const strangerEmail = `stranger-${suffix}@example.com`;

process.env.JWT_SECRET ??= "test-secret-for-encryption-round-trip";
process.env.ALLOWED_EMAILS = ownerEmail;
process.env.OWNER_EMAIL = ownerEmail;

// Imported after the env vars above are set: static imports hoist, and `_core/env`
// snapshots process.env the moment it is first evaluated.
const { users } = await import("../drizzle/schema");
const { getDb } = await import("./db");
const {
  authenticateRequest,
  createSessionToken,
  isAllowedEmail,
  upsertGoogleUser,
} = await import("./_core/auth");

function requestWithCookie(token: string) {
  return { headers: { cookie: `${COOKIE_NAME}=${token}` } } as never;
}

describe.runIf(runDbTests)("google sign-in against a real database", () => {
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db
      .delete(users)
      .where(inArray(users.email, [ownerEmail, strangerEmail]));
  });

  it("stores the signed-in account and issues a session that resolves back to it", async () => {
    // The step that failed in production: with no database, upsert returned silently and
    // the flow reported a generic error several steps later.
    const user = await upsertGoogleUser({
      sub: `sub-${suffix}`,
      email: ownerEmail,
      name: "Owner",
      email_verified: true,
    });
    expect(user.openId).toBe(`google:sub-${suffix}`);
    expect(user.email).toBe(ownerEmail);
    // OWNER_EMAIL makes the first matching account admin.
    expect(user.role).toBe("admin");

    const token = await createSessionToken(user.openId);
    const resolved = await authenticateRequest(requestWithCookie(token));
    expect(resolved?.id).toBe(user.id);
    expect(resolved?.email).toBe(ownerEmail);
  });

  it("signing in again updates the same account rather than creating a second", async () => {
    const db = (await getDb())!;
    await upsertGoogleUser({
      sub: `sub-${suffix}`,
      email: ownerEmail,
      name: "Owner Renamed",
      email_verified: true,
    });
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.openId, `google:sub-${suffix}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Owner Renamed");
  });

  it("refuses an account outside ALLOWED_EMAILS", () => {
    expect(isAllowedEmail(ownerEmail)).toBe(true);
    expect(isAllowedEmail(ownerEmail.toUpperCase())).toBe(true);
    expect(isAllowedEmail(strangerEmail)).toBe(false);
  });

  it("rejects a forged or absent session cookie", async () => {
    expect(
      await authenticateRequest(requestWithCookie("not-a-token"))
    ).toBeNull();
    expect(await authenticateRequest({ headers: {} } as never)).toBeNull();

    // A token signed with a different secret must not pass.
    const { SignJWT } = await import("jose");
    const forged = await new SignJWT({ openId: `google:sub-${suffix}` })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-different-secret-entirely"));
    expect(await authenticateRequest(requestWithCookie(forged))).toBeNull();
  });

  it("resolves to nobody once the account is gone", async () => {
    const db = (await getDb())!;
    const user = await upsertGoogleUser({
      sub: `gone-${suffix}`,
      email: strangerEmail,
      email_verified: true,
    });
    const token = await createSessionToken(user.openId);
    expect(await authenticateRequest(requestWithCookie(token))).not.toBeNull();

    await db.delete(users).where(eq(users.id, user.id));
    // The cookie still verifies, but it no longer names anyone.
    expect(await authenticateRequest(requestWithCookie(token))).toBeNull();
  });
});
