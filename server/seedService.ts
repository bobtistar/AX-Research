/**
 * OpenAlex asks API users to identify themselves; requests that do are routed to the polite
 * pool, which is faster and far less likely to be throttled.
 * https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 */
const OPENALEX_CONTACT = process.env.OPENALEX_MAILTO?.trim() ?? "";

// Configured rather than hard-coded: a checked-in address is published with the source,
// and every deployment of this code would then identify itself as one person.
const OPENALEX_HEADERS = {
  Accept: "application/json",
  "User-Agent": OPENALEX_CONTACT
    ? `AX-Research/1.0 (mailto:${OPENALEX_CONTACT})`
    : "AX-Research/1.0",
};

export type VenueDefinition = {
  code: string;
  label: string;
  /**
   * Every name OpenAlex is known to use for this venue. Used for two different jobs, which
   * is why the list must stay generous: `/sources?search=` queries are built from it, and a
   * returned `display_name` is matched against it.
   *
   * The names here were read off the live API, not guessed. OpenAlex calls NeurIPS
   * "Neural Information Processing Systems" (no "Conference on") and AAAI "Proceedings of
   * the AAAI Conference on Artificial Intelligence" — searching for the label alone
   * returned zero rows for NeurIPS and no exact match for AAAI, so both venues silently
   * dropped out of the allowlist. See `resolveVenueSourceIds` for why that was invisible.
   */
  aliases: string[];
};

export const TOP_TIER_VENUES: VenueDefinition[] = [
  {
    code: "NeurIPS",
    label: "Conference on Neural Information Processing Systems",
    aliases: [
      "Neural Information Processing Systems",
      "Advances in Neural Information Processing Systems",
      "Conference on Neural Information Processing Systems",
      "NeurIPS",
      "NIPS",
    ],
  },
  {
    code: "ICML",
    label: "International Conference on Machine Learning",
    aliases: [
      "International Conference on Machine Learning",
      "Proceedings of the International Conference on Machine Learning",
      "ICML",
    ],
  },
  {
    code: "ICLR",
    label: "International Conference on Learning Representations",
    aliases: [
      "International Conference on Learning Representations",
      "ICLR",
    ],
  },
  {
    code: "AISTATS",
    label: "International Conference on Artificial Intelligence and Statistics",
    aliases: [
      "International Conference on Artificial Intelligence and Statistics",
      "AISTATS",
    ],
  },
  {
    code: "UAI",
    label: "Conference on Uncertainty in Artificial Intelligence",
    aliases: [
      "Conference on Uncertainty in Artificial Intelligence",
      "Uncertainty in Artificial Intelligence",
      "UAI",
    ],
  },
  {
    code: "KDD",
    label: "Knowledge Discovery and Data Mining",
    aliases: [
      "ACM SIGKDD Conference on Knowledge Discovery and Data Mining",
      "Knowledge Discovery and Data Mining",
      "KDD",
    ],
  },
  {
    code: "AAAI",
    label: "AAAI Conference on Artificial Intelligence",
    aliases: [
      "Proceedings of the AAAI Conference on Artificial Intelligence",
      "AAAI Conference on Artificial Intelligence",
      "AAAI",
    ],
  },
];

/**
 * Where recent top-tier work actually lives.
 *
 * OpenAlex stopped populating the conference proceedings sources after 2021 — measured on
 * the live API, ICML goes 591 works in 2021 to 8 in 2022 and 3 in 2025, ICLR 320 to 2.
 * Papers from 2022 onward are indexed under arXiv instead, with no proceedings location
 * attached. Filtering on proceedings source ids alone therefore caps the whole product at
 * pre-2022, which is the reported bug: a 2026 search returned 91% pre-2021 papers.
 *
 * So preprints are retrieved as a second tier and labelled, never silently mixed in.
 */
export const PREPRINT_VENUE: VenueDefinition = {
  code: "PREPRINT",
  label: "arXiv (preprint)",
  aliases: ["arXiv (Cornell University)", "arXiv", "arxiv"],
};

type OpenAlexSource = { id?: string | null; display_name?: string | null };
type OpenAlexLocation = {
  landing_page_url?: string | null;
  source?: OpenAlexSource | null;
};
export type OpenAlexWork = {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  primary_location?: OpenAlexLocation | null;
  locations?: OpenAlexLocation[] | null;
};

