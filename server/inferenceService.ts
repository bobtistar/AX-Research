import { nanoid } from "nanoid";
import {
  researchInferenceRuns,
  researchNoteSections,
  researchNoteVersions,
} from "../drizzle/schema";
import { INFERABLE_SECTIONS, type InferableSection } from "@shared/sections";
import { ENV } from "./_core/env";
import { invokeLLM, listLLMModels } from "./_core/llm";
import { assertNotesInWorkspace, getOrCreateWorkspace } from "./noteDb";
import { authorizeInference, recordInferenceUsage } from "./usage";
import {
  reviewSummariesByRun,
  reviewableCells,
  summarizeReviews,
} from "./inferenceReview";
import {
  buildInferenceMessages,
  inferenceResponseSchema,
  INFERENCE_PROMPT_VERSION,
  MAX_INFERENCE_TOKENS,
  resolveTargetSections,
  selectEvidence,
  type Evidence,
} from "./inferencePrompt";
import { and, desc, eq, inArray } from "drizzle-orm";

export { INFERENCE_PROMPT_VERSION };

/**
 * Pinned default; override with INFERENCE_MODEL. Verified against the catalog before use,
 * because the gateway may expose the model under a different ID than the vendor docs.
 * gpt-5.6-luna supports structured outputs, which the strict json_schema call below needs.
 */
export const DEFAULT_INFERENCE_MODEL = "gpt-5.6-luna";

/**
 * Kept as an alias of the shared vocabulary so existing callers and stored labels keep
 * their name. The list itself is schema and lives in shared/sections.ts.
 */
export const ALLOWED_SECTION_TYPES = INFERABLE_SECTIONS;
export type AllowedSectionType = InferableSection;

/**
 * The shape stored in `research_inference_runs.resultJson`.
 *
 * Declared once and used by both the write path and the read paths. Without it the read
 * paths returned `Record<string, unknown>`, which no UI could render, so a stored run was
 * unreachable from the client and could only be reviewed in the session that produced it.
 *
 * Rows written before 2026-09-01 carry an extra `humanReview` field; it is ignored, since
 * review state now comes from research_inference_reviews.
 */
export type InferenceClaim = {
  noteId: string;
  sectionType: AllowedSectionType;
  answer: string;
  evidenceIds: string[];
  supportStatus: "supported" | "contradicted" | "not_found" | "ambiguous";
  evidence: Array<{
    evidenceId: string;
    noteId: string;
    versionId: string;
    sectionType: AllowedSectionType;
    rawHeading: string;
    quote: string;
  }>;
};

export type StoredInferenceResult = {
  question: string;
  claims: InferenceClaim[];
  missing: Array<{
    noteId: string;
    sectionType: AllowedSectionType;
    reason: MissingReason;
  }>;
  targetSections: AllowedSectionType[];
  sourceVersions: string[];
  model: string;
  promptVersion: string;
  warnings?: string[];
  /** Present only on a FAILED run, which carries no claims. */
  error?: string;
};

export type MissingReason =
  | "section_missing"
  | "no_quote_found"
  | "source_unavailable";

/**
 * Missing state is computed from stored sections and validated claims only, never from the
 * model response, so a model that stays silent cannot hide a gap and cannot invent one.
 */
export function computeMissingSections(params: {
  noteIds: string[];
  targetSections: readonly AllowedSectionType[];
  evidence: ReadonlyArray<{ noteId: string; sectionType: AllowedSectionType }>;
  notesWithParsedSections: ReadonlySet<string>;
  claimedKeys: ReadonlySet<string>;
}): Array<{
  noteId: string;
  sectionType: AllowedSectionType;
  reason: MissingReason;
}> {
  const missing: Array<{
    noteId: string;
    sectionType: AllowedSectionType;
    reason: MissingReason;
  }> = [];
  for (const noteId of params.noteIds) {
    for (const sectionType of params.targetSections) {
      if (!params.notesWithParsedSections.has(noteId)) {
        missing.push({ noteId, sectionType, reason: "source_unavailable" });
        continue;
      }
      if (
        !params.evidence.some(
          item => item.noteId === noteId && item.sectionType === sectionType
        )
      ) {
        missing.push({ noteId, sectionType, reason: "section_missing" });
        continue;
      }
      if (!params.claimedKeys.has(`${noteId}:${sectionType}`)) {
        missing.push({ noteId, sectionType, reason: "no_quote_found" });
      }
    }
  }
  return missing;
}

