/**
 * Turns reviewed inference runs into the frozen evaluation set under `eval/gold/`.
 *
 * A gold case is deliberately self-contained: it carries the note sections it was built
 * from, not just their IDs. `pnpm eval` therefore needs no database and keeps scoring the
 * same inputs after a note is re-uploaded, deleted, or edited — the frozen data is what
 * makes two runs of the loop comparable at all.
 */
import { eq, inArray } from "drizzle-orm";
import {
  researchInferenceReviews,
  researchInferenceRuns,
  researchNoteSections,
  researchNoteVersions,
  researchNotes,
} from "../drizzle/schema";
import { isInferableSection, type InferableSection } from "@shared/sections";
import { getDb } from "./db";

export const GOLD_SET_VERSION = "gold-v1";

/**
 * What a reviewer writes when rejecting a claim because the note genuinely says nothing.
 * Kept as an explicit marker so "the model was wrong, here is the right quote" and "the
 * model was wrong, there is no quote" stay distinguishable in the label.
 */
export const NO_EVIDENCE_MARKERS = ["근거 없음", "근거없음", "no evidence"];

export function isNoEvidenceMarker(text: string) {
  const normalized = text.trim().toLocaleLowerCase("ko-KR");
  return NO_EVIDENCE_MARKERS.some(
    marker => normalized === marker.toLocaleLowerCase("ko-KR")
  );
}

export type GoldLabel = "SUPPORTED" | "ABSENT";

export type GoldCell = {
  noteId: string;
  sectionType: InferableSection;
  label: GoldLabel;
  /** Required for SUPPORTED, absent for ABSENT. The text the answer must rest on. */
  quote?: string;
  /** How the label was derived, so a surprising case can be traced back to a verdict. */
  source:
    | "APPROVED_CLAIM"
    | "REJECTED_CLAIM"
    | "APPROVED_MISSING"
    | "REJECTED_MISSING";
};

export type GoldNote = {
  noteId: string;
  versionId: string;
  title: string;
  sections: Array<{
    sectionType: string;
    rawHeading: string;
    body: string;
    explicitEmpty: boolean;
  }>;
};

export type GoldCase = {
  id: string;
  goldSetVersion: string;
  question: string;
  /** Scope recorded for diagnosis. Evaluation re-derives scope from the live policy. */
  recordedTargetSections: string[];
  notes: GoldNote[];
  cells: GoldCell[];
  provenance: {
    runId: string;
    workspaceId: string;
    promptVersion: string;
    model: string;
    exportedAt: string;
  };
};

type StoredResult = {
  question?: unknown;
  targetSections?: unknown;
  claims?: Array<{
    noteId?: unknown;
    sectionType?: unknown;
    evidence?: Array<{ quote?: unknown }>;
  }>;
  missing?: Array<{ noteId?: unknown; sectionType?: unknown }>;
};

type ReviewRow = {
  targetKind: string;
  noteId: string;
  sectionType: string;
  verdict: string;
  correctedQuote: string | null;
};

export type SkippedCell = {
  noteId: string;
  sectionType: string;
  targetKind: string;
  reason: string;
};

/**
 * Builds one gold case from a run, its verdicts, and the note text it read.
 *
 * Every verdict collapses to one of two labels: the section supports an answer (and the
 * quote that proves it), or it does not. That is the whole judgement an evaluation needs,
 * and it is available from all four verdict combinations:
 *   approved claim   → SUPPORTED, quote the model cited
 *   rejected claim   → SUPPORTED with the reviewer's quote, or ABSENT if they wrote the
 *                      no-evidence marker
 *   approved missing → ABSENT
 *   rejected missing → SUPPORTED with the reviewer's quote
 */
