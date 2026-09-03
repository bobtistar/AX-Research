/**
 * Scores the current prompt policy against the frozen gold set.
 *
 * The scalar this produces is the whole point of the loop: without one, "did that prompt
 * change help?" has no mechanical answer and a night of experiments optimises nothing.
 *
 * Scoring is pure and separated from the model call so the rules can be tested without
 * spending tokens; `runEval.ts` supplies the real call.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PAIRED_SECTIONS, type InferableSection } from "@shared/sections";
import type { GoldCase, GoldCell } from "./goldSet";
import type { Evidence } from "./inferencePrompt";

export type CellOutcome =
  /** Gold says supported, the model answered here and cited text containing the gold quote. */
  | "MATCHED"
  /** Gold says absent, evidence for the section existed, and the model stayed silent. */
  | "CORRECT_ABSENT"
  /**
   * Gold says absent and no evidence for the section was supplied at all, so
   * `validateInferenceClaims` could not have accepted an answer here even if the model
   * produced one. Reported but excluded from the score: a cell that cannot be failed is
   * not evidence that the prompt is good.
   */
  | "TRIVIAL_ABSENT"
  /** Gold says absent, the model answered anyway. The failure this project cares most about. */
  | "FABRICATED"
  /**
   * Gold says supported; the gold quote came back filed under the paired section instead.
   * The evidence contract makes this rare — `validateInferenceClaims` already rejects a
   * claim citing another section's evidence — so this is mainly a tripwire on
   * `selectEvidence`: merging the two sections into one evidence blob to raise recall
   * would light it up.
   */
  | "CONFUSED"
  /** Gold says supported, the model answered but cited text that does not contain the quote. */
  | "MISQUOTED"
  /** Gold says supported, the model reported nothing. */
  | "MISSED"
  /** The resolved scope excluded this cell, so it was never judged either way. */
  | "UNCOVERED";

export type ScoredCell = GoldCell & { outcome: CellOutcome };

export type CaseScore = {
  caseId: string;
  resolvedSections: InferableSection[];
  cells: ScoredCell[];
  /** Set when the model call or its parsing failed; the case then contributes no cells. */
  error?: string;
};

export type Tally = Record<CellOutcome, number> & {
  /** Every gold cell. */
  total: number;
  /** Cells the score is computed over: `total` minus the structurally unfailable ones. */
  scored: number;
};

export type EvalMetrics = {
  tally: Tally;
  /** Absent cells the model invented an answer for, over all cells. */
  fabricationRate: number;
  /** Supported cells filed under the paired section, over all cells. */
  confusionRate: number;
  /** Supported cells the model failed to deliver, over all cells. */
  missRate: number;
  /** Diagnostic: absent cells correctly left alone, over absent cells in scope. */
  missingAccuracy: number;
  score: number;
};

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