type ModelClaim = {
  noteId: string;
  sectionType: string;
  answer: string;
  evidenceIds: string[];
  supportStatus: "supported" | "contradicted" | "not_found" | "ambiguous";
};

/** The model still classifies gaps, but the server recomputes them; this stays advisory only. */
type ModelMissing = {
  noteId: string;
  sectionType: string;
  reason: MissingReason;
};

type ModelResult = { claims: ModelClaim[]; missing: ModelMissing[] };

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
  } catch {
    return fallback;
  }
}

function contentOf(response: Awaited<ReturnType<typeof invokeLLM>>): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return "{}";
}

let verifiedModel: string | undefined;

/**
 * The model is pinned by configuration, not picked from catalog order. A run records the
 * model alongside promptVersion, so letting the catalog choose made past runs impossible to
 * reproduce. The ID is verified against the catalog once and then cached; a catalog outage
 * does not block inference, but an ID the catalog does not know fails loudly.
 */
export async function resolveInferenceModel(): Promise<string> {
  if (verifiedModel) return verifiedModel;
  const configured = ENV.inferenceModel || DEFAULT_INFERENCE_MODEL;
  try {
    const catalog = await listLLMModels();
    const known = catalog.data.some(model => model.id === configured);
    if (!known) {
      throw new Error(
        `INFERENCE_MODEL="${configured}"을 모델 카탈로그에서 찾을 수 없습니다. 사용 가능한 ID: ${catalog.data.map(model => model.id).join(", ")}`
      );
    }
  } catch (error) {
    // Distinguish "the catalog says this model does not exist" from "the catalog is down".
    if (error instanceof Error && error.message.startsWith("INFERENCE_MODEL="))
      throw error;
    console.warn(
      "[Inference] 모델 카탈로그를 확인하지 못해 설정값을 그대로 사용합니다.",
      {
        model: configured,
        error: error instanceof Error ? error.message : "unknown",
      }
    );
  }
  verifiedModel = configured;
  return verifiedModel;
}

export function validateInferenceClaims(
  modelResult: ModelResult,
  noteIds: string[],
  evidence: Evidence[]
) {
  const evidenceMap = new Map(evidence.map(item => [item.id, item]));
  return modelResult.claims.filter(claim => {
    if (!noteIds.includes(claim.noteId)) return false;
    if (
      !(ALLOWED_SECTION_TYPES as readonly string[]).includes(claim.sectionType)
    )
      return false;
    if (claim.evidenceIds.length === 0) return false;
    return claim.evidenceIds.every(
      id =>
        evidenceMap.has(id) &&
        evidenceMap.get(id)!.noteId === claim.noteId &&
        evidenceMap.get(id)!.sectionType === claim.sectionType
    );
  });
}