export type CandidateDraft = {
  openAlexId: string;
  doi: string | null;
  title: string;
  venue: string;
  venueCode: string;
  year: number | null;
  citedByCount: number;
  sourceUrl: string;
  /**
   * True when no allowlisted venue was attached and the arXiv copy is standing in. Carried
   * in `venueCode` as well ("PREPRINT"), so it survives the round trip through
   * `paper_candidates` without a schema change.
   */
  isPreprint: boolean;
};

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function resolveVenue(
  rawVenue: string | null | undefined
): VenueDefinition | undefined {
  if (!rawVenue) return undefined;
  const normalizedVenue = normalizeText(rawVenue);
  return TOP_TIER_VENUES.find(venue =>
    venue.aliases.some(alias => {
      const normalizedAlias = normalizeText(alias);
      return (
        normalizedVenue === normalizedAlias ||
        normalizedVenue.includes(normalizedAlias)
      );
    })
  );
}

/**
 * Wrappers OpenAlex puts around a venue name. Stripped before comparing so that
 * "Proceedings of the AAAI Conference on Artificial Intelligence" can match the alias
 * "AAAI Conference on Artificial Intelligence" without loosening the comparison itself.
 */
const SOURCE_NAME_PREFIXES = [
  "proceedings of the",
  "proceedings of",
  "proceedings",
  "the",
];

function stripSourceWrapper(normalized: string): string {
  for (const prefix of SOURCE_NAME_PREFIXES) {
    if (normalized.startsWith(`${prefix} `))
      return normalized.slice(prefix.length + 1);
  }
  return normalized;
}

/**
 * Does this `/sources` row really name this venue?
 *
 * Deliberately stricter than `resolveVenue`: this decides which source ids the allowlist
 * filter is built from, and one wrong id silently widens the whole corpus. OpenAlex really
 * does list "Proceedings of the AAAI Conference on Artificial Intelligence **and
 * Interactive Digital Entertainment**" — a different conference — so a substring match
 * would fold it into AAAI. Equality after wrapper-stripping accepts the real name and
 * rejects that one.
 */
export function sourceMatchesVenue(
  sourceName: string | null | undefined,
  venue: VenueDefinition
): boolean {
  if (!sourceName) return false;
  const normalizedSource = stripSourceWrapper(normalizeText(sourceName));
  return venue.aliases.some(
    alias => normalizedSource === stripSourceWrapper(normalizeText(alias))
  );
}

export type VenueResolution = {
  /** Every confirmed source id, published venues and preprint servers together. */
  sourceIds: string[];
  /** The subset belonging to preprint servers, kept apart so the tiers can be queried separately. */
  preprintSourceIds: string[];
  /** Venue codes that resolved to at least one source id. */
  resolved: string[];
  /** Venue codes no source could be confirmed for — reported, never silently dropped. */
  unresolved: string[];
};

async function findSourceIdsForVenue(
  venue: VenueDefinition
): Promise<string[]> {
  const found = new Set<string>();
  // Every alias is tried, not just the label: searching OpenAlex for the label
  // "Conference on Neural Information Processing Systems" returns zero rows, while
  // "Neural Information Processing Systems" returns the venue with 4160 works.
  for (const alias of venue.aliases) {
    const url = new URL("https://api.openalex.org/sources");
    url.searchParams.set("search", alias);
    url.searchParams.set("per_page", "25");
    url.searchParams.set("select", "id,display_name");
    if (OPENALEX_CONTACT) url.searchParams.set("mailto", OPENALEX_CONTACT);
    const response = await fetch(url, {
      headers: OPENALEX_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`OpenAlex venue 확인 실패: HTTP ${response.status}`);
    const payload = (await response.json()) as { results?: OpenAlexSource[] };
    for (const source of payload.results ?? []) {
      if (source.id && sourceMatchesVenue(source.display_name, venue))
        found.add(source.id);
    }
    if (found.size > 0) break;
  }
  return Array.from(found);
}

let venueResolutionPromise: Promise<VenueResolution> | undefined;

/**
 * Resolve the allowlist to OpenAlex source ids, reporting what failed.
 *
 * The previous version returned a bare id list and only threw when *every* venue failed,
 * so a run that resolved 2 of 7 venues looked identical to a healthy one. NeurIPS and AAAI
 * were both failing that way, which is the single largest reason searches looked thin.
 */
export async function resolveVenueSourceIds(): Promise<VenueResolution> {
  if (venueResolutionPromise) return venueResolutionPromise;
  venueResolutionPromise = Promise.all(
    [...TOP_TIER_VENUES, PREPRINT_VENUE].map(async venue => ({
      venue,
      ids: await findSourceIdsForVenue(venue),
    }))
  )
    .then(entries => {
      const resolution: VenueResolution = {
        sourceIds: entries.flatMap(entry => entry.ids),
        preprintSourceIds: entries
          .filter(entry => entry.venue.code === PREPRINT_VENUE.code)
          .flatMap(entry => entry.ids),
        resolved: entries
          .filter(entry => entry.ids.length > 0)
          .map(entry => entry.venue.code),
        unresolved: entries
          .filter(entry => entry.ids.length === 0)
          .map(entry => entry.venue.code),
      };
      if (resolution.sourceIds.length === 0)
        throw new Error(
          "OpenAlex에서 allowlist venue source를 확인하지 못했습니다."
        );
      return resolution;
    })
    .catch(error => {
      venueResolutionPromise = undefined;
      throw error;
    });
  return venueResolutionPromise;
}

/** Test seam: drops the module-level cache so a test can re-resolve. */
export function resetVenueResolutionCache(): void {
  venueResolutionPromise = undefined;
}

export function buildQuerySuggestions(topic: string): string[] {
  const cleaned = topic
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!]+$/, "");
  const proposals = [
    cleaned,
    `adaptive ${cleaned}`,
    `sequential ${cleaned}`,
    `${cleaned} forecasting`,
    `${cleaned} distribution shift`,
  ];
  return Array.from(
    new Set(proposals.map(item => item.trim()).filter(Boolean))
  ).slice(0, 5);
}

