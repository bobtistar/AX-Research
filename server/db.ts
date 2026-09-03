import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { nanoid } from "nanoid";
import {
  paperCandidates,
  researchQueries,
  researchRuns,
  InsertUser,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateSeedSelectionCount, type CandidateDraft } from "./seedService";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && ENV.databaseUrl) {
    try {
      _db = drizzle(ENV.databaseUrl);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/** Retained for the scaffold's optional Manus OAuth integration; guest research runs do not call it. */
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  // A write that silently does nothing is worse than one that fails: the sign-in flow
  // took this as success and then failed further along, reporting nothing about the
  // missing database.
  if (!db)
    throw new Error(
      "데이터베이스에 연결할 수 없어 로그인 정보를 저장하지 못했습니다. DATABASE_URL 설정을 확인하세요."
    );
  const values: InsertUser = {
    openId: user.openId,
    lastSignedIn: user.lastSignedIn ?? new Date(),
  };
  const updateSet: Record<string, unknown> = {
    lastSignedIn: values.lastSignedIn,
  };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  // Admin is keyed on the owner's email rather than an opaque platform ID, so it can be
  // configured before that account has ever signed in.
  const email = (user.email ?? "").trim().toLowerCase();
  values.role =
    user.role ??
    (ENV.ownerEmail && email === ENV.ownerEmail ? "admin" : "user");
  updateSet.role = values.role;
  await db
    .insert(users)
    .values(values)
    .onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (
    await db.select().from(users).where(eq(users.openId, openId)).limit(1)
  )[0];
}

/**
 * A run belongs to the browser that created it and, once claimed, to the signed-in account.
 * Carrying both keeps a claimed run reachable after the guest key is cleared or the user
 * switches devices.
 */
export type RunOwner = { guestKey: string; userId?: number | null };

function ownerScope(owner: RunOwner) {
  return owner.userId
    ? or(
        eq(researchRuns.guestKey, owner.guestKey),
        eq(researchRuns.userId, owner.userId)
      )
    : eq(researchRuns.guestKey, owner.guestKey);
}

function unavailable(): never {
  throw new Error("저장소에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
}

export async function createResearchRun(
  owner: RunOwner,
  topic: string,
  desiredSeedCount: number
) {
  const db = await getDb();
  if (!db) unavailable();
  const id = nanoid(16);
  const suggestions = (await import("./seedService")).buildQuerySuggestions(
    topic
  );
  await db.insert(researchRuns).values({
    id,
    guestKey: owner.guestKey,
    userId: owner.userId ?? null,
    topic,
    desiredSeedCount,
    queryCount: suggestions.length,
  });
  await db.insert(researchQueries).values(
    suggestions.map((text, position) => ({
      id: nanoid(16),
      runId: id,
      position,
      text,
      status: "PROPOSED" as const,
    }))
  );
  return id;
}

export async function listResearchRuns(owner: RunOwner) {
  const db = await getDb();
  if (!db) unavailable();
  return db
    .select()
    .from(researchRuns)
    .where(ownerScope(owner))
    .orderBy(desc(researchRuns.createdAt))
    .limit(12);
}

/** Attaches a browser's unclaimed guest runs to the signed-in account, one time. */
export async function claimResearchRuns(guestKey: string, userId: number) {
  const db = await getDb();
  if (!db) unavailable();
  const scope = and(
    eq(researchRuns.guestKey, guestKey),
    isNull(researchRuns.userId)
  );
  const claimable = await db
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(scope);
  if (claimable.length)
    await db.update(researchRuns).set({ userId }).where(scope);
  return { claimed: claimable.length };
}

export async function getResearchRun(owner: RunOwner, runId: string) {
  const db = await getDb();
  if (!db) unavailable();
  const run = (
    await db
      .select()
      .from(researchRuns)
      .where(and(eq(researchRuns.id, runId), ownerScope(owner)))
      .limit(1)
  )[0];
  if (!run) return undefined;
  const queries = await db
    .select()
    .from(researchQueries)
    .where(eq(researchQueries.runId, runId))
    .orderBy(researchQueries.position);
  const candidates = await db
    .select()
    .from(paperCandidates)
    .where(eq(paperCandidates.runId, runId))
    .orderBy(desc(paperCandidates.citedByCount));
  return {
    ...run,
    queries,
    candidates: candidates.map(candidate => ({
      ...candidate,
      provenance: JSON.parse(candidate.provenance) as string[],
    })),
  };
}

export async function replaceQueries(
  owner: RunOwner,
  runId: string,
  queries: string[]
) {
  const db = await getDb();
  if (!db) unavailable();
  const run = await getResearchRun(owner, runId);
  if (!run) return undefined;
  if (run.status === "SEEDS_LOCKED")
    throw new Error("고정된 seed 실행은 질의를 수정할 수 없습니다.");
  await db.delete(paperCandidates).where(eq(paperCandidates.runId, runId));
  await db.delete(researchQueries).where(eq(researchQueries.runId, runId));
  await db.insert(researchQueries).values(
    queries.map((text, position) => ({
      id: nanoid(16),
      runId,
      position,
      text,
      status: "CONFIRMED" as const,
    }))
  );
  await db
    .update(researchRuns)
    .set({
      status: "QUERIES_READY",
      queryCount: queries.length,
      candidateCount: 0,
      seedCount: 0,
      totalRetrieved: 0,
      venueExcluded: 0,
      duplicatesRemoved: 0,
      failureCount: 0,
      errorMessage: null,
    })
    .where(eq(researchRuns.id, runId));
  return getResearchRun(owner, runId);
}

/** Queries, candidates and seeds cascade from the run row. */
export async function deleteResearchRun(owner: RunOwner, runId: string) {
  const db = await getDb();
  if (!db) unavailable();
  const run = (
    await db
      .select()
      .from(researchRuns)
      .where(and(eq(researchRuns.id, runId), ownerScope(owner)))
      .limit(1)
  )[0];
  if (!run) throw new Error("삭제할 실행 이력을 찾을 수 없습니다.");
  await db
    .delete(researchRuns)
    .where(and(eq(researchRuns.id, runId), ownerScope(owner)));
  return { runId, topic: run.topic };
}

type SearchMetrics = {
  totalRetrieved: number;
  venueExcluded: number;
  duplicatesRemoved: number;
  failureCount: number;
};

export async function persistSearchResults(
  owner: RunOwner,
  runId: string,
  drafts: Array<CandidateDraft & { provenance: string[] }>,
  metrics: SearchMetrics
) {
  const db = await getDb();
  if (!db) unavailable();
  const run = await getResearchRun(owner, runId);
  if (!run) return undefined;
  if (run.status === "SEEDS_LOCKED")
    throw new Error("고정된 seed 실행은 다시 검색할 수 없습니다.");
  await db.delete(paperCandidates).where(eq(paperCandidates.runId, runId));
  if (drafts.length > 0) {
    await db.insert(paperCandidates).values(
      drafts.map(draft => ({
        id: nanoid(16),
        runId,
        openAlexId: draft.openAlexId,
        doi: draft.doi,
        title: draft.title,
        venue: draft.venue,
        venueCode: draft.venueCode,
        year: draft.year,
        citedByCount: draft.citedByCount,
        sourceUrl: draft.sourceUrl,
        provenance: JSON.stringify(draft.provenance),
        isEligible: true,
        isSeed: false,
      }))
    );
  }
  await db
    .update(researchRuns)
    .set({
      status: "CANDIDATES_READY",
      candidateCount: drafts.length,
      seedCount: 0,
      ...metrics,
      errorMessage:
        metrics.failureCount > 0
          ? "일부 질의의 외부 검색이 실패했습니다. 실패 건수를 확인해 주세요."
          : null,
    })
    .where(eq(researchRuns.id, runId));
  return getResearchRun(owner, runId);
}

export async function lockSeeds(
  owner: RunOwner,
  runId: string,
  candidateIds: string[]
) {
  const db = await getDb();
  if (!db) unavailable();
  const run = await getResearchRun(owner, runId);
  if (!run) return undefined;
  const selectionError = validateSeedSelectionCount(
    candidateIds.length,
    run.desiredSeedCount
  );
  if (selectionError) throw new Error(selectionError);
  const candidates = await db
    .select()
    .from(paperCandidates)
    .where(eq(paperCandidates.runId, runId));
  const candidateSet = new Set(
    candidates
      .filter(candidate => candidate.isEligible)
      .map(candidate => candidate.id)
  );
  if (candidateIds.some(id => !candidateSet.has(id)))
    throw new Error("선택한 후보에 유효하지 않은 논문이 포함되어 있습니다.");
  await db
    .update(paperCandidates)
    .set({ isSeed: false })
    .where(eq(paperCandidates.runId, runId));
  await db
    .update(paperCandidates)
    .set({ isSeed: true })
    .where(
      and(
        eq(paperCandidates.runId, runId),
        inArray(paperCandidates.id, candidateIds)
      )
    );
  await db
    .update(researchRuns)
    .set({
      status: "SEEDS_LOCKED",
      seedCount: candidateIds.length,
      errorMessage: null,
    })
    .where(eq(researchRuns.id, runId));
  return getResearchRun(owner, runId);
}