export async function runEvidenceInference(
  userId: number,
  noteIds: string[],
  question: string,
  sectionTypes?: string[]
) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const ids = Array.from(new Set(noteIds));
  if (ids.length < 1 || ids.length > 10)
    throw new Error("추론 대상은 1–10개 노트로 제한됩니다.");
  if (question.trim().length < 10 || question.length > 1_000)
    throw new Error("질문은 10–1,000자 범위로 입력해 주세요.");

  await assertNotesInWorkspace(db, workspace.id, ids);
  const notes = await db
    .select()
    .from(researchNoteVersions)
    .where(inArray(researchNoteVersions.noteId, ids))
    .orderBy(desc(researchNoteVersions.versionNumber));
  const latest = new Map<string, (typeof notes)[number]>();
  for (const version of notes)
    if (!latest.has(version.noteId)) latest.set(version.noteId, version);
  if (latest.size !== ids.length)
    throw new Error("선택한 노트 중 버전이 없는 문서가 있습니다.");
  const latestVersions = Array.from(latest.values());
  const versionIds = latestVersions.map(version => version.id);
  const sections = await db
    .select()
    .from(researchNoteSections)
    .where(inArray(researchNoteSections.versionId, versionIds));
  const noteIdByVersion = new Map(
    latestVersions.map(version => [version.id, version.noteId])
  );
  const evidence: Evidence[] = selectEvidence(
    sections.map(section => ({
      noteId: noteIdByVersion.get(section.versionId)!,
      versionId: section.versionId,
      sectionType: section.sectionType,
      rawHeading: section.rawHeading,
      body: section.body,
      explicitEmpty: section.explicitEmpty,
    }))
  );
  // A note whose latest version produced no sections at all is genuinely unreadable;
  // a note that parsed fine but lacks one section is a different, milder state.
  const notesWithParsedSections = new Set(
    sections.map(section => noteIdByVersion.get(section.versionId)!)
  );
  const targetSections = resolveTargetSections(question, sectionTypes);

  // Checked before anything is written or called, so a refused run costs nothing and
  // leaves no half-finished record behind.
  const grant = await authorizeInference(userId);

  const runId = nanoid(16);
  const model = await resolveInferenceModel();
  await db.insert(researchInferenceRuns).values({
    id: runId,
    workspaceId: workspace.id,
    question: question.trim(),
    noteVersionIds: JSON.stringify(versionIds),
    model,
    promptVersion: INFERENCE_PROMPT_VERSION,
    status: "RUNNING",
  });

  const missingSections = ids.flatMap(noteId =>
    targetSections
      .filter(
        type =>
          !evidence.some(
            item => item.noteId === noteId && item.sectionType === type
          )
      )
      .map(sectionType => ({ noteId, sectionType }))
  );
  const messages = buildInferenceMessages({
    question,
    targetSections,
    evidence,
    missingSections,
  });

  try {
    const response = await invokeLLM({
      model,
      messages,
      apiKey: grant.apiKey,
      maxTokens: MAX_INFERENCE_TOKENS,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "evidence_inference",
          strict: true,
          schema: inferenceResponseSchema(),
        },
      },
    });
    // Counted as soon as the call returns. Recording only on success would let a prompt
    // that makes the model fail run free against the quota.
    await recordInferenceUsage(userId, grant, model);
    const modelResult = safeJson<ModelResult>(contentOf(response), {
      claims: [],
      missing: [],
    });
    const evidenceMap = new Map(evidence.map(item => [item.id, item]));
    const validClaims = validateInferenceClaims(modelResult, ids, evidence).map(
      claim => ({
        ...claim,
        // Validation already rejected any other value; narrowing here lets callers,
        // including the review path, treat the section as the closed set it is.
        sectionType: claim.sectionType as AllowedSectionType,
        evidence: claim.evidenceIds
          .map(id => evidenceMap.get(id)!)
          .map(item => ({
            evidenceId: item.id,
            noteId: item.noteId,
            versionId: item.versionId,
            sectionType: item.sectionType,
            rawHeading: item.rawHeading,
            quote: item.quote,
          })),
      })
    );
    const claimedKeys = new Set(
      validClaims.map(claim => `${claim.noteId}:${claim.sectionType}`)
    );
    const validMissing = computeMissingSections({
      noteIds: ids,
      targetSections,
      evidence,
      notesWithParsedSections,
      claimedKeys,
    });
    const result: StoredInferenceResult = {
      question: question.trim(),
      claims: validClaims,
      missing: validMissing,
      targetSections,
      warnings: [
        "원문 인용이 연결된 claim만 supported로 표시했습니다.",
        "질문과 관련된 section만 근거 부족 여부를 판정했습니다.",
        "근거 부족 판정은 저장된 원문 section과 검증된 claim만으로 계산하며 모델 응답을 쓰지 않습니다.",
        "사용자 관찰·외부지식 표기·내 맥락은 기본 근거에서 제외했습니다.",
      ],
      sourceVersions: versionIds,
      model,
      promptVersion: INFERENCE_PROMPT_VERSION,
    };
    const status =
      validClaims.length > 0 && validMissing.length === 0
        ? "SUCCEEDED"
        : "PARTIAL";
    await db
      .update(researchInferenceRuns)
      .set({
        status,
        resultJson: JSON.stringify(result),
        evidenceCount: validClaims.reduce(
          (sum, claim) => sum + claim.evidence.length,
          0
        ),
        missingCount: validMissing.length,
      })
      .where(
        and(
          eq(researchInferenceRuns.id, runId),
          eq(researchInferenceRuns.workspaceId, workspace.id)
        )
      );
    return {
      id: runId,
      status,
      result,
      review: summarizeReviews(reviewableCells(result), []),
    };
  } catch (error) {
    // The request was already in flight when this threw, so it consumed budget. A failure
    // that never reached the network over-counts by one, which errs toward protecting the
    // bill rather than exposing it.
    await recordInferenceUsage(userId, grant, model).catch(() => undefined);
    const result: StoredInferenceResult = {
      question: question.trim(),
      claims: [],
      missing: [],
      targetSections,
      error: error instanceof Error ? error.message : "model_error",
      sourceVersions: versionIds,
      model,
      promptVersion: INFERENCE_PROMPT_VERSION,
    };
    await db
      .update(researchInferenceRuns)
      .set({ status: "FAILED", resultJson: JSON.stringify(result) })
      .where(
        and(
          eq(researchInferenceRuns.id, runId),
          eq(researchInferenceRuns.workspaceId, workspace.id)
        )
      );
    throw new Error("AI 추론에 실패했습니다. 원문과 실행 기록은 유지됩니다.");
  }
}

