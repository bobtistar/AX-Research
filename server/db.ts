import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { nanoid } from "nanoid";
import { paperCandidates, researchQueries, researchRuns, InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { validateSeedSelectionCount, type CandidateDraft } from "./seedService";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
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
  if (!db) return;
  const values: InsertUser = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: values.lastSignedIn };
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  }
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}

function unavailable(): never {
  throw new Error("저장소에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
}

export async function createResearchRun(guestKey: string, topic: string, desiredSeedCount: number) {
  const db = await getDb();
  if (!db) unavailable();
  const id = nanoid(16);
  const suggestions = (await import("./seedService")).buildQuerySuggestions(topic);
  await db.insert(researchRuns).values({ id, guestKey, topic, desiredSeedCount, queryCount: suggestions.length });
  await db.insert(researchQueries).values(suggestions.map((text, position) => ({
    id: nanoid(16), runId: id, position, text, status: "PROPOSED" as const,
  })));
  return id;
}

export async function listResearchRuns(guestKey: string) {
  const db = await getDb();
  if (!db) unavailable();
  return db.select().from(researchRuns).where(eq(researchRuns.guestKey, guestKey)).orderBy(desc(researchRuns.createdAt)).limit(12);
}

export async function getResearchRun(guestKey: string, runId: string) {
  const db = await getDb();
  if (!db) unavailable();
  const run = (await db.select().from(researchRuns).where(and(eq(researchRuns.id, runId), eq(researchRuns.guestKey, guestKey))).limit(1))[0];
  if (!run) return undefined;
  const queries = await db.select().from(researchQueries).where(eq(researchQueries.runId, runId)).orderBy(researchQueries.position);
  const candidates = await db.select().from(paperCandidates).where(eq(paperCandidates.runId, runId)).orderBy(desc(paperCandidates.citedByCount));
  return { ...run, queries, candidates: candidates.map(candidate => ({ ...candidate, provenance: JSON.parse(candidate.provenance) as string[] })) };
}

export async function replaceQueries(guestKey: string, runId: string, queries: string[]) {
  const db = await getDb();
  if (!db) unavailable();
  const run = await getResearchRun(guestKey, runId);
  if (!run) return undefined;
  if (run.status === "SEEDS_LOCKED") throw new Error("고정된 seed 실행은 질의를 수정할 수 없습니다.");
  await db.delete(paperCandidates).where(eq(paperCandidates.runId, runId));
  await db.delete(researchQueries).where(eq(researchQueries.runId, runId));
  await db.insert(researchQueries).values(queries.map((text, position) => ({
    id: nanoid(16), runId, position, text, status: "CONFIRMED" as const,
  })));
  await db.update(researchRuns).set({
    status: "QUERIES_READY", queryCount: queries.length, candidateCount: 0, seedCount: 0,
    totalRetrieved: 0, venueExcluded: 0, duplicatesRemoved: 0, failureCount: 0, errorMessage: null,
  }).where(eq(researchRuns.id, runId));
  return getResearchRun(guestKey, runId);
}

type SearchMetrics = { totalRetrieved: number; venueExcluded: number; duplicatesRemoved: number; failureCount: number };

export async function persistSearchResults(guestKey: string, runId: string, drafts: Array<CandidateDraft & { provenance: string[] }>, metrics: SearchMetrics) {
  const db = await getDb();
  if (!db) unavailable();
  const run = await getResearchRun(guestKey, runId);
  if (!run) return undefined;
  if (run.status === "SEEDS_LOCKED") throw new Error("고정된 seed 실행은 다시 검색할 수 없습니다.");
  await db.delete(paperCandidates).where(eq(paperCandidates.runId, runId));
  if (drafts.length > 0) {
    await db.insert(paperCandidates).values(drafts.map(draft => ({
      id: nanoid(16), runId, openAlexId: draft.openAlexId, doi: draft.doi, title: draft.title,
      venue: draft.venue, venueCode: draft.venueCode, year: draft.year, citedByCount: draft.citedByCount,
      sourceUrl: draft.sourceUrl, provenance: JSON.stringify(draft.provenance), isEligible: true, isSeed: false,
    })));
  }
  await db.update(researchRuns).set({
    status: "CANDIDATES_READY", candidateCount: drafts.length, seedCount: 0, ...metrics,
    errorMessage: metrics.failureCount > 0 ? "일부 질의의 외부 검색이 실패했습니다. 실패 건수를 확인해 주세요." : null,
  }).where(eq(researchRuns.id, runId));
  return getResearchRun(guestKey, runId);
}

export async function lockSeeds(guestKey: string, runId: string, candidateIds: string[]) {
  const db = await getDb();
  if (!db) unavailable();
  const run = await getResearchRun(guestKey, runId);
  if (!run) return undefined;
  const selectionError = validateSeedSelectionCount(candidateIds.length, run.desiredSeedCount);
  if (selectionError) throw new Error(selectionError);
  const candidates = await db.select().from(paperCandidates).where(eq(paperCandidates.runId, runId));
  const candidateSet = new Set(candidates.filter(candidate => candidate.isEligible).map(candidate => candidate.id));
  if (candidateIds.some(id => !candidateSet.has(id))) throw new Error("선택한 후보에 유효하지 않은 논문이 포함되어 있습니다.");
  await db.update(paperCandidates).set({ isSeed: false }).where(eq(paperCandidates.runId, runId));
  await db.update(paperCandidates).set({ isSeed: true }).where(and(eq(paperCandidates.runId, runId), inArray(paperCandidates.id, candidateIds)));
  await db.update(researchRuns).set({ status: "SEEDS_LOCKED", seedCount: candidateIds.length, errorMessage: null }).where(eq(researchRuns.id, runId));
  return getResearchRun(guestKey, runId);
}
