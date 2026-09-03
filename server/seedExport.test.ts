import { describe, expect, it } from "vitest";
import { parseMarkdownNote } from "./noteParser";
import { buildSeedNoteMarkdown, toSeedFileName } from "./seedExport";

const candidate = {
  title: 'Conformal PID Control: "Adaptive" Time Series Prediction',
  doi: "10.1000/example",
  openAlexId: "https://openalex.org/W123",
  venue: "Advances in Neural Information Processing Systems",
  venueCode: "NeurIPS",
  year: 2023,
  citedByCount: 42,
  sourceUrl: "https://doi.org/10.1000/example",
  provenance: ["conformal prediction", "adaptive conformal prediction"],
};
const context = {
  topic: "time-series conformal prediction",
  exportedAt: new Date("2026-08-28T00:00:00Z"),
};

describe("seed note export", () => {
  it("round-trips through the note parser without warnings about its own frontmatter", () => {
    const markdown = buildSeedNoteMarkdown(candidate, context);
    const parsed = parseMarkdownNote("20_seeds/seed.md", markdown);
    expect(parsed.title).toBe(candidate.title);
    expect(parsed.externalId).toBe("10.1000/example");
    expect(parsed.metadata.queries).toEqual(candidate.provenance);
    expect(parsed.metadata.venue_code).toBe("NeurIPS");
    expect(parsed.metadata.year).toBe(2023);
    expect(
      parsed.warnings.some(warning =>
        warning.startsWith("frontmatter_unparsed")
      )
    ).toBe(false);
    expect(
      parsed.warnings.some(warning => warning.startsWith("unknown_heading"))
    ).toBe(false);
  });

  it("emits every recognised section and leaves all of them unfilled", () => {
    const parsed = parseMarkdownNote(
      "seed.md",
      buildSeedNoteMarkdown(candidate, context)
    );
    const headings = parsed.sections.filter(
      section => section.sectionType !== "FRONTMATTER"
    );
    expect(headings.map(section => section.sectionType)).toEqual([
      "CLAIM",
      "SETTING",
      "AUTHOR_LIMITATIONS",
      "REVIEWER_CRITICISMS",
      "REPRODUCIBILITY",
      "USER_OBSERVATIONS",
      "USER_CONTEXT",
    ]);
    // Nothing is written into a section, so nothing can be mistaken for paper evidence.
    expect(headings.every(section => section.body === "")).toBe(true);
    expect(parsed.explicitEmptySections).toEqual([]);
    expect(parsed.sectionPresence.CLAIM).toBe(false);
  });

  it("keeps a title with a colon and quotes intact through YAML", () => {
    const parsed = parseMarkdownNote(
      "seed.md",
      buildSeedNoteMarkdown(candidate, context)
    );
    expect(parsed.metadata.title).toBe(
      'Conformal PID Control: "Adaptive" Time Series Prediction'
    );
  });

  it("falls back to the OpenAlex ID when a seed has no DOI", () => {
    const parsed = parseMarkdownNote(
      "seed.md",
      buildSeedNoteMarkdown({ ...candidate, doi: null }, context)
    );
    expect(parsed.externalId).toBe("https://openalex.org/W123");
  });

  it("builds a filename that is safe on every platform", () => {
    // Quotes and colons are stripped rather than escaped, because a file name is not YAML.
    expect(toSeedFileName(candidate)).toBe(
      "Conformal PID Control Adaptive Time Series Prediction (2023).md"
    );
    expect(toSeedFileName({ ...candidate, title: "a/b\\c:d*e?f" })).not.toMatch(
      /[\/\\:*?<>|]/
    );
  });
});
