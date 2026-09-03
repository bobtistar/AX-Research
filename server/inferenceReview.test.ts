import { describe, expect, it } from "vitest";
import {
  reviewableCells,
  summarizeReviews,
  type ReviewableCell,
  type ReviewVerdict,
} from "./inferenceReview";

const storedResult = {
  question: "저자 한계와 리뷰어 지적을 비교해줘.",
  claims: [
    {
      noteId: "note_a",
      sectionType: "AUTHOR_LIMITATIONS",
      answer: "저자는 표본 크기를 한계로 밝힌다.",
      evidenceIds: ["ev_1"],
      supportStatus: "supported",
      evidence: [{ evidenceId: "ev_1", quote: "small sample" }],
    },
    {
      noteId: "note_b",
      sectionType: "REVIEWER_CRITICISMS",
      answer: "리뷰어는 baseline 부족을 지적한다.",
      evidenceIds: ["ev_2"],
      supportStatus: "supported",
      evidence: [{ evidenceId: "ev_2", quote: "missing baseline" }],
    },
  ],
  missing: [
    {
      noteId: "note_a",
      sectionType: "REPRODUCIBILITY",
      reason: "section_missing",
    },
  ],
};

function labelled(
  cell: ReviewableCell,
  verdict: ReviewVerdict
): ReviewableCell & { verdict: ReviewVerdict } {
  return { ...cell, verdict };
}

describe("reviewable cells", () => {
  it("derives one cell per claim and per missing section", () => {
    expect(reviewableCells(storedResult)).toEqual([
      {
        targetKind: "CLAIM",
        noteId: "note_a",
        sectionType: "AUTHOR_LIMITATIONS",
      },
      {
        targetKind: "CLAIM",
        noteId: "note_b",
        sectionType: "REVIEWER_CRITICISMS",
      },
      {
        targetKind: "MISSING",
        noteId: "note_a",
        sectionType: "REPRODUCIBILITY",
      },
    ]);
  });

  it("collapses repeated claims on one note and section into a single cell", () => {
    const cells = reviewableCells({
      claims: [
        { noteId: "note_a", sectionType: "CLAIM" },
        { noteId: "note_a", sectionType: "CLAIM" },
      ],
      missing: [],
    });
    expect(cells).toHaveLength(1);
  });

  it("keeps the same note and section separable across claim and missing", () => {
    const cells = reviewableCells({
      claims: [{ noteId: "note_a", sectionType: "CLAIM" }],
      missing: [{ noteId: "note_a", sectionType: "CLAIM" }],
    });
    expect(cells.map(cell => cell.targetKind)).toEqual(["CLAIM", "MISSING"]);
  });

  it("ignores malformed rows instead of producing unreviewable cells", () => {
    expect(
      reviewableCells({
        claims: [{ noteId: 12 }, { noteId: "note_a" }],
        missing: undefined,
      })
    ).toEqual([]);
    expect(reviewableCells(null)).toEqual([]);
  });
});

describe("review summary", () => {
  const cells = reviewableCells(storedResult);

  it("reports every cell as pending before any verdict", () => {
    expect(summarizeReviews(cells, [])).toEqual({
      total: 3,
      approved: 0,
      rejected: 0,
      pending: 3,
      status: "pending",
    });
  });

  it("counts approvals and rejections separately", () => {
    const summary = summarizeReviews(cells, [
      labelled(cells[0], "APPROVED"),
      labelled(cells[1], "REJECTED"),
    ]);
    expect(summary).toEqual({
      total: 3,
      approved: 1,
      rejected: 1,
      pending: 1,
      status: "partial",
    });
  });

  it("is complete only when no cell is left unreviewed", () => {
    const summary = summarizeReviews(
      cells,
      cells.map(cell => labelled(cell, "APPROVED"))
    );
    expect(summary.pending).toBe(0);
    expect(summary.status).toBe("complete");
  });

  it("does not count a verdict whose cell is gone from the current result", () => {
    const summary = summarizeReviews(cells, [
      labelled(
        {
          targetKind: "CLAIM",
          noteId: "note_deleted",
          sectionType: "SETTING",
        },
        "APPROVED"
      ),
    ]);
    expect(summary).toEqual({
      total: 3,
      approved: 0,
      rejected: 0,
      pending: 3,
      status: "pending",
    });
  });

  it("reports a run with nothing to review as none, not complete", () => {
    expect(summarizeReviews([], []).status).toBe("none");
  });
});