export function validateSeedSelectionCount(
  selectedCount: number,
  desiredSeedCount: number
): string | undefined {
  if (desiredSeedCount < 5 || desiredSeedCount > 10)
    return "Seed 목표 수는 반드시 5–10편 범위여야 합니다.";
  if (selectedCount < 5 || selectedCount > 10)
    return "Seed는 반드시 5–10편 범위여야 합니다.";
  if (selectedCount !== desiredSeedCount)
    return `설정한 seed 목표 수(${desiredSeedCount}편)와 선택 수가 일치해야 합니다.`;
  return undefined;
}

export type CandidateRanking = "balanced" | "impact" | "recent";

export type RankableCandidate = {
  openAlexId: string;
  year: number | null;
  citedByCount: number;
};

/**
 * Citations divided by the years the paper has had to collect them.
 *
 * Raw `cited_by_count` is close to a measure of age: a 2018 paper has had eight years to
 * accumulate, a 2026 paper a few months. Sorting candidates by it — which is what this
 * product did — ordered them by age while appearing to order them by quality, and no
 * recent paper could reach the top of the list.
 */
export function citationsPerYear(
  candidate: RankableCandidate,
  currentYear: number
): number {
  if (candidate.year === null) return 0;
  const yearsElapsed = Math.max(1, currentYear - candidate.year + 1);
  return candidate.citedByCount / yearsElapsed;
}

/** Standard reciprocal-rank-fusion damping. Larger flattens the contribution of top ranks. */
const RRF_K = 60;

function orderBy<T>(items: T[], score: (item: T) => number): Map<T, number> {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  return new Map(sorted.map((item, index) => [item, index]));
}

/**
 * Order candidates without letting age masquerade as quality.
 *
 * `balanced` fuses two rankings — citations per year, and publication year — with
 * reciprocal rank fusion. Fusion rather than a weighted sum of the two values because the
 * scales are not comparable and a young paper's citation count is legitimately near zero:
 * any additive score would bury it, while its high recency rank still lifts it here.
 */
export function rankCandidates<T extends RankableCandidate>(
  candidates: T[],
  ranking: CandidateRanking = "balanced",
  currentYear: number = new Date().getFullYear()
): T[] {
  const impact = (candidate: T) => citationsPerYear(candidate, currentYear);
  // Undated works sort last rather than first: `null` must not read as year zero.
  const recency = (candidate: T) => candidate.year ?? Number.NEGATIVE_INFINITY;
  // Ties are broken on the OpenAlex id so the same result set always produces the same
  // order — a run that reorders between two identical searches is not reproducible.
  const stable = (a: T, b: T) => a.openAlexId.localeCompare(b.openAlexId);

  if (ranking === "impact")
    return [...candidates].sort(
      (a, b) => impact(b) - impact(a) || stable(a, b)
    );
  if (ranking === "recent")
    return [...candidates].sort(
      (a, b) => recency(b) - recency(a) || impact(b) - impact(a) || stable(a, b)
    );

  const impactRank = orderBy(candidates, impact);
  const recencyRank = orderBy(candidates, recency);
  const fused = (candidate: T) =>
    1 / (RRF_K + (impactRank.get(candidate) ?? 0)) +
    1 / (RRF_K + (recencyRank.get(candidate) ?? 0));
  return [...candidates].sort((a, b) => fused(b) - fused(a) || stable(a, b));
}

/** Is this location the arXiv (or equivalent) copy rather than a published venue? */
export function resolvePreprint(
  rawVenue: string | null | undefined
): VenueDefinition | undefined {
  if (!rawVenue) return undefined;
  const normalizedVenue = normalizeText(rawVenue);
  return PREPRINT_VENUE.aliases.some(alias =>
    normalizedVenue.includes(normalizeText(alias))
  )
    ? PREPRINT_VENUE
    : undefined;
}

