/**
 * "논문 빠른 이해" — a reading scaffold for one paper, built from its own abstract.
 *
 * Why it is separate from `runEvidenceInference`: that path answers questions over notes
 * the user has already written. This one runs *before* any note exists, which is the point
 * — reading a new paper is where the time goes.
 *
 * Three boundaries this file exists to hold, each one a rule the rest of the project
 * already enforces somewhere else:
 *
 *  1. The referee is fixed. `paperDigestPrompt.ts` may be tuned freely; nothing here may.
 *     Same split as inferencePrompt.ts / inferenceService.ts.
 *  2. A digest is never note content. `seedExport.ts` refuses to write into a section
 *     because anything there parses as paper evidence, and a machine-drafted sentence
 *     would then be scored as though the author had written it. A digest is marked
 *     `provisional` and is never persisted as a note version; putting it in the vault is a
 *     human act, performed by the human.
 *  3. A quote is checked, not trusted. `validateInferenceClaims` accepts a claim only when
 *     its evidence ids resolve. Here the model quotes raw text, so the equivalent check is
 *     stronger: the span must literally occur in the abstract.
 */
import { INFERABLE_SECTIONS, type InferableSection } from "@shared/sections";
import { invokeLLM } from "./_core/llm";
import { authorizeInference, recordInferenceUsage } from "./usage";
import { resolveInferenceModel } from "./inferenceService";
import {
  buildDigestMessages,
  digestResponseSchema,
  DIGEST_PROMPT_VERSION,
  MAX_DIGEST_TOKENS,
  type DigestSource,
} from "./paperDigestPrompt";

export { DIGEST_PROMPT_VERSION };

/**
 * Shortest span accepted as a quote.
 *
 * Without a floor the cheapest way to pass verification is to cite a single common word,
 * which occurs in every abstract and supports nothing.
 */
export const MIN_QUOTE_LENGTH = 12;

export type DigestStatus = "SUPPORTED" | "ABSENT" | "REJECTED";

export type DigestEntry = {
  sectionType: InferableSection;
  /** What the user might write in this section. Never written anywhere by the server. */
  draft: string;
  /** Verbatim span of the abstract, re-cut from the source once verified. */
  quote: string;
  status: DigestStatus;
  /** Set only when status is REJECTED, naming what failed. */
  rejectedReason?: "quote_not_in_source" | "quote_too_short" | "empty_draft";
};

export type PaperDigest = {
  title: string;
  summary: string;
  entries: DigestEntry[];
  /**
   * Sections the abstract could not answer. This is the reading checklist: exactly what
   * the user must open the PDF for, derived from the referee's verdicts and never from
   * the model's own claim about what it found.
   */
  readingChecklist: InferableSection[];
  /** Always true. A digest is a reading aid, not a note and not evidence. */
  provisional: true;
  sourceKind: "arxiv_abstract";
  sourceRef: string;
  model: string;
  promptVersion: string;
  warnings: string[];
};

/**
 * Fold away the differences that are transcription artefacts rather than content.
 *
 * A model re-emitting a quote routinely straightens curly quotes, converts an en dash, or
 * changes the line wrapping. Rejecting those would train the prompt to avoid quoting at
 * all. Nothing here removes words, so a fabricated sentence still fails.
 */
export function normalizeForQuoteMatch(value: string): string {
  return value
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Find the model's quote in the source and return the source's own wording.
 *
 * Returning the source span rather than the model's string is deliberate: whatever is
 * shown to the user as a quotation should be the paper's text, not a near-copy of it.
 * Returns null when the span does not occur, which is the rejection path.
 */
export function locateQuote(quote: string, source: string): string | null {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  if (normalizedQuote.length < MIN_QUOTE_LENGTH) return null;

  // Walk the source once, recording where each normalized character came from, so a match
  // on the normalized text can be cut back out of the original.
  const offsets: number[] = [];
  let normalizedSource = "";
  let previousWasSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    const normalizedChar = normalizeForQuoteMatch(source[index]);
    if (normalizedChar === "") {
      // Whitespace collapses; a run of it contributes at most one space, and never a
      // leading one.
      if (/\s/.test(source[index]) && normalizedSource && !previousWasSpace) {
        offsets.push(index);
        normalizedSource += " ";
        previousWasSpace = true;
      }
      continue;
    }
    offsets.push(index);
    normalizedSource += normalizedChar;
    previousWasSpace = false;
  }

  const start = normalizedSource.indexOf(normalizedQuote);
  if (start === -1) return null;
  const end = start + normalizedQuote.length - 1;
  const from = offsets[start];
  const to = offsets[end];
  if (from === undefined || to === undefined) return null;
  return source.slice(from, to + 1).trim();
}

type ModelEntry = {
  sectionType: string;
  draft: string;
  quote: string;
  status: string;
};

/**
 * The referee.
 *
 * Every section in the vocabulary gets exactly one entry, whether or not the model
 * mentioned it: a section the model omitted is a gap the reader needs to know about, and
 * silently dropping it would let a lazy response look complete. A claimed SUPPORTED whose
 * quote is not in the abstract becomes REJECTED, never ABSENT — "the model made this up"
 * and "the paper does not say" are different facts and the checklist treats them alike
 * only after the user has been told which happened.
 */