/** Either string containing the other counts as grounded: a gold quote may be a span of the section. */
function quotesOverlap(evidenceQuote: string, goldQuote: string) {
  const a = normalize(evidenceQuote);
  const b = normalize(goldQuote);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

export type ScoredClaim = {
  noteId: string;
  sectionType: string;
  quotes: string[];
};

/**
 * One gold case's outcome per cell.
 *
 * A cell outside the resolved scope is UNCOVERED, never CORRECT_ABSENT. Scoring an unjudged
 * absence as a success would pay the policy for narrowing its own scope, which is the
 * cheapest way to fake an improvement here.
 */
export function scoreGoldCase(params: {
  goldCase: GoldCase;
  claims: readonly ScoredClaim[];
  resolvedSections: readonly InferableSection[];
  /** `noteId:sectionType` keys that had citable evidence in this run. */
  evidenceCells?: ReadonlySet<string>;
}): CaseScore {
  const { goldCase, claims, resolvedSections } = params;
  const evidenceCells = params.evidenceCells;
  const inScope = new Set<string>(resolvedSections);
  const claimsByCell = new Map<string, ScoredClaim[]>();
  for (const claim of claims) {
    const key = `${claim.noteId}:${claim.sectionType}`;
    claimsByCell.set(key, (claimsByCell.get(key) ?? []).concat(claim));
  }

  const cells = goldCase.cells.map((cell): ScoredCell => {
    const here = claimsByCell.get(`${cell.noteId}:${cell.sectionType}`) ?? [];

    if (here.length > 0) {
      if (cell.label === "ABSENT") return { ...cell, outcome: "FABRICATED" };
      const grounded = here.some(claim =>
        claim.quotes.some(quote => quotesOverlap(quote, cell.quote ?? ""))
      );
      return { ...cell, outcome: grounded ? "MATCHED" : "MISQUOTED" };
    }

    if (!inScope.has(cell.sectionType))
      return { ...cell, outcome: "UNCOVERED" };
    if (cell.label === "ABSENT") {
      const hadEvidence =
        evidenceCells?.has(`${cell.noteId}:${cell.sectionType}`) ?? true;
      return {
        ...cell,
        outcome: hadEvidence ? "CORRECT_ABSENT" : "TRIVIAL_ABSENT",
      };
    }

    const paired = PAIRED_SECTIONS[cell.sectionType];
    if (paired) {
      const swapped = claimsByCell.get(`${cell.noteId}:${paired}`) ?? [];
      const carriesGoldQuote = swapped.some(claim =>
        claim.quotes.some(quote => quotesOverlap(quote, cell.quote ?? ""))
      );
      if (carriesGoldQuote) return { ...cell, outcome: "CONFUSED" };
    }
    return { ...cell, outcome: "MISSED" };
  });

  return {
    caseId: goldCase.id,
    resolvedSections: Array.from(resolvedSections),
    cells,
  };
}

const EMPTY_TALLY: Tally = {
  MATCHED: 0,
  CORRECT_ABSENT: 0,
  TRIVIAL_ABSENT: 0,
  FABRICATED: 0,
  CONFUSED: 0,
  MISQUOTED: 0,
  MISSED: 0,
  UNCOVERED: 0,
  total: 0,
  scored: 0,
};

/**
 * Composite score, higher is better, 1.0 is perfect and it can go negative.
 *
 *   score = 1 − (2·fabrication + confusion + 0.5·miss)
 *
 * Fabrication carries double weight because answering without evidence is the one failure
 * the whole project is built to prevent; a miss is half-weighted because a refusal is
 * recoverable by a human and a fabrication is not. Merging the two paired sections gets its
 * own term so a swap cannot hide inside the miss count.
 *
 * MISQUOTED and UNCOVERED are folded into the miss term: in both the reviewer's supported
 * answer failed to come back grounded, whether because the model cited the wrong text or
 * because the policy never asked.
 *
 * TRIVIAL_ABSENT cells leave the denominator entirely. The evidence contract already makes
 * an answer impossible where no evidence was supplied, so counting those as wins would let
 * a gold set full of empty sections report a high score for any prompt at all.
 */
export function aggregate(cases: readonly CaseScore[]): EvalMetrics {
  const tally: Tally = { ...EMPTY_TALLY };
  for (const item of cases) {
    for (const cell of item.cells) {
      tally[cell.outcome] += 1;
      tally.total += 1;
      if (cell.outcome !== "TRIVIAL_ABSENT") tally.scored += 1;
    }
  }
  const total = tally.scored || 1;
  const fabricationRate = tally.FABRICATED / total;
  const confusionRate = tally.CONFUSED / total;
  const missRate = (tally.MISSED + tally.MISQUOTED + tally.UNCOVERED) / total;
  const absentJudged = tally.CORRECT_ABSENT + tally.FABRICATED;
  return {
    tally,
    fabricationRate,
    confusionRate,
    missRate,
    missingAccuracy: absentJudged ? tally.CORRECT_ABSENT / absentJudged : 1,
    score: 1 - (2 * fabricationRate + confusionRate + 0.5 * missRate),
  };
}

/** Sample standard deviation. Reported so a run's delta can be compared against its noise. */
export function stdev(values: readonly number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

export function mean(values: readonly number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Flattens a gold case's frozen notes into the section rows the evidence policy consumes. */
export function goldCaseSections(goldCase: GoldCase) {
  return goldCase.notes.flatMap(note =>
    note.sections.map(section => ({
      noteId: note.noteId,
      versionId: note.versionId,
      sectionType: section.sectionType,
      rawHeading: section.rawHeading,
      body: section.body,
      explicitEmpty: section.explicitEmpty,
    }))
  );
}

/** Resolves validated claims to the quotes they cited, which is what scoring compares. */
export function claimsWithQuotes(
  claims: ReadonlyArray<{
    noteId: string;
    sectionType: string;
    evidenceIds: string[];
  }>,
  evidence: readonly Evidence[]
): ScoredClaim[] {
  const byId = new Map(evidence.map(item => [item.id, item]));
  return claims.map(claim => ({
    noteId: claim.noteId,
    sectionType: claim.sectionType,
    quotes: claim.evidenceIds
      .map(id => byId.get(id)?.quote)
      .filter((quote): quote is string => typeof quote === "string"),
  }));
}

export function loadGoldCases(dir: string): GoldCase[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(name => name.endsWith(".json"));
  } catch {
    throw new Error(
      `gold set 디렉터리를 찾을 수 없습니다: ${dir}\n먼저 \`pnpm eval:export\`를 실행하세요.`
    );
  }
  return files
    .sort()
    .map(
      name => JSON.parse(readFileSync(resolve(dir, name), "utf-8")) as GoldCase
    );
}
