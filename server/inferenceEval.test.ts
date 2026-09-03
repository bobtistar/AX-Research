import { describe, expect, it } from "vitest";
import { aggregate, scoreGoldCase, stdev } from "./inferenceEval";
import type { GoldCase } from "./goldSet";

const goldCase: GoldCase = {
  id: "gold_run_1",
  goldSetVersion: "gold-v1",
  question: "저자가 인정한 한계와 리뷰어 지적을 비교해줘.",
  recordedTargetSections: ["AUTHOR_LIMITATIONS", "REVIEWER_CRITICISMS"],
  notes: [],
  cells: [
    {
      noteId: "note_a",
      sectionType: "AUTHOR_LIMITATIONS",
      label: "SUPPORTED",
      quote: "The authors note a small sample.",
      source: "APPROVED_CLAIM",
    },
    {
      noteId: "note_a",
      sectionType: "REVIEWER_CRITICISMS",
      label: "ABSENT",
      source: "APPROVED_MISSING",
    },
  ],
  provenance: {
    runId: "run_1",
    workspaceId: "ws_1",
    promptVersion: "evidence-v2",
    model: "test-model",
    exportedAt: "1970-01-01T00:00:00.000Z",
  },
};

const bothSections = ["AUTHOR_LIMITATIONS", "REVIEWER_CRITICISMS"] as const;

/** Both gold cells had citable evidence unless a test says otherwise. */
const withEvidence = new Set([
  "note_a:AUTHOR_LIMITATIONS",
  "note_a:REVIEWER_CRITICISMS",
]);

function outcomes(
  claims: Array<{ noteId: string; sectionType: string; quotes: string[] }>,
  resolvedSections: readonly (typeof bothSections)[number][] = bothSections,
  evidenceCells: ReadonlySet<string> = withEvidence
) {
  return scoreGoldCase({
    goldCase,
    claims,
    resolvedSections,
    evidenceCells,
  }).cells.map(cell => cell.outcome);
}

describe("gold cell scoring", () => {
  it("matches a supported cell whose citation contains the gold quote", () => {
    expect(
      outcomes([
        {
          noteId: "note_a",
          sectionType: "AUTHOR_LIMITATIONS",
          quotes: ["The authors note a small sample. And more text."],
        },
      ])
    ).toEqual(["MATCHED", "CORRECT_ABSENT"]);
  });

  it("counts an answer on an absent cell as a fabrication", () => {
    expect(
      outcomes([
        {
          noteId: "note_a",
          sectionType: "AUTHOR_LIMITATIONS",
          quotes: ["The authors note a small sample."],
        },
        {
          noteId: "note_a",
          sectionType: "REVIEWER_CRITICISMS",
          quotes: ["invented reviewer complaint"],
        },
      ])
    ).toEqual(["MATCHED", "FABRICATED"]);
  });

  it("counts the author/reviewer swap as confusion, not a plain miss", () => {
    // The gold quote came back, but filed under the paired section.
    expect(
      outcomes([
        {
          noteId: "note_a",
          sectionType: "REVIEWER_CRITICISMS",
          quotes: ["The authors note a small sample."],
        },
      ])
    ).toEqual(["CONFUSED", "FABRICATED"]);
  });

  it("counts silence on a supported cell as a miss", () => {
    expect(outcomes([])).toEqual(["MISSED", "CORRECT_ABSENT"]);
  });

  it("counts a right-cell answer citing unrelated text as misquoted", () => {
    expect(
      outcomes([
        {
          noteId: "note_a",
          sectionType: "AUTHOR_LIMITATIONS",
          quotes: ["something else entirely"],
        },
      ])
    ).toEqual(["MISQUOTED", "CORRECT_ABSENT"]);
  });

  it("does not score an absent cell that had no evidence to answer from", () => {
    // The evidence contract makes an answer impossible here, so a silence proves nothing.
    expect(outcomes([], bothSections, new Set())).toEqual([
      "MISSED",
      "TRIVIAL_ABSENT",
    ]);
  });

  it("never rewards a narrowed scope: an unjudged absent cell is uncovered", () => {
    // Dropping REVIEWER_CRITICISMS from scope must not turn its absent cell into a win.
    expect(outcomes([], ["AUTHOR_LIMITATIONS"])).toEqual([
      "MISSED",
      "UNCOVERED",
    ]);
  });
});

describe("aggregate metrics", () => {
  const scored = (outcome: string, label: "SUPPORTED" | "ABSENT") => ({
    caseId: "c",
    resolvedSections: [],
    cells: [
      {
        noteId: "n",
        sectionType: "CLAIM" as const,
        label,
        source: "APPROVED_CLAIM" as const,
        outcome: outcome as never,
      },
    ],
  });

  it("scores a perfect run at 1", () => {
    const metrics = aggregate([
      scored("MATCHED", "SUPPORTED"),
      scored("CORRECT_ABSENT", "ABSENT"),
    ]);
    expect(metrics.score).toBe(1);
    expect(metrics.missingAccuracy).toBe(1);
  });

  it("penalises a fabrication twice as hard as a miss", () => {
    const fabricated = aggregate([scored("FABRICATED", "ABSENT")]);
    const missed = aggregate([scored("MISSED", "SUPPORTED")]);
    expect(fabricated.score).toBe(-1);
    expect(missed.score).toBe(0.5);
    expect(1 - fabricated.score).toBe(4 * (1 - missed.score));
  });

  it("gives the section swap its own term rather than hiding it in misses", () => {
    expect(aggregate([scored("CONFUSED", "SUPPORTED")]).score).toBe(0);
  });

  it("charges an uncovered cell as a miss", () => {
    expect(aggregate([scored("UNCOVERED", "ABSENT")]).score).toBe(0.5);
  });

  it("reports missing accuracy over judged absent cells only", () => {
    const metrics = aggregate([
      scored("CORRECT_ABSENT", "ABSENT"),
      scored("FABRICATED", "ABSENT"),
      scored("UNCOVERED", "ABSENT"),
    ]);
    expect(metrics.missingAccuracy).toBe(0.5);
  });

  it("leaves an unfailable absent cell out of the denominator", () => {
    const withTrivial = aggregate([
      scored("MATCHED", "SUPPORTED"),
      scored("MISSED", "SUPPORTED"),
      scored("TRIVIAL_ABSENT", "ABSENT"),
    ]);
    const withoutTrivial = aggregate([
      scored("MATCHED", "SUPPORTED"),
      scored("MISSED", "SUPPORTED"),
    ]);
    // Padding the gold set with unanswerable sections must not move the score.
    expect(withTrivial.score).toBe(withoutTrivial.score);
    expect(withTrivial.tally.total).toBe(3);
    expect(withTrivial.tally.scored).toBe(2);
  });

  it("counts no cells for a failed case", () => {
    expect(
      aggregate([
        { caseId: "c", resolvedSections: [], cells: [], error: "boom" },
      ]).tally.total
    ).toBe(0);
  });
});

describe("noise measurement", () => {
  it("returns zero spread for a single sample and a real one for several", () => {
    expect(stdev([0.8])).toBe(0);
    expect(stdev([0.8, 0.8, 0.8])).toBeCloseTo(0, 12);
    expect(stdev([0.7, 0.8, 0.9])).toBeCloseTo(0.1, 10);
  });
});
