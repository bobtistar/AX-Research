import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import {
  inferenceReviewTarget,
  inferenceReviewVerdict,
  researchInferenceReviews,
  researchInferenceRuns,
} from "../drizzle/schema";
import { getOrCreateWorkspace } from "./noteDb";

export type ReviewTargetKind = (typeof inferenceReviewTarget)[number];
export type ReviewVerdict = (typeof inferenceReviewVerdict)[number];

export type ReviewableCell = {
  targetKind: ReviewTargetKind;
  noteId: string;
  sectionType: string;
};

/** The stored `resultJson` shape, narrowed to the parts a review has to address. */
type StoredResult = {
  claims?: Array<{ noteId?: unknown; sectionType?: unknown }>;
  missing?: Array<{ noteId?: unknown; sectionType?: unknown }>;
  sourceVersions?: unknown;
  model?: unknown;
  promptVersion?: unknown;
};

function cellKey(cell: ReviewableCell) {
  return `${cell.targetKind}:${cell.noteId}:${cell.sectionType}`;
}

/**
 * The cells a run actually produced, and the only ones a review may address. Deriving the
 * set from the stored result rather than from the note and section catalogs is what keeps
 * labels anchored to real model output: a reviewer cannot approve a claim the run never
 * made, so an approved label always has a claim to compare against later.
 */
export function reviewableCells(result: unknown): ReviewableCell[] {
  const stored = (result ?? {}) as StoredResult;
  const cells: ReviewableCell[] = [];
  const seen = new Set<string>();
  const collect = (
    targetKind: ReviewTargetKind,
    rows: StoredResult["claims"]
  ) => {
    for (const row of rows ?? []) {
      if (typeof row?.noteId !== "string") continue;
      if (typeof row?.sectionType !== "string") continue;
      const cell = {
        targetKind,
        noteId: row.noteId,
        sectionType: row.sectionType,
      };
      const key = cellKey(cell);
      if (seen.has(key)) continue;
      seen.add(key);
      cells.push(cell);
    }
  };
  collect("CLAIM", stored.claims);
  collect("MISSING", stored.missing);
  return cells;
}

export type ReviewSummary = {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  status: "none" | "pending" | "partial" | "complete";
};

/**
 * Run-level review state, computed rather than stored. A single stored flag would drift the
 * moment a re-run changed the cells, and the gold set is built from the per-cell verdicts
 * anyway; this only reports how far the reviewer got.
 */
export function summarizeReviews(
  cells: readonly ReviewableCell[],
  reviews: ReadonlyArray<ReviewableCell & { verdict: ReviewVerdict }>
): ReviewSummary {
  const valid = new Set(cells.map(cellKey));
  const byCell = new Map<string, ReviewVerdict>();
  for (const review of reviews) {
    const key = cellKey(review);
    // A stale label — its cell is gone from the current result — is not counted as progress.
    if (valid.has(key)) byCell.set(key, review.verdict);
  }
  const approved = Array.from(byCell.values()).filter(
    verdict => verdict === "APPROVED"
  ).length;
  const rejected = byCell.size - approved;
  const pending = cells.length - byCell.size;
  const status: ReviewSummary["status"] =
    cells.length === 0
      ? "none"
      : byCell.size === 0
        ? "pending"
        : pending === 0
          ? "complete"
          : "partial";
  return { total: cells.length, approved, rejected, pending, status };
}

async function loadOwnedRun(userId: number, runId: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const run = (
    await db
      .select()
      .from(researchInferenceRuns)
      .where(
        and(
          eq(researchInferenceRuns.id, runId),
          eq(researchInferenceRuns.workspaceId, workspace.id)
        )
      )
      .limit(1)
  )[0];
  if (!run) throw new Error("해당 추론 실행을 찾을 수 없습니다.");
  return { db, workspace, run };
}

function parseResult(raw: string | null): StoredResult {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StoredResult;
  } catch {
    return {};
  }
}

/**
 * Records one reviewer verdict. Re-reviewing the same cell overwrites the previous verdict,
 * because a label is a current judgement, not an audit trail of the reviewer's hesitation.
 */
