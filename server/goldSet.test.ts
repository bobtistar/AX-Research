import { describe, expect, it } from "vitest";
import { buildGoldCase, isNoEvidenceMarker, type GoldNote } from "./goldSet";

const notes: GoldNote[] = [
  {
    noteId: "note_a",
    versionId: "version_a",
    title: "DINCO",
    sections: [
      {
        sectionType: "AUTHOR_LIMITATIONS",
        rawHeading: "저자 명시",
        body: "The authors note a small sample.",
        explicitEmpty: false,
      },
    ],
  },
];

const run = {
  id: "run_1",
  workspaceId: "ws_1",
  question: "저자가 인정한 한계와 리뷰어 지적을 비교해줘.",
  promptVersion: "evidence-v2",
  model: "test-model",
  resultJson: JSON.stringify({
    question: "저자가 인정한 한계와 리뷰어 지적을 비교해줘.",
    targetSections: ["AUTHOR_LIMITATIONS", "REVIEWER_CRITICISMS"],
    claims: [
      {
        noteId: "note_a",
        sectionType: "AUTHOR_LIMITATIONS",
        evidence: [{ quote: "The authors note a small sample." }],
      },
      {
        noteId: "note_a",
        sectionType: "CLAIM",
        evidence: [{ quote: "We propose DINCO." }],
      },
    ],
    missing: [{ noteId: "note_a", sectionType: "REVIEWER_CRITICISMS" }],
  }),
};

function build(reviews: Parameters<typeof buildGoldCase>[0]["reviews"]) {
  return buildGoldCase({ run, reviews, notes, exportedAt: new Date(0) });
}

describe("gold case construction", () => {
  it("turns an approved claim into a supported label carrying the cited quote", () => {
    const { goldCase } = build([
      {
        targetKind: "CLAIM",
        noteId: "note_a",
        sectionType: "AUTHOR_LIMITATIONS",
        verdict: "APPROVED",
        correctedQuote: null,
      },
    ]);
    expect(goldCase?.cells).toEqual([
      {
        noteId: "note_a",
        sectionType: "AUTHOR_LIMITATIONS",
        label: "SUPPORTED",
        quote: "The authors note a small sample.",
        source: "APPROVED_CLAIM",
      },
    ]);
  });

  it("turns an approved missing verdict into an absent label", () => {
    const { goldCase } = build([
      {
        targetKind: "MISSING",
        noteId: "note_a",
        sectionType: "REVIEWER_CRITICISMS",
        verdict: "APPROVED",
        correctedQuote: null,
      },
    ]);
    expect(goldCase?.cells[0]).toMatchObject({
      label: "ABSENT",
      source: "APPROVED_MISSING",
    });
    expect(goldCase?.cells[0].quote).toBeUndefined();
  });

  it("reads a rejected claim's correction as the right quote", () => {
    const { goldCase } = build([
      {
        targetKind: "CLAIM",
        noteId: "note_a",
        sectionType: "CLAIM",
        verdict: "REJECTED",
        correctedQuote: "We propose DINCO.",
      },
    ]);
    expect(goldCase?.cells[0]).toMatchObject({
      label: "SUPPORTED",
      quote: "We propose DINCO.",
      source: "REJECTED_CLAIM",
    });
  });

  it("reads the no-evidence marker on a rejected claim as absence", () => {
    const { goldCase } = build([
      {
        targetKind: "CLAIM",
        noteId: "note_a",
        sectionType: "CLAIM",
        verdict: "REJECTED",
        correctedQuote: "근거 없음",
      },
    ]);
    expect(goldCase?.cells[0]).toMatchObject({
      label: "ABSENT",
      source: "REJECTED_CLAIM",
    });
  });

  it("drops a rejected missing verdict that names no existing quote", () => {
    // "this section is not missing" plus "there is no evidence" contradict each other.
    const { goldCase, skipped } = build([
      {
        targetKind: "MISSING",
        noteId: "note_a",
        sectionType: "REVIEWER_CRITICISMS",
        verdict: "REJECTED",
        correctedQuote: "근거 없음",
      },
    ]);
    expect(goldCase).toBeNull();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/제시하지 않음/);
  });

  it("drops an approved claim whose quote is no longer in the stored result", () => {
    const { goldCase, skipped } = build([
      {
        targetKind: "CLAIM",
        noteId: "note_b",
        sectionType: "SETTING",
        verdict: "APPROVED",
        correctedQuote: null,
      },
    ]);
    expect(goldCase).toBeNull();
    expect(skipped[0].reason).toMatch(/인용 문장이 남아 있지 않음/);
  });

  it("drops a verdict on a section outside the closed vocabulary", () => {
    const { skipped } = build([
      {
        targetKind: "CLAIM",
        noteId: "note_a",
        sectionType: "FUTURE_WORK",
        verdict: "APPROVED",
        correctedQuote: null,
      },
    ]);
    expect(skipped[0].reason).toMatch(/알 수 없는 section type/);
  });

  it("carries the frozen note text and provenance into the case", () => {
    const { goldCase } = build([
      {
        targetKind: "MISSING",
        noteId: "note_a",
        sectionType: "REVIEWER_CRITICISMS",
        verdict: "APPROVED",
        correctedQuote: null,
      },
    ]);
    expect(goldCase?.notes[0].sections[0].body).toBe(
      "The authors note a small sample."
    );
    expect(goldCase?.provenance).toMatchObject({
      runId: "run_1",
      promptVersion: "evidence-v2",
      model: "test-model",
    });
  });
});

describe("no-evidence marker", () => {
  it("matches only an exact marker, not a quote that mentions it", () => {
    expect(isNoEvidenceMarker(" 근거 없음 ")).toBe(true);
    expect(isNoEvidenceMarker("근거없음")).toBe(true);
    expect(isNoEvidenceMarker("No Evidence")).toBe(true);
    expect(isNoEvidenceMarker("저자는 근거 없음을 인정한다.")).toBe(false);
  });
});