/**
 * Human review state is not stored on the run and is not written into `resultJson`; it is
 * computed from the per-cell verdicts in research_inference_reviews. Two places recording
 * the same judgement would disagree the first time a run was re-reviewed, and the per-cell
 * rows are what an evaluation set is later built from.
 */
/**
 * Reads a stored result into the declared shape.
 *
 * Missing fields are filled in, never rejected. A row that fails to parse strictly would
 * become unreachable from the UI, which is exactly the defect this type exists to fix —
 * an unreadable run cannot be reviewed, and an unreviewable run never reaches the gold set.
 * Rows written before the shape settled are therefore normalised rather than dropped.
 */
export function normalizeStoredResult(
  raw: string | null,
  fallbackQuestion: string
): StoredInferenceResult | null {
  const parsed = safeJson<Partial<StoredInferenceResult> | null>(raw, null);
  if (!parsed || typeof parsed !== "object") return null;
  return {
    question:
      typeof parsed.question === "string" && parsed.question.trim()
        ? parsed.question
        : fallbackQuestion,
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    targetSections: Array.isArray(parsed.targetSections)
      ? parsed.targetSections
      : [],
    sourceVersions: Array.isArray(parsed.sourceVersions)
      ? parsed.sourceVersions
      : [],
    model: typeof parsed.model === "string" ? parsed.model : "",
    promptVersion:
      typeof parsed.promptVersion === "string" ? parsed.promptVersion : "",
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  };
}

export type RunStaleness = {
  state: "fresh" | "stale" | "source_missing";
  notes: Array<{
    noteId: string;
    /** The version this run actually read. */
    ranWith: string;
    /** The note's newest version now, or null when the note or version is gone. */
    current: string | null;
    /** Human-facing positions, e.g. read v2 while v3 is current. */
    ranWithNumber: number | null;
    currentNumber: number | null;
  }>;
};

/**
 * Whether a run's answers still rest on the notes as they stand now.
 *
 * Computed on read, never stored. Staleness changes when a *note* changes, not when the
 * run changes, so a stored flag would be wrong from the moment of the next upload and
 * would force every past run to be rewritten on every ingest. The `status` column stays
 * what it has always been: how the run itself ended.
 *
 * "재업로드되어 판이 바뀜" and "노트가 사라짐" are kept apart because one is recoverable
 * by re-running and the other is not.
 */
