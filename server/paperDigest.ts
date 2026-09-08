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
import { fetchArxivFullText } from "./paperFullText";
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

/** What the analyst schema writes when the source names no value. */
export const ABSENT_TEXT = "없음";
export const UNSPECIFIED_TEXT = "명시 안 됨";

export type AnalystClaim = {
  index: number;
  text: string;
  quote: string;
  status: DigestStatus;
};

export type AnalystHypothesis = {
  claimIndex: number;
  text: string;
  quote: string;
  status: DigestStatus;
};

/**
 * Conditions as values, never prose. Each field is either what the source names or the
 * explicit `명시 안 됨` — a blank would read as "no baselines", which is a different and
 * much stronger statement than "the abstract does not list them".
 */
export type AnalystVerification = {
  claimIndex: number;
  datasets: string;
  metrics: string;
  baselines: string;
  seeds: string;
  scale: string;
  result: string;
  quote: string;
  status: DigestStatus;
};

export type AnalystLimitation = {
  text: string;
  /** The section the authors said it in, or `없음` when the source names none. */
  sourceSection: string;
  quote: string;
  status: DigestStatus;
};

export type AnalystReproducibility = {
  codeAvailable: string;
  hyperparameters: string;
  quote: string;
  status: DigestStatus;
};

/**
 * The analyst extraction: numbered claims, each with the hypothesis it sets out to
 * establish and the experiment that tested it, kept apart on purpose. Merging the two
 * hides the case where a paper tested something other than what it set out to test.
 */
