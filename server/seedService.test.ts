import { describe, expect, it } from "vitest";
import {
  buildQuerySuggestions,
  resolveVenue,
  toCandidateDraft,
  validateSeedSelectionCount,
} from "./seedService";

describe("seed query and venue verification", () => {
  it("creates exactly five distinct, editable query proposals", () => {
    const queries = buildQuerySuggestions("time series conformal prediction");
    expect(queries).toHaveLength(5);
    expect(new Set(queries).size).toBe(5);
    expect(queries[0]).toBe("time series conformal prediction");
  });

  it("matches a known NeurIPS venue and rejects an unlisted venue", () => {
    expect(
      resolveVenue("Advances in Neural Information Processing Systems")?.code
    ).toBe("NeurIPS");
    expect(resolveVenue("Journal of Forecasting")).toBeUndefined();
    expect(resolveVenue("Machine Learning")).toBeUndefined();
  });

  it("preserves DOI, venue, year and canonical paper URL for an eligible work", () => {
    const candidate = toCandidateDraft({
      id: "https://openalex.org/W123",
      doi: "https://doi.org/10.1000/example",
      title: "A conformal method",
      publication_year: 2024,
      cited_by_count: 18,
      primary_location: {
        landing_page_url: "https://example.org",
        source: { display_name: "ICLR" },
      },
    });
    expect(candidate).toMatchObject({
      doi: "10.1000/example",
      venueCode: "ICLR",
      year: 2024,
      citedByCount: 18,
    });
  });

  it("accepts only an exact 5–10 seed target", () => {
    expect(validateSeedSelectionCount(5, 5)).toBeUndefined();
    expect(validateSeedSelectionCount(4, 5)).toContain("5–10편");
    expect(validateSeedSelectionCount(6, 5)).toContain("일치");
    expect(validateSeedSelectionCount(11, 11)).toContain("목표 수");
  });
});