export async function computeStaleness(
  db: Awaited<ReturnType<typeof getOrCreateWorkspace>>["db"],
  runs: ReadonlyArray<{ id: string; noteVersionIds: string }>
): Promise<Map<string, RunStaleness>> {
  const result = new Map<string, RunStaleness>();
  const byRun = new Map<string, string[]>();
  const allVersionIds = new Set<string>();
  for (const run of runs) {
    const ids = safeJson<string[]>(run.noteVersionIds, []).filter(
      (id): id is string => typeof id === "string"
    );
    byRun.set(run.id, ids);
    for (const id of ids) allVersionIds.add(id);
  }
  if (allVersionIds.size === 0) {
    for (const run of runs) result.set(run.id, { state: "fresh", notes: [] });
    return result;
  }

  // The versions the runs read, so each one can be traced back to its note.
  const readVersions = await db
    .select({
      id: researchNoteVersions.id,
      noteId: researchNoteVersions.noteId,
      versionNumber: researchNoteVersions.versionNumber,
    })
    .from(researchNoteVersions)
    .where(inArray(researchNoteVersions.id, Array.from(allVersionIds)));
  const noteIdByVersion = new Map(
    readVersions.map(version => [version.id, version.noteId])
  );
  const numberByVersion = new Map(
    readVersions.map(version => [version.id, version.versionNumber])
  );

  // The newest version of each of those notes, which is what a rerun would read today.
  const noteIds = Array.from(new Set(readVersions.map(v => v.noteId)));
  const latestByNote = new Map<string, { id: string; versionNumber: number }>();
  if (noteIds.length) {
    const versions = await db
      .select({
        id: researchNoteVersions.id,
        noteId: researchNoteVersions.noteId,
        versionNumber: researchNoteVersions.versionNumber,
      })
      .from(researchNoteVersions)
      .where(inArray(researchNoteVersions.noteId, noteIds))
      .orderBy(desc(researchNoteVersions.versionNumber));
    for (const version of versions)
      if (!latestByNote.has(version.noteId))
        latestByNote.set(version.noteId, {
          id: version.id,
          versionNumber: version.versionNumber,
        });
  }

  for (const run of runs) {
    const notes: RunStaleness["notes"] = [];
    let missing = false;
    let stale = false;
    for (const versionId of byRun.get(run.id) ?? []) {
      const noteId = noteIdByVersion.get(versionId);
      if (!noteId) {
        // The version row is gone, so the note it belonged to cannot be named.
        missing = true;
        notes.push({
          noteId: "(삭제됨)",
          ranWith: versionId,
          current: null,
          ranWithNumber: null,
          currentNumber: null,
        });
        continue;
      }
      const current = latestByNote.get(noteId) ?? null;
      if (current?.id !== versionId) {
        if (!current) missing = true;
        else stale = true;
        notes.push({
          noteId,
          ranWith: versionId,
          current: current?.id ?? null,
          ranWithNumber: numberByVersion.get(versionId) ?? null,
          currentNumber: current?.versionNumber ?? null,
        });
      }
    }
    result.set(run.id, {
      state: missing ? "source_missing" : stale ? "stale" : "fresh",
      notes,
    });
  }
  return result;
}

export async function listInferenceRuns(userId: number) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const runs = await db
    .select()
    .from(researchInferenceRuns)
    .where(eq(researchInferenceRuns.workspaceId, workspace.id))
    .orderBy(desc(researchInferenceRuns.createdAt))
    .limit(20);
  const [summaries, staleness] = await Promise.all([
    reviewSummariesByRun(db, workspace.id, runs),
    computeStaleness(db, runs),
  ]);
  return runs.map(run => ({
    ...run,
    noteVersionIds: safeJson<string[]>(run.noteVersionIds, []),
    result: normalizeStoredResult(run.resultJson, run.question),
    review: summaries.get(run.id),
    staleness: staleness.get(run.id),
  }));
}

export async function getInferenceRun(userId: number, runId: string) {
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
  if (!run) return undefined;
  const result = normalizeStoredResult(run.resultJson, run.question);
  const [summaries, staleness] = await Promise.all([
    reviewSummariesByRun(db, workspace.id, [run]),
    computeStaleness(db, [run]),
  ]);
  return {
    ...run,
    noteVersionIds: safeJson<string[]>(run.noteVersionIds, []),
    result,
    cells: reviewableCells(result),
    review: summaries.get(run.id),
    staleness: staleness.get(run.id),
  };
}