export function buildGoldCase(params: {
  run: {
    id: string;
    workspaceId: string;
    question: string;
    promptVersion: string;
    model: string;
    resultJson: string | null;
  };
  reviews: readonly ReviewRow[];
  notes: readonly GoldNote[];
  exportedAt?: Date;
}): { goldCase: GoldCase | null; skipped: SkippedCell[] } {
  const skipped: SkippedCell[] = [];
  let result: StoredResult = {};
  try {
    result = params.run.resultJson
      ? (JSON.parse(params.run.resultJson) as StoredResult)
      : {};
  } catch {
    result = {};
  }

  // The quote the model actually cited, per claim cell, so an approval can record it.
  const citedQuotes = new Map<string, string>();
  for (const claim of result.claims ?? []) {
    if (typeof claim?.noteId !== "string") continue;
    if (typeof claim?.sectionType !== "string") continue;
    const quote = claim.evidence?.find(
      item => typeof item?.quote === "string" && item.quote.trim()
    )?.quote;
    if (typeof quote === "string")
      citedQuotes.set(`${claim.noteId}:${claim.sectionType}`, quote.trim());
  }

  const cells: GoldCell[] = [];
  for (const review of params.reviews) {
    const { noteId, sectionType, targetKind, verdict } = review;
    const skip = (reason: string) =>
      skipped.push({ noteId, sectionType, targetKind, reason });

    if (!isInferableSection(sectionType)) {
      skip("알 수 없는 section type");
      continue;
    }
    const corrected = review.correctedQuote?.trim() ?? "";

    if (targetKind === "CLAIM" && verdict === "APPROVED") {
      const quote = citedQuotes.get(`${noteId}:${sectionType}`);
      if (!quote) {
        // An approved claim with no citable quote left in the result cannot be scored.
        skip("승인된 claim에 인용 문장이 남아 있지 않음");
        continue;
      }
      cells.push({
        noteId,
        sectionType,
        label: "SUPPORTED",
        quote,
        source: "APPROVED_CLAIM",
      });
      continue;
    }

    if (targetKind === "CLAIM" && verdict === "REJECTED") {
      if (isNoEvidenceMarker(corrected)) {
        cells.push({
          noteId,
          sectionType,
          label: "ABSENT",
          source: "REJECTED_CLAIM",
        });
      } else if (corrected) {
        cells.push({
          noteId,
          sectionType,
          label: "SUPPORTED",
          quote: corrected,
          source: "REJECTED_CLAIM",
        });
      } else {
        skip("거부된 claim에 교정 인용이 없음");
      }
      continue;
    }

    if (targetKind === "MISSING" && verdict === "APPROVED") {
      cells.push({
        noteId,
        sectionType,
        label: "ABSENT",
        source: "APPROVED_MISSING",
      });
      continue;
    }

    if (targetKind === "MISSING" && verdict === "REJECTED") {
      // Rejecting "this is missing" means evidence exists. Writing the no-evidence marker
      // here contradicts the rejection itself, so the cell is dropped rather than guessed.
      if (!corrected || isNoEvidenceMarker(corrected)) {
        skip("근거 부족 판정을 거부했지만 존재하는 인용을 제시하지 않음");
        continue;
      }
      cells.push({
        noteId,
        sectionType,
        label: "SUPPORTED",
        quote: corrected,
        source: "REJECTED_MISSING",
      });
      continue;
    }

    skip(`알 수 없는 검토 조합 (${targetKind}/${verdict})`);
  }

  if (cells.length === 0) return { goldCase: null, skipped };

  const recordedTargetSections = Array.isArray(result.targetSections)
    ? result.targetSections.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  return {
    goldCase: {
      id: `gold_${params.run.id}`,
      goldSetVersion: GOLD_SET_VERSION,
      question:
        typeof result.question === "string" && result.question.trim()
          ? result.question.trim()
          : params.run.question.trim(),
      recordedTargetSections,
      notes: Array.from(params.notes),
      cells,
      provenance: {
        runId: params.run.id,
        workspaceId: params.run.workspaceId,
        promptVersion: params.run.promptVersion,
        model: params.run.model,
        exportedAt: (params.exportedAt ?? new Date()).toISOString(),
      },
    },
    skipped,
  };
}

/**
 * Reads every run that carries at least one verdict and returns exportable gold cases.
 * Runs across all workspaces are included: the export is a local maintenance command, and
 * whoever runs it already holds the database credentials.
 */
export async function collectGoldCases(): Promise<{
  cases: GoldCase[];
  skipped: Array<SkippedCell & { runId: string }>;
  reviewedRuns: number;
}> {
  const db = await getDb();
  if (!db)
    throw new Error(
      "DATABASE_URL이 설정되지 않아 gold set을 내보낼 수 없습니다."
    );

  const reviews = await db.select().from(researchInferenceReviews);
  if (reviews.length === 0) return { cases: [], skipped: [], reviewedRuns: 0 };

  const runIds = Array.from(new Set(reviews.map(review => review.runId)));
  const runs = await db
    .select()
    .from(researchInferenceRuns)
    .where(inArray(researchInferenceRuns.id, runIds));

  const cases: GoldCase[] = [];
  const skipped: Array<SkippedCell & { runId: string }> = [];
  for (const run of runs) {
    let versionIds: string[] = [];
    try {
      const parsed = JSON.parse(run.noteVersionIds);
      if (Array.isArray(parsed))
        versionIds = parsed.filter(
          (value): value is string => typeof value === "string"
        );
    } catch {
      versionIds = [];
    }
    const notes = versionIds.length ? await loadGoldNotes(db, versionIds) : [];
    const built = buildGoldCase({
      run,
      reviews: reviews.filter(review => review.runId === run.id),
      notes,
    });
    for (const item of built.skipped) skipped.push({ ...item, runId: run.id });
    if (built.goldCase) cases.push(built.goldCase);
  }
  return { cases, skipped, reviewedRuns: runs.length };
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function loadGoldNotes(
  db: Db,
  versionIds: string[]
): Promise<GoldNote[]> {
  const versions = await db
    .select()
    .from(researchNoteVersions)
    .innerJoin(researchNotes, eq(researchNoteVersions.noteId, researchNotes.id))
    .where(inArray(researchNoteVersions.id, versionIds));
  const sections = await db
    .select()
    .from(researchNoteSections)
    .where(inArray(researchNoteSections.versionId, versionIds));

  return versions.map(row => ({
    noteId: row.research_note_versions.noteId,
    versionId: row.research_note_versions.id,
    title: row.research_notes.title,
    sections: sections
      .filter(section => section.versionId === row.research_note_versions.id)
      .sort((a, b) => a.sectionOrder - b.sectionOrder)
      .map(section => ({
        sectionType: section.sectionType,
        rawHeading: section.rawHeading,
        body: section.body,
        explicitEmpty: section.explicitEmpty,
      })),
  }));
}
