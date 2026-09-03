import { describe, expect, it } from "vitest";
import {
  computeMissingSections,
  normalizeStoredResult,
  validateInferenceClaims,
} from "./inferenceService";
import { resolveTargetSections } from "./inferencePrompt";

describe("evidence-first inference validation", () => {
  const evidence = [
    {
      id: "ev_1",
      noteId: "note_a",
      versionId: "version_a",
      sectionType: "AUTHOR_LIMITATIONS" as const,
      rawHeading: "저자 명시",
      quote: "The authors state a limitation.",
    },
    {
      id: "ev_2",
      noteId: "note_b",
      versionId: "version_b",
      sectionType: "REVIEWER_CRITICISMS" as const,
      rawHeading: "리뷰어 지적",
      quote: "A reviewer raises a concern.",
    },
  ];

  it("accepts only claims whose evidence belongs to the same note and section", () => {
    const result = validateInferenceClaims(
      {
        claims: [
          {
            noteId: "note_a",
            sectionType: "AUTHOR_LIMITATIONS",
            answer: "supported",
            evidenceIds: ["ev_1"],
            supportStatus: "supported",
          },
          {
            noteId: "note_a",
            sectionType: "AUTHOR_LIMITATIONS",
            answer: "wrong note",
            evidenceIds: ["ev_2"],
            supportStatus: "supported",
          },
          {
            noteId: "other",
            sectionType: "AUTHOR_LIMITATIONS",
            answer: "outside scope",
            evidenceIds: ["ev_1"],
            supportStatus: "supported",
          },
          {
            noteId: "note_a",
            sectionType: "AUTHOR_LIMITATIONS",
            answer: "no citation",
            evidenceIds: [],
            supportStatus: "supported",
          },
        ],
        missing: [],
      },
      ["note_a", "note_b"],
      evidence
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.evidenceIds).toEqual(["ev_1"]);
  });

  it("does not treat reviewer evidence as author limitation evidence", () => {
    const result = validateInferenceClaims(
      {
        claims: [
          {
            noteId: "note_b",
            sectionType: "AUTHOR_LIMITATIONS",
            answer: "incorrect section",
            evidenceIds: ["ev_2"],
            supportStatus: "supported",
          },
        ],
        missing: [],
      },
      ["note_b"],
      evidence
    );
    expect(result).toHaveLength(0);
  });
});

describe("question scoping of missing sections", () => {
  it("limits the run to the sections the question names", () => {
    expect(
      resolveTargetSections("저자가 인정한 한계와 리뷰어 지적을 비교해줘.")
    ).toEqual(["AUTHOR_LIMITATIONS", "REVIEWER_CRITICISMS"]);
    expect(
      resolveTargetSections("Summarize the reproducibility details.")
    ).toEqual(["REPRODUCIBILITY"]);
  });

  it("falls back to every section when the question names none", () => {
    expect(resolveTargetSections("이 논문들을 서로 비교해줘.")).toEqual([
      "CLAIM",
      "SETTING",
      "AUTHOR_LIMITATIONS",
      "REVIEWER_CRITICISMS",
      "REPRODUCIBILITY",
    ]);
  });

  it("lets an explicit selection override the question text", () => {
    expect(resolveTargetSections("저자가 인정한 한계", ["CLAIM"])).toEqual([
      "CLAIM",
    ]);
    expect(
      resolveTargetSections("저자가 인정한 한계", ["NOT_A_SECTION"])
    ).toEqual(["AUTHOR_LIMITATIONS"]);
  });
});

describe("server-computed missing sections", () => {
  const evidence = [
    { noteId: "note_a", sectionType: "AUTHOR_LIMITATIONS" as const },
  ];

  it("reports nothing when every targeted section produced a validated claim", () => {
    expect(
      computeMissingSections({
        noteIds: ["note_a"],
        targetSections: ["AUTHOR_LIMITATIONS"],
        evidence,
        notesWithParsedSections: new Set(["note_a"]),
        claimedKeys: new Set(["note_a:AUTHOR_LIMITATIONS"]),
      })
    ).toEqual([]);
  });

  it("separates an absent section from a section the model could not cite", () => {
    expect(
      computeMissingSections({
        noteIds: ["note_a"],
        targetSections: ["AUTHOR_LIMITATIONS", "REVIEWER_CRITICISMS"],
        evidence,
        notesWithParsedSections: new Set(["note_a"]),
        claimedKeys: new Set(),
      })
    ).toEqual([
      {
        noteId: "note_a",
        sectionType: "AUTHOR_LIMITATIONS",
        reason: "no_quote_found",
      },
      {
        noteId: "note_a",
        sectionType: "REVIEWER_CRITICISMS",
        reason: "section_missing",
      },
    ]);
  });

  it("marks a note with no parsed sections as an unusable source", () => {
    expect(
      computeMissingSections({
        noteIds: ["note_b"],
        targetSections: ["CLAIM"],
        evidence: [],
        notesWithParsedSections: new Set(),
        claimedKeys: new Set(),
      })
    ).toEqual([
      { noteId: "note_b", sectionType: "CLAIM", reason: "source_unavailable" },
    ]);
  });

  it("ignores sections outside the question scope", () => {
    const missing = computeMissingSections({
      noteIds: ["note_a"],
      targetSections: ["AUTHOR_LIMITATIONS"],
      evidence,
      notesWithParsedSections: new Set(["note_a"]),
      claimedKeys: new Set(["note_a:AUTHOR_LIMITATIONS"]),
    });
    expect(missing.some(item => item.sectionType === "CLAIM")).toBe(false);
  });
});

describe("stored result normalization", () => {
  it("fills a missing question from the run row instead of showing undefined", () => {
    const result = normalizeStoredResult(
      JSON.stringify({ claims: [], missing: [] }),
      "저자가 인정한 한계를 정리해줘."
    );
    expect(result?.question).toBe("저자가 인정한 한계를 정리해줘.");
    expect(result?.targetSections).toEqual([]);
  });

  it("keeps a row readable rather than dropping it when fields are absent", () => {
    // An unreadable run cannot be reviewed, and an unreviewable run never reaches the
    // gold set — so a partial row is normalised, never rejected.
    const result = normalizeStoredResult("{}", "질문");
    expect(result).not.toBeNull();
    expect(result?.claims).toEqual([]);
  });

  it("returns null only when there is no stored result at all", () => {
    expect(normalizeStoredResult(null, "질문")).toBeNull();
    expect(normalizeStoredResult("not json", "질문")).toBeNull();
  });

  it("preserves a failed run's error text", () => {
    const result = normalizeStoredResult(
      JSON.stringify({ claims: [], missing: [], error: "model_error" }),
      "질문"
    );
    expect(result?.error).toBe("model_error");
  });
});
