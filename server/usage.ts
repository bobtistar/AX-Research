/**
 * Per-user API keys (BYOK) and the monthly inference quota.
 *
 * The quota exists because an inference call costs the operator real money the moment the
 * app stops running on a platform that bundled it. Without a ceiling a single user — or a
 * single stuck retry loop — can spend the month's budget, so the check runs before the
 * call, not after.
 *
 * A user on their own key is metered but never counted against the operator's quota:
 * that is the whole point of BYOK, and it is what makes a free tier safe to offer.
 */
import { nanoid } from "nanoid";
import { and, eq, sql } from "drizzle-orm";
import { inferenceUsage, userSettings } from "../drizzle/schema";
import { getDb } from "./db";
import { decryptSecret, encryptSecret, keyHint } from "./_core/secrets";

export type Plan = "FREE" | "PRO";

/**
 * Monthly calls charged to the operator. A user on their own key is not limited here —
 * they are spending their own budget, and Google already rate-limits them.
 */
export const PLAN_LIMITS: Record<Plan, number> = {
  FREE: 20,
  PRO: 300,
};

/** UTC so a quota does not reset twice for users in different time zones. */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("데이터베이스에 연결할 수 없습니다.");
  return db;
}

async function loadSettings(userId: number) {
  const db = await requireDb();
  const row = (
    await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
  )[0];
  return row ?? null;
}

/** What the settings screen may show. The key itself never leaves the server. */
export async function getUserSettings(userId: number) {
  const row = await loadSettings(userId);
  const plan = (row?.plan ?? "FREE") as Plan;
  const used = await countOperatorUsage(userId);
  return {
    plan,
    hasOwnKey: Boolean(row?.geminiKeyCipher),
    keyHint: row?.geminiKeyHint ?? null,
    limit: PLAN_LIMITS[plan],
    used,
    remaining: Math.max(0, PLAN_LIMITS[plan] - used),
    period: currentPeriod(),
  };
}

export async function saveUserApiKey(userId: number, apiKey: string) {
  const trimmed = apiKey.trim();
  if (trimmed.length < 20)
    throw new Error("API 키 형식이 올바르지 않습니다. 다시 확인해 주세요.");
  const db = await requireDb();
  const values = {
    userId,
    geminiKeyCipher: encryptSecret(trimmed),
    geminiKeyHint: keyHint(trimmed),
  };
  await db
    .insert(userSettings)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        geminiKeyCipher: values.geminiKeyCipher,
        geminiKeyHint: values.geminiKeyHint,
      },
    });
  return getUserSettings(userId);
}

export async function clearUserApiKey(userId: number) {
  const db = await requireDb();
  await db
    .update(userSettings)
    .set({ geminiKeyCipher: null, geminiKeyHint: null })
    .where(eq(userSettings.userId, userId));
  return getUserSettings(userId);
}

/** Calls this month that the operator paid for. Calls on a user's own key are excluded. */
async function countOperatorUsage(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(inferenceUsage)
    .where(
      and(
        eq(inferenceUsage.userId, userId),
        eq(inferenceUsage.period, currentPeriod()),
        eq(inferenceUsage.billedToOperator, true)
      )
    );
  return Number(rows[0]?.count ?? 0);
}

export type UsageGrant = {
  /** The key to call with; undefined means fall back to the operator's. */
  apiKey?: string;
  billedToOperator: boolean;
};

/**
 * Decides whether a call may proceed and on whose key, or throws with a message the user
 * can act on. Called before the model request so a refused call costs nothing.
 */
export async function authorizeInference(userId: number): Promise<UsageGrant> {
  const row = await loadSettings(userId);
  const ownKey = decryptSecret(row?.geminiKeyCipher ?? null);
  if (ownKey) return { apiKey: ownKey, billedToOperator: false };

  const plan = (row?.plan ?? "FREE") as Plan;
  const limit = PLAN_LIMITS[plan];
  const used = await countOperatorUsage(userId);
  if (used >= limit) {
    throw new Error(
      `이번 달 추론 횟수(${limit}회)를 모두 사용했습니다. 설정에서 본인 Gemini API 키를 등록하면 제한 없이 사용할 수 있습니다.`
    );
  }
  return { billedToOperator: true };
}

/**
 * Records a consumed call. Written after the request is made, whether it succeeded or
 * failed: a failed call still cost tokens, and not recording it would let a retry loop
 * spend the budget without ever touching the counter.
 */
export async function recordInferenceUsage(
  userId: number,
  grant: UsageGrant,
  model: string
) {
  const db = await requireDb();
  await db.insert(inferenceUsage).values({
    id: nanoid(16),
    userId,
    period: currentPeriod(),
    billedToOperator: grant.billedToOperator,
    model,
  });
}
