import { describe, expect, it } from "vitest";
import { INFERABLE_SECTIONS } from "@shared/sections";
import {
  buildReadingChecklist,
  locateQuote,
  MIN_QUOTE_LENGTH,
  normalizeForQuoteMatch,
  validateDigestEntries,
} from "./paperDigest";

const ABSTRACT = [
  "We introduce Graph of Thoughts (GoT): a framework that advances prompting capabilities",
  "in large language models. We evaluate GoT on sorting, keyword counting and document",
  "merging, comparing against Chain-of-Thought and Tree of Thoughts. The approach “improves”",
  "quality by 62% over ToT while reducing costs — measured on GPT-3.5.",
].join("\n");

describe("quote location", () => {
  it("accepts a span that differs only in wrapping and punctuation style", () => {
    // Models routinely straighten curly quotes, convert dashes and rewrap lines. Those are
    // transcription artefacts, not different content.
    expect(
      locateQuote('The approach "improves" quality by 62% over ToT', ABSTRACT)
    ).toContain("quality by 62% over ToT");
    expect(
      locateQuote(
        "advances prompting capabilities in large language models",
        ABSTRACT
      )
    ).toBeTruthy();
  });

  it("returns the source's own wording, not the model's near-copy", () => {
    const located = locateQuote(
      'The approach "improves" quality by 62%',
      ABSTRACT
    );
    // The curly quotes come back, because what is shown as a quotation must be the paper.
    expect(located).toContain("“improves”");
  });

  it("refuses a sentence that is not in the abstract", () => {
    expect(
      locateQuote(
        "We release all code and pretrained checkpoints on GitHub.",
        ABSTRACT
      )
    ).toBeNull();
  });

  it("refuses a span shorter than the floor", () => {
    // Otherwise the cheapest way to pass verification is to cite one common word.
    expect("the".length).toBeLessThan(MIN_QUOTE_LENGTH);
    expect(locateQuote("the", ABSTRACT)).toBeNull();
  });

  it("normalises whitespace and case without deleting words", () => {
    expect(normalizeForQuoteMatch("  A  B\nC ")).toBe("a b c");
    expect(normalizeForQuoteMatch("—–-")).toBe("---");
  });
});

const entry = (over: Partial<Record<string, string>> = {}) => ({
  sectionType: "CLAIM",
  draft: "GoT는 프롬프팅 능력을 확장하는 프레임워크라고 주장한다.",
  quote: "advances prompting capabilities in large language models",
  status: "SUPPORTED",
  ...over,
});

describe("digest referee", () => {
  it("returns exactly one entry per section, including ones the model skipped", () => {
    // A response that mentions one section must not read as a complete digest.
    const entries = validateDigestEntries([entry()], ABSTRACT);
    expect(entries.map(item => item.sectionType)).toEqual(
      Array.from(INFERABLE_SECTIONS)
    );
    expect(entries.filter(item => item.status === "SUPPORTED")).toHaveLength(1);
  });

  it("keeps a supported entry and re-cuts its quote from the source", () => {
    const [claim] = validateDigestEntries([entry()], ABSTRACT);
    expect(claim.status).toBe("SUPPORTED");
    expect(ABSTRACT.replace(/\s+/g, " ")).toContain(
      claim.quote.replace(/\s+/g, " ")
    );
  });

  it("rejects a fabricated quote rather than downgrading it to absent", () => {
    // "The model made this up" and "the paper does not say" are different facts.
    const [claim] = validateDigestEntries(
      [entry({ quote: "We release all code and checkpoints on GitHub." })],
      ABSTRACT
    );
    expect(claim.status).toBe("REJECTED");
    expect(claim.rejectedReason).toBe("quote_not_in_source");
  });

  it("rejects a supported entry with no draft or a token quote", () => {
    expect(
      validateDigestEntries([entry({ draft: "   " })], ABSTRACT)[0]
    ).toMatchObject({ status: "REJECTED", rejectedReason: "empty_draft" });
    expect(
      validateDigestEntries([entry({ quote: "GoT" })], ABSTRACT)[0]
    ).toMatchObject({ status: "REJECTED", rejectedReason: "quote_too_short" });
  });

  it("never carries a quote on an entry that is not supported", () => {
    const entries = validateDigestEntries(
      [entry({ quote: "nowhere in this abstract at all" })],
      ABSTRACT
    );
    expect(
      entries.every(item => item.status === "SUPPORTED" || item.quote === "")
    ).toBe(true);
  });

  it("keeps AUTHOR_LIMITATIONS and REVIEWER_CRITICISMS from merging", () => {
    // The abstract carries neither, so a model that copies one into the other is caught by
    // the quote check rather than by trusting its labelling.
    const entries = validateDigestEntries(
      [
        entry({
          sectionType: "REVIEWER_CRITICISMS",
          quote: "reviewers argued the evaluation was too narrow",
        }),
      ],
      ABSTRACT
    );
    const reviewer = entries.find(
      item => item.sectionType === "REVIEWER_CRITICISMS"
    );
    expect(reviewer?.status).toBe("REJECTED");
  });

  it("ignores a duplicate section, taking the first entry only", () => {
    const entries = validateDigestEntries(
      [entry(), entry({ draft: "두 번째 주장", quote: "sorting, keyword counting" })],
      ABSTRACT
    );
    expect(entries[0].draft).toBe(entry().draft);
  });
});

describe("reading checklist", () => {
  it("lists every section the abstract could not answer", () => {
    const entries = validateDigestEntries([entry()], ABSTRACT);
    const checklist = buildReadingChecklist(entries);
    expect(checklist).not.toContain("CLAIM");
    // An abstract answers neither of these for essentially any paper, which is exactly
    // what the reader needs to be told to go looking for.
    expect(checklist).toContain("REVIEWER_CRITICISMS");
    expect(checklist).toContain("REPRODUCIBILITY");
  });

  it("includes a rejected section, so a discarded quote is never silently lost", () => {
    const entries = validateDigestEntries(
      [entry({ quote: "invented sentence that is not present" })],
      ABSTRACT
    );
    expect(buildReadingChecklist(entries)).toContain("CLAIM");
  });

  it("is empty only when every section verified", () => {
    const all = INFERABLE_SECTIONS.map(sectionType =>
      entry({ sectionType, quote: "advances prompting capabilities" })
    );
    expect(buildReadingChecklist(validateDigestEntries(all, ABSTRACT))).toEqual(
      []
    );
  });
});
