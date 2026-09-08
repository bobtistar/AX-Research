import { describe, expect, it } from "vitest";
import { INFERABLE_SECTIONS } from "@shared/sections";
import {
  MIN_QUOTE_LENGTH,
  buildReadingChecklist,
  locateQuote,
  normalizeForQuoteMatch,
  validateAnalystExtraction,
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
      [
        entry(),
        entry({ draft: "두 번째 주장", quote: "sorting, keyword counting" }),
      ],
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

describe("analyst extraction referee", () => {
  const abstract =
    "We introduce K-MetBench, a benchmark for expert reasoning in meteorology. " +
    "We evaluate on KMMLU and report accuracy against GPT-4 and Gemini baselines.";

  it("numbers claims by position and keeps their located quote", () => {
    const result = validateAnalystExtraction(
      {
        claims: [
          {
            index: 1,
            text: "K-MetBench 벤치마크를 제안한다.",
            quote: "We introduce K-MetBench, a benchmark for expert reasoning",
          },
        ],
      },
      abstract
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ index: 1, status: "SUPPORTED" });
    expect(abstract).toContain(result.claims[0].quote);
  });

  it("marks a fabricated quote REJECTED rather than dropping or downgrading it", () => {
    // "The paper does not say" and "the model made this up" are different facts, and a
    // reader checking the digest needs to see which happened.
    const result = validateAnalystExtraction(
      {
        claims: [
          {
            index: 1,
            text: "지어낸 주장",
            quote: "We prove convergence under adversarial noise",
          },
        ],
      },
      abstract
    );
    expect(result.claims[0].status).toBe("REJECTED");
    expect(result.claims[0].quote).toBe("");
  });

  it("discards a hypothesis pointing at a claim that does not exist", () => {
    const result = validateAnalystExtraction(
      {
        claims: [{ index: 1, text: "주장", quote: "We introduce K-MetBench" }],
        hypotheses: [{ claimIndex: 7, text: "떠 있는 가설", quote: "" }],
      },
      abstract
    );
    expect(result.hypotheses).toEqual([]);
  });

  it("renumbers claims so a repeated index does not orphan its hypothesis", () => {
    const result = validateAnalystExtraction(
      {
        claims: [
          { index: 3, text: "첫 주장", quote: "We introduce K-MetBench" },
          { index: 3, text: "둘째 주장", quote: "We evaluate on KMMLU" },
        ],
        hypotheses: [{ claimIndex: 3, text: "가설", quote: "" }],
      },
      abstract
    );
    expect(result.claims.map(claim => claim.index)).toEqual([1, 2]);
    // The declared index maps to the first claim that used it.
    expect(result.hypotheses[0].claimIndex).toBe(1);
  });

  it("fills absent conditions with 명시 안 됨 rather than a blank", () => {
    // A blank baseline field reads as "no baselines were used", which the source did not
    // say. The explicit marker keeps the two apart.
    const result = validateAnalystExtraction(
      {
        claims: [{ index: 1, text: "주장", quote: "We introduce K-MetBench" }],
        verifications: [{ claimIndex: 1, datasets: "KMMLU", quote: "" }],
      },
      abstract
    );
    expect(result.verifications[0]).toMatchObject({
      datasets: "KMMLU",
      metrics: "명시 안 됨",
      baselines: "명시 안 됨",
      seeds: "명시 안 됨",
      scale: "명시 안 됨",
    });
  });

  it("returns empty structures rather than throwing on a response with nothing in it", () => {
    const result = validateAnalystExtraction({}, abstract);
    expect(result.claims).toEqual([]);
    expect(result.reproducibility).toMatchObject({
      codeAvailable: "없음",
      hyperparameters: "없음",
      status: "ABSENT",
    });
  });
});
