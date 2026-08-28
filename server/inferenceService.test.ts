import { describe, expect, it } from "vitest";
import { validateInferenceClaims } from "./inferenceService";

describe("evidence-first inference validation", () => {
  const evidence = [
    { id: "ev_1", noteId: "note_a", versionId: "version_a", sectionType: "AUTHOR_LIMITATIONS" as const, rawHeading: "저자 명시", quote: "The authors state a limitation." },
    { id: "ev_2", noteId: "note_b", versionId: "version_b", sectionType: "REVIEWER_CRITICISMS" as const, rawHeading: "리뷰어 지적", quote: "A reviewer raises a concern." },
  ];

  it("accepts only claims whose evidence belongs to the same note and section", () => {
    const result = validateInferenceClaims({ claims: [
      { noteId: "note_a", sectionType: "AUTHOR_LIMITATIONS", answer: "supported", evidenceIds: ["ev_1"], supportStatus: "supported" },
      { noteId: "note_a", sectionType: "AUTHOR_LIMITATIONS", answer: "wrong note", evidenceIds: ["ev_2"], supportStatus: "supported" },
      { noteId: "other", sectionType: "AUTHOR_LIMITATIONS", answer: "outside scope", evidenceIds: ["ev_1"], supportStatus: "supported" },
      { noteId: "note_a", sectionType: "AUTHOR_LIMITATIONS", answer: "no citation", evidenceIds: [], supportStatus: "supported" },
    ], missing: [] }, ["note_a", "note_b"], evidence);
    expect(result).toHaveLength(1);
    expect(result[0]?.evidenceIds).toEqual(["ev_1"]);
  });

  it("does not treat reviewer evidence as author limitation evidence", () => {
    const result = validateInferenceClaims({ claims: [
      { noteId: "note_b", sectionType: "AUTHOR_LIMITATIONS", answer: "incorrect section", evidenceIds: ["ev_2"], supportStatus: "supported" },
    ], missing: [] }, ["note_b"], evidence);
    expect(result).toHaveLength(0);
  });
});