export type AnalystExtraction = {
  claims: AnalystClaim[];
  hypotheses: AnalystHypothesis[];
  verifications: AnalystVerification[];
  limitations: AnalystLimitation[];
  reproducibility: AnalystReproducibility;
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
  /** Verified the same way as `entries`: nothing here is asserted without a located quote. */
  analyst: AnalystExtraction;
  /** Always true. A digest is a reading aid, not a note and not evidence. */
  provisional: true;
  /** Which text the quotes were checked against. */
  sourceKind: "arxiv_abstract" | "arxiv_fulltext";
  /** Section headings actually read, empty for an abstract-only digest. */
  sourceSections: string[];
  /** Why full text was not used, when it was not. */
  fullTextNote?: string;
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
    if (!bySection.has(entry.sectionType))
      bySection.set(entry.sectionType, entry);
  }

  return INFERABLE_SECTIONS.map((sectionType): DigestEntry => {
    const entry = bySection.get(sectionType);
    if (!entry || entry.status !== "SUPPORTED")
      return {
        sectionType,
        draft: entry?.draft?.trim() ?? "",
        quote: "",
        status: "ABSENT",
      };

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

type ModelQuoted = { quote?: unknown; [key: string]: unknown };

/**
 * Whether an item's quote is actually in the source.
 *
 * Same rule the section entries live by: an assertion without a locatable span is not
 * downgraded to "the paper does not say", it is marked REJECTED. Those are different
 * facts, and only one of them means the model made something up.
 */
function verifyQuote(
  item: ModelQuoted | undefined,
  abstract: string
): { status: DigestStatus; quote: string } {
  const raw = typeof item?.quote === "string" ? item.quote : "";
  if (!raw.trim()) return { status: "ABSENT", quote: "" };
  if (normalizeForQuoteMatch(raw).length < MIN_QUOTE_LENGTH)
    return { status: "REJECTED", quote: "" };
  const located = locateQuote(raw, abstract);
  return located === null
    ? { status: "REJECTED", quote: "" }
    : { status: "SUPPORTED", quote: located };
}

function text(value: unknown, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The analyst referee.
 *
 * A claim whose quote does not check out is kept and marked REJECTED rather than dropped:
 * a reader comparing the digest against the paper needs to see that the model asserted
 * something it could not support. Hypotheses and verifications hang off a claim index, so
 * one pointing at a claim that does not exist is discarded — it has nothing to be about.
 */
export function validateAnalystExtraction(
  raw: {
    claims?: readonly ModelQuoted[];
    hypotheses?: readonly ModelQuoted[];
    verifications?: readonly ModelQuoted[];
    limitations?: readonly ModelQuoted[];
    reproducibility?: ModelQuoted;
  },
  abstract: string
): AnalystExtraction {
  const claims: AnalystClaim[] = (raw.claims ?? [])
    .map((item, order): AnalystClaim => {
      const { status, quote } = verifyQuote(item, abstract);
      return {
        // Renumbered from position: a model that repeats or skips an index would otherwise
        // orphan every hypothesis pointing at it.
        index: order + 1,
        text: text(item.text, ABSENT_TEXT),
        quote,
        status,
      };
    })
    .filter(claim => claim.text !== ABSENT_TEXT);

  const claimIndexes = new Set(claims.map(claim => claim.index));
  const originalIndex = new Map<number, number>();
  (raw.claims ?? []).forEach((item, order) => {
    const declared = num(item.index);
    // First writer wins: when a model repeats a number, a hypothesis citing it means the
    // claim that used it first, not whichever happened to be emitted last.
    if (declared !== null && !originalIndex.has(declared))
      originalIndex.set(declared, order + 1);
  });
  const resolveIndex = (value: unknown) => {
    const declared = num(value);
    if (declared === null) return null;
    const mapped = originalIndex.get(declared) ?? declared;
    return claimIndexes.has(mapped) ? mapped : null;
  };

  const hypotheses: AnalystHypothesis[] = [];
  for (const item of raw.hypotheses ?? []) {
    const claimIndex = resolveIndex(item.claimIndex);
    if (claimIndex === null) continue;
    const { status, quote } = verifyQuote(item, abstract);
    hypotheses.push({
      claimIndex,
      text: text(item.text, ABSENT_TEXT),
      quote,
      status,
    });
  }

  const verifications: AnalystVerification[] = [];
  for (const item of raw.verifications ?? []) {
    const claimIndex = resolveIndex(item.claimIndex);
    if (claimIndex === null) continue;
    const { status, quote } = verifyQuote(item, abstract);
    verifications.push({
      claimIndex,
      // Conditions default to 명시 안 됨, not to a blank: an empty baseline field reads as
      // "no baselines were used", which the abstract did not say.
      datasets: text(item.datasets, UNSPECIFIED_TEXT),
      metrics: text(item.metrics, UNSPECIFIED_TEXT),
      baselines: text(item.baselines, UNSPECIFIED_TEXT),
      seeds: text(item.seeds, UNSPECIFIED_TEXT),
      scale: text(item.scale, UNSPECIFIED_TEXT),
      result: text(item.result, ABSENT_TEXT),
      quote,
      status,
    });
  }

  const limitations: AnalystLimitation[] = (raw.limitations ?? [])
    .map((item): AnalystLimitation => {
      const { status, quote } = verifyQuote(item, abstract);
      return {
        text: text(item.text, ABSENT_TEXT),
        sourceSection: text(item.sourceSection, ABSENT_TEXT),
        quote,
        status,
      };
    })
    .filter(limitation => limitation.text !== ABSENT_TEXT);

  const repro = raw.reproducibility;
  const reproVerified = verifyQuote(repro, abstract);
  const reproducibility: AnalystReproducibility = {
    codeAvailable: text(repro?.codeAvailable, ABSENT_TEXT),
    hyperparameters: text(repro?.hyperparameters, ABSENT_TEXT),
    quote: reproVerified.quote,
    status: reproVerified.status,
  };

  return { claims, hypotheses, verifications, limitations, reproducibility };
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
  source: DigestSource & { sourceRef: string; arxivId?: string }
): Promise<PaperDigest> {
  let abstract = source.abstract.trim();
  if (abstract.length < 80)
    throw new Error(
      "초록이 너무 짧아 요약을 만들 수 없습니다. 원문을 직접 확인해 주세요."
    );

  /**
   * Prefer the paper's own sections over its abstract.
   *
   * The analyst schema asks for seeds, baselines and acknowledged limitations, none of
   * which an abstract carries — it is about 1% of a paper. Selected sections reach them
   * while staying near the abstract's cost. Full text is best-effort: arXiv renders HTML
   * only for recent submissions, and an abstract-only digest is a smaller answer, not a
   * failed one.
   */
  let sourceKind: PaperDigest["sourceKind"] = "arxiv_abstract";
  let sourceSections: string[] = [];
  let fullTextNote: string | undefined;
  if (source.arxivId) {
    const full = await fetchArxivFullText(source.arxivId);
    if (full.kind === "arxiv_html") {
      abstract = full.text;
      sourceKind = "arxiv_fulltext";
      sourceSections = full.sections.map(section => section.heading);
      if (full.omitted.length)
        fullTextNote = `길이 제한으로 제외된 절: ${full.omitted.join(", ")}`;
    } else {
      fullTextNote = full.reason;
    }
  }

  // Authorised before the call, so a refused digest costs nothing, exactly as inference does.
  const grant = await authorizeInference(userId);
  const model = await resolveInferenceModel(grant.apiKey);

  type ModelResponse = {
    summary?: string;
    entries?: ModelEntry[];
  } & Parameters<typeof validateAnalystExtraction>[0];
  let modelResult: ModelResponse;
  try {
    const response = await invokeLLM({
      model,
      messages: buildDigestMessages({
        ...source,
        abstract,
        isFullText: sourceKind === "arxiv_fulltext",
      }),
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
    modelResult = safeJson<ModelResponse>(
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
    analyst: validateAnalystExtraction(modelResult, abstract),
    provisional: true,
    sourceKind,
    sourceSections,
    fullTextNote,
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