export function validateDigestEntries(
  modelEntries: readonly ModelEntry[],
  abstract: string
): DigestEntry[] {
  const bySection = new Map<string, ModelEntry>();
  for (const entry of modelEntries) {
    if (!bySection.has(entry.sectionType)) bySection.set(entry.sectionType, entry);
  }

  return INFERABLE_SECTIONS.map((sectionType): DigestEntry => {
    const entry = bySection.get(sectionType);
    if (!entry || entry.status !== "SUPPORTED")
      return { sectionType, draft: entry?.draft?.trim() ?? "", quote: "", status: "ABSENT" };

    const draft = entry.draft?.trim() ?? "";
    if (!draft)
      return {
        sectionType,
        draft: "",
        quote: "",
        status: "REJECTED",
        rejectedReason: "empty_draft",
      };

    if (normalizeForQuoteMatch(entry.quote ?? "").length < MIN_QUOTE_LENGTH)
      return {
        sectionType,
        draft,
        quote: "",
        status: "REJECTED",
        rejectedReason: "quote_too_short",
      };

    const located = locateQuote(entry.quote, abstract);
    if (located === null)
      return {
        sectionType,
        draft,
        quote: "",
        status: "REJECTED",
        rejectedReason: "quote_not_in_source",
      };

    return { sectionType, draft, quote: located, status: "SUPPORTED" };
  });
}

/**
 * What the reader still has to open the paper for.
 *
 * Anything not verified as SUPPORTED belongs here. The abstract legitimately cannot answer
 * REVIEWER_CRITICISMS or REPRODUCIBILITY for most papers, so this list is usually
 * non-empty — that is the feature, not a shortfall. It turns the limit of the source into
 * the one thing a reader most wants: a short list of what to go looking for.
 */
export function buildReadingChecklist(
  entries: readonly DigestEntry[]
): InferableSection[] {
  return entries
    .filter(entry => entry.status !== "SUPPORTED")
    .map(entry => entry.sectionType);
}

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
  } catch {
    return fallback;
  }
}

/**
 * Build the digest. `sourceRef` is recorded so a digest can always be traced to the exact
 * text it was made from — an arXiv abstract changes when the authors revise the preprint.
 */
export async function runPaperDigest(
  userId: number,
  source: DigestSource & { sourceRef: string }
): Promise<PaperDigest> {
  const abstract = source.abstract.trim();
  if (abstract.length < 80)
    throw new Error(
      "초록이 너무 짧아 요약을 만들 수 없습니다. 원문을 직접 확인해 주세요."
    );

  // Authorised before the call, so a refused digest costs nothing, exactly as inference does.
  const grant = await authorizeInference(userId);
  const model = await resolveInferenceModel(grant.apiKey);

  let modelResult: { summary?: string; entries?: ModelEntry[] };
  try {
    const response = await invokeLLM({
      model,
      messages: buildDigestMessages(source),
      apiKey: grant.apiKey,
      maxTokens: MAX_DIGEST_TOKENS,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "paper_digest",
          strict: true,
          schema: digestResponseSchema(),
        },
      },
    });
    // Counted as soon as the call returns, matching inference: a prompt that makes the
    // model fail must not run free against the quota.
    await recordInferenceUsage(userId, grant, model);
    modelResult = safeJson<{ summary?: string; entries?: ModelEntry[] }>(
      response.choices?.[0]?.message?.content ?? "{}",
      {}
    );
  } catch (error) {
    await recordInferenceUsage(userId, grant, model).catch(() => undefined);
    throw new Error(
      error instanceof Error && error.message.startsWith("Gemini")
        ? "요약 생성에 실패했습니다. 원문 링크는 그대로 사용할 수 있습니다."
        : "요약 생성에 실패했습니다."
    );
  }

  const entries = validateDigestEntries(modelResult.entries ?? [], abstract);
  const rejected = entries.filter(entry => entry.status === "REJECTED");
  // The summary is the one field with no span to verify, so it is labelled rather than
  // trusted. Everything else in the digest carries its own quote.
  const summary = (modelResult.summary ?? "").trim();

  return {
    title: source.title,
    summary,
    entries,
    readingChecklist: buildReadingChecklist(entries),
    provisional: true,
    sourceKind: "arxiv_abstract",
    sourceRef: source.sourceRef,
    model,
    promptVersion: DIGEST_PROMPT_VERSION,
    warnings: [
      "초록만 읽고 만든 초안입니다. 노트가 아니며 근거로 저장되지 않습니다.",
      "인용이 초록에 실제로 있는 항목만 SUPPORTED로 표시했습니다.",
      "한 줄 요약은 인용으로 검증할 수 없는 유일한 항목입니다.",
      ...(rejected.length > 0
        ? [
            `${rejected.length}개 항목은 인용을 초록에서 찾지 못해 버렸습니다. 확인 목록에 포함됩니다.`,
          ]
        : []),
    ],
  };
}
