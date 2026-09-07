import { describe, expect, it } from "vitest";
import {
  buildQuerySuggestions,
  citationsPerYear,
  rankCandidates,
  resolvePreprint,
  resolveVenue,
  sourceMatchesVenue,
  toCandidateDraft,
  TOP_TIER_VENUES,
  validateSeedSelectionCount,
} from "./seedService";

const venue = (code: string) => {
  const found = TOP_TIER_VENUES.find(entry => entry.code === code);
  if (!found) throw new Error(`unknown venue ${code}`);
  return found;
};

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

/**
 * The allowlist used to shrink in silence. OpenAlex names NeurIPS "Neural Information
 * Processing Systems" and AAAI "Proceedings of the AAAI Conference on Artificial
 * Intelligence"; the old exact-equality check matched neither, so the corpus lost its two
 * largest venues while every search still reported success.
 */
describe("venue source verification", () => {
  it("matches the names OpenAlex actually publishes", () => {
    expect(
      sourceMatchesVenue(
        "Neural Information Processing Systems",
        venue("NeurIPS")
      )
    ).toBe(true);
    expect(
      sourceMatchesVenue(
        "Proceedings of the AAAI Conference on Artificial Intelligence",
        venue("AAAI")
      )
    ).toBe(true);
  });

  it("refuses a different conference whose name merely starts the same", () => {
    // A real OpenAlex row. A substring match would fold it into AAAI.
    expect(
      sourceMatchesVenue(
        "Proceedings of the AAAI Conference on Artificial Intelligence and Interactive Digital Entertainment",
        venue("AAAI")
      )
    ).toBe(false);
  });
});

describe("preprint candidates", () => {
  it("keeps a preprint that no allowlisted venue has published yet", () => {
    // OpenAlex stops populating the proceedings sources after 2021, so without this the
    // product cannot return anything newer than 2021 at all.
    const candidate = toCandidateDraft({
      id: "https://openalex.org/W999",
      title: "A very recent method",
      publication_year: 2026,
      cited_by_count: 0,
      primary_location: {
        source: { display_name: "arXiv (Cornell University)" },
      },
    });
    expect(candidate).toMatchObject({ venueCode: "PREPRINT", isPreprint: true });
    expect(resolvePreprint("arXiv (Cornell University)")?.code).toBe("PREPRINT");
    expect(resolveVenue("arXiv (Cornell University)")).toBeUndefined();
  });

  it("prefers the published venue when a work has both locations", () => {
    const candidate = toCandidateDraft({
      id: "https://openalex.org/W1000",
      title: "Published, and also on arXiv",
      publication_year: 2024,
      cited_by_count: 5,
      primary_location: {
        source: { display_name: "arXiv (Cornell University)" },
      },
      locations: [
        {
          source: { display_name: "International Conference on Machine Learning" },
        },
      ],
    });
    expect(candidate).toMatchObject({ venueCode: "ICML", isPreprint: false });
  });
});

/**
 * Raw `cited_by_count` orders by age, not quality: a 2018 paper has had eight years to
 * accumulate what a 2026 paper has had months for. Sorting on it meant no recent paper
 * could reach the top of the candidate list, which is the reported bug.
 */
describe("age-neutral candidate ranking", () => {
  const YEAR = 2026;
  const old2018 = { openAlexId: "W_old", year: 2018, citedByCount: 900 };
  const new2026 = { openAlexId: "W_new", year: 2026, citedByCount: 2 };
  const mid2023 = { openAlexId: "W_mid", year: 2023, citedByCount: 120 };
  const undated = { openAlexId: "W_nul", year: null, citedByCount: 50 };
  const pool = [old2018, new2026, mid2023, undated];

  it("divides citations by the years available to collect them", () => {
    expect(citationsPerYear(old2018, YEAR)).toBe(100);
    expect(citationsPerYear(new2026, YEAR)).toBe(2);
    expect(citationsPerYear(undated, YEAR)).toBe(0);
  });

  it("lifts a barely-cited recent paper that raw citation count buried", () => {
    const byCitations = [...pool].sort(
      (a, b) => b.citedByCount - a.citedByCount
    );
    expect(byCitations.at(-1)?.openAlexId).toBe("W_new");

    const balanced = rankCandidates(pool, "balanced", YEAR);
    expect(balanced.findIndex(item => item.openAlexId === "W_new")).toBeLessThan(
      pool.length / 2
    );
  });

  it("orders the explicit modes as named and sorts undated works last", () => {
    expect(rankCandidates(pool, "recent", YEAR)[0].openAlexId).toBe("W_new");
    expect(rankCandidates(pool, "recent", YEAR).at(-1)?.openAlexId).toBe(
      "W_nul"
    );
    expect(rankCandidates(pool, "impact", YEAR)[0].openAlexId).toBe("W_old");
  });

  it("is deterministic and leaves the input untouched", () => {
    const forward = rankCandidates(pool, "balanced", YEAR).map(x => x.openAlexId);
    const reversed = rankCandidates([...pool].reverse(), "balanced", YEAR).map(
      x => x.openAlexId
    );
    expect(forward).toEqual(reversed);
    expect(pool[0].openAlexId).toBe("W_old");
  });
});
