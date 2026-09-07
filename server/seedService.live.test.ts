import { describe, expect, it } from "vitest";
import {
  buildQuerySuggestions,
  searchOpenAlex,
  toCandidateDraft,
} from "./seedService";

const runLive = process.env.RUN_LIVE_API === "1";

describe.runIf(runLive)("OpenAlex live seed sample", () => {
  it("retrieves top-tier candidates for the default research topic", async () => {
    const queries = buildQuerySuggestions("time series conformal prediction");
    const worksByQuery = [];
    for (const query of queries) {
      worksByQuery.push(await searchOpenAlex(query));
    }
    const works = worksByQuery.flat();
    const byPaper = new Map<
      string,
      NonNullable<ReturnType<typeof toCandidateDraft>>
    >();
    for (const work of works) {
      const candidate = toCandidateDraft(work);
      if (candidate)
        byPaper.set(candidate.doi ?? candidate.openAlexId, candidate);
    }
    const candidates = Array.from(byPaper.values());

    console.info(
      JSON.stringify(
        {
          queries,
          retrieved: works.length,
          eligible: candidates.length,
          sample: candidates.map(candidate => ({
            title: candidate.title,
            doi: candidate.doi,
            venue: candidate.venueCode,
            year: candidate.year,
          })),
        },
        null,
        2
      )
    );

    expect(works.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(
      candidates
        .slice(0, 2)
        .every(candidate => Boolean(candidate.sourceUrl && candidate.venueCode))
    ).toBe(true);
    // Every candidate now carries a venue tier, and recent work must actually appear:
    // the retrieval this replaces could not return anything published after 2021.
    expect(
      candidates.some(candidate => (candidate.year ?? 0) >= 2022)
    ).toBe(true);
    // Two requests per query since the preprint tier was added, so five queries is ten
    // round trips to OpenAlex.
  }, 90_000);
});