export function toCandidateDraft(
  work: OpenAlexWork
): CandidateDraft | undefined {
  const locations = [work.primary_location, ...(work.locations ?? [])].filter(
    Boolean
  ) as OpenAlexLocation[];
  // A published venue always wins over the preprint copy: many works carry both an arXiv
  // location and the proceedings one, and calling such a paper a preprint would understate
  // it. Only when no allowlisted venue is attached does the arXiv copy stand in.
  const venueLocation = locations.find(location =>
    Boolean(resolveVenue(location.source?.display_name))
  );
  const preprintLocation = venueLocation
    ? undefined
    : locations.find(location =>
        Boolean(resolvePreprint(location.source?.display_name))
      );
  const chosenLocation = venueLocation ?? preprintLocation;
  const venueName = chosenLocation?.source?.display_name ?? null;
  const venue = venueLocation
    ? resolveVenue(venueName)
    : resolvePreprint(venueName);
  const title = work.title ?? work.display_name;
  if (!venue || !title || !work.id) return undefined;
  const canonicalDoi =
    work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") ?? null;
  const landingPage = locations
    .map(location => location.landing_page_url)
    .find(Boolean);
  return {
    openAlexId: work.id,
    doi: canonicalDoi,
    title,
    venue: venueName ?? venue.label,
    venueCode: venue.code,
    year: work.publication_year ?? null,
    citedByCount: work.cited_by_count ?? 0,
    sourceUrl: work.doi ?? landingPage ?? work.id,
    isPreprint: venue.code === PREPRINT_VENUE.code,
  };
}

const WORK_FIELDS =
  "id,doi,title,display_name,publication_year,cited_by_count,primary_location,locations";

/** How far back the preprint tier reaches when the caller does not say. */
export const DEFAULT_PREPRINT_YEARS = 3;

export type SearchOptions = {
  /**
   * Earliest publication year for the preprint tier. The venue tier is left unbounded:
   * a highly relevant 2019 NeurIPS paper is still a legitimate seed.
   */
  fromYear?: number;
  /** Works requested per tier. OpenAlex caps `per_page` at 200. */
  perPage?: number;
  /** Set false to search published venues only, as the original behaviour did. */
  includePreprints?: boolean;
};

async function fetchWorks(
  query: string,
  filter: string,
  perPage: number
): Promise<OpenAlexWork[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("filter", filter);
  url.searchParams.set("select", WORK_FIELDS);
  // Explicit rather than relying on the default. OpenAlex sorts a `search` by
  // relevance_score, which folds in cited_by_count and therefore leans old on its own.
  url.searchParams.set("sort", "relevance_score:desc");
  if (OPENALEX_CONTACT) url.searchParams.set("mailto", OPENALEX_CONTACT);
  const response = await fetch(url, {
    headers: OPENALEX_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`OpenAlex 요청 실패: HTTP ${response.status}`);
  const payload = (await response.json()) as { results?: OpenAlexWork[] };
  return payload.results ?? [];
}

/**
 * Retrieve candidates in two tiers and merge them.
 *
 * One filter over every source id would not work: arXiv holds 3.2M works and would swamp
 * the seven conference sources on relevance alone. Two bounded requests keep the mix
 * under our control — published venues over all time, preprints only from recent years.
 *
 * The tiers exist because OpenAlex's proceedings sources stop in 2021 (see PREPRINT_VENUE).
 * Without the second tier no paper newer than 2021 can be returned at all, which is the
 * behaviour this replaces.
 */
export async function searchOpenAlex(
  query: string,
  options: SearchOptions = {}
): Promise<OpenAlexWork[]> {
  const { includePreprints = true, perPage = 100 } = options;
  const fromYear =
    options.fromYear ?? new Date().getFullYear() - DEFAULT_PREPRINT_YEARS;
  const resolution = await resolveVenueSourceIds();

  const venueIds = resolution.sourceIds.filter(
    id => !resolution.preprintSourceIds.includes(id)
  );
  const requests: Array<Promise<OpenAlexWork[]>> = [];
  if (venueIds.length > 0)
    requests.push(
      fetchWorks(query, `locations.source.id:${venueIds.join("|")}`, perPage)
    );
  if (includePreprints && resolution.preprintSourceIds.length > 0)
    requests.push(
      fetchWorks(
        query,
        `locations.source.id:${resolution.preprintSourceIds.join("|")},from_publication_date:${fromYear}-01-01`,
        perPage
      )
    );

  const tiers = await Promise.all(requests);
  // Deduplicate here as well as in the caller: the same work can appear in both tiers when
  // a paper carries an arXiv location and a proceedings one.
  const byId = new Map<string, OpenAlexWork>();
  for (const works of tiers) {
    for (const work of works) {
      if (work.id && !byId.has(work.id)) byId.set(work.id, work);
    }
  }
  return Array.from(byId.values());
}