export async function submitInferenceReview(
  userId: number,
  input: {
    runId: string;
    targetKind: ReviewTargetKind;
    noteId: string;
    sectionType: string;
    verdict: ReviewVerdict;
    correctedQuote?: string;
    reviewerNote?: string;
  }
) {
  const { db, workspace, run } = await loadOwnedRun(userId, input.runId);
  const result = parseResult(run.resultJson);
  const cells = reviewableCells(result);
  const target: ReviewableCell = {
    targetKind: input.targetKind,
    noteId: input.noteId,
    sectionType: input.sectionType,
  };
  if (!cells.some(cell => cellKey(cell) === cellKey(target))) {
    throw new Error(
      "이 실행 결과에 없는 항목은 검토할 수 없습니다. 화면을 새로고침한 뒤 다시 시도해 주세요."
    );
  }
  // A rejection without the corrected quote produces a label that says "wrong" and nothing
  // more, which cannot seed an evaluation set. Approvals need no correction.
  const correctedQuote = input.correctedQuote?.trim() || null;
  if (input.verdict === "REJECTED" && !correctedQuote) {
    throw new Error(
      "거부할 때는 원문에서 옳은 인용 문장을 함께 입력해 주세요. 근거가 실제로 없으면 '근거 없음'이라고 적어 주세요."
    );
  }

  const sourceVersionIds =
    typeof run.noteVersionIds === "string" ? run.noteVersionIds : "[]";
  const values = {
    workspaceId: workspace.id,
    runId: run.id,
    targetKind: input.targetKind,
    noteId: input.noteId,
    sectionType: input.sectionType,
    verdict: input.verdict,
    correctedQuote,
    reviewerNote: input.reviewerNote?.trim() || null,
    sourceVersionIds,
    promptVersion: run.promptVersion,
    model: run.model,
  };
  await db
    .insert(researchInferenceReviews)
    .values({ id: nanoid(16), ...values })
    .onDuplicateKeyUpdate({
      set: {
        verdict: values.verdict,
        correctedQuote: values.correctedQuote,
        reviewerNote: values.reviewerNote,
        sourceVersionIds: values.sourceVersionIds,
        promptVersion: values.promptVersion,
        model: values.model,
      },
    });

  const reviews = await selectReviews(db, workspace.id, run.id);
  return { runId: run.id, reviews, summary: summarizeReviews(cells, reviews) };
}

type Db = Awaited<ReturnType<typeof getOrCreateWorkspace>>["db"];

async function selectReviews(db: Db, workspaceId: string, runId: string) {
  const rows = await db
    .select()
    .from(researchInferenceReviews)
    .where(
      and(
        eq(researchInferenceReviews.workspaceId, workspaceId),
        eq(researchInferenceReviews.runId, runId)
      )
    );
  return rows.map(row => ({
    ...row,
    targetKind: row.targetKind as ReviewTargetKind,
    verdict: row.verdict as ReviewVerdict,
  }));
}

export async function listInferenceReviews(userId: number, runId: string) {
  const { db, workspace, run } = await loadOwnedRun(userId, runId);
  const cells = reviewableCells(parseResult(run.resultJson));
  const reviews = await selectReviews(db, workspace.id, run.id);
  return {
    runId: run.id,
    cells,
    reviews,
    summary: summarizeReviews(cells, reviews),
  };
}

/**
 * Review counts for many runs at once, so the run list can show progress without a query
 * per row.
 */
export async function reviewSummariesByRun(
  db: Db,
  workspaceId: string,
  runs: ReadonlyArray<{ id: string; resultJson: string | null }>
) {
  const summaries = new Map<string, ReviewSummary>();
  if (runs.length === 0) return summaries;
  const rows = await db
    .select()
    .from(researchInferenceReviews)
    .where(eq(researchInferenceReviews.workspaceId, workspaceId));
  const byRun = new Map<
    string,
    Array<ReviewableCell & { verdict: ReviewVerdict }>
  >();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push({
      targetKind: row.targetKind as ReviewTargetKind,
      noteId: row.noteId,
      sectionType: row.sectionType,
      verdict: row.verdict as ReviewVerdict,
    });
    byRun.set(row.runId, list);
  }
  for (const run of runs) {
    const cells = reviewableCells(parseResult(run.resultJson));
    summaries.set(run.id, summarizeReviews(cells, byRun.get(run.id) ?? []));
  }
  return summaries;
}
