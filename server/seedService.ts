export type VenueDefinition = {
  code: string;
  label: string;
  aliases: string[];
};

export const TOP_TIER_VENUES: VenueDefinition[] = [
  { code: "NeurIPS", label: "Conference on Neural Information Processing Systems", aliases: ["NeurIPS", "NIPS", "Advances in Neural Information Processing Systems"] },
  { code: "ICML", label: "International Conference on Machine Learning", aliases: ["ICML", "International Conference on Machine Learning"] },
  { code: "ICLR", label: "International Conference on Learning Representations", aliases: ["ICLR", "International Conference on Learning Representations"] },
  { code: "AISTATS", label: "International Conference on Artificial Intelligence and Statistics", aliases: ["AISTATS", "International Conference on Artificial Intelligence and Statistics"] },
  { code: "UAI", label: "Conference on Uncertainty in Artificial Intelligence", aliases: ["UAI", "Conference on Uncertainty in Artificial Intelligence", "Uncertainty in Artificial Intelligence"] },
  { code: "KDD", label: "Knowledge Discovery and Data Mining", aliases: ["KDD", "ACM SIGKDD Conference on Knowledge Discovery and Data Mining", "Knowledge Discovery and Data Mining"] },
  { code: "AAAI", label: "AAAI Conference on Artificial Intelligence", aliases: ["AAAI", "AAAI Conference on Artificial Intelligence"] },
];

type OpenAlexSource = { id?: string | null; display_name?: string | null };
type OpenAlexLocation = { landing_page_url?: string | null; source?: OpenAlexSource | null };
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
};

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function resolveVenue(rawVenue: string | null | undefined): VenueDefinition | undefined {
  if (!rawVenue) return undefined;
  const normalizedVenue = normalizeText(rawVenue);
  return TOP_TIER_VENUES.find(venue => venue.aliases.some(alias => {
    const normalizedAlias = normalizeText(alias);
    return normalizedVenue === normalizedAlias || normalizedVenue.includes(normalizedAlias);
  }));
}

function sourceMatchesVenue(sourceName: string | null | undefined, venue: VenueDefinition): boolean {
  if (!sourceName) return false;
  const normalizedSource = normalizeText(sourceName);
  return venue.aliases.some(alias => normalizedSource === normalizeText(alias));
}

let topTierSourceIdsPromise: Promise<string[]> | undefined;

async function getTopTierSourceIds(): Promise<string[]> {
  if (topTierSourceIdsPromise) return topTierSourceIdsPromise;
  topTierSourceIdsPromise = Promise.all(TOP_TIER_VENUES.map(async venue => {
    const url = new URL("https://api.openalex.org/sources");
    url.searchParams.set("search", venue.label);
    url.searchParams.set("per_page", "25");
    url.searchParams.set("select", "id,display_name");
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`OpenAlex venue 확인 실패: HTTP ${response.status}`);
    const payload = await response.json() as { results?: OpenAlexSource[] };
    return (payload.results ?? []).find(source => sourceMatchesVenue(source.display_name, venue))?.id ?? null;
  })).then(ids => {
    const verifiedIds = ids.filter((id): id is string => Boolean(id));
    if (verifiedIds.length === 0) throw new Error("OpenAlex에서 allowlist venue source를 확인하지 못했습니다.");
    return verifiedIds;
  }).catch(error => {
    topTierSourceIdsPromise = undefined;
    throw error;
  });
  return topTierSourceIdsPromise;
}

export function buildQuerySuggestions(topic: string): string[] {
  const cleaned = topic.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
  const proposals = [cleaned, `adaptive ${cleaned}`, `sequential ${cleaned}`, `${cleaned} forecasting`, `${cleaned} distribution shift`];
  return Array.from(new Set(proposals.map(item => item.trim()).filter(Boolean))).slice(0, 5);
}

export function validateSeedSelectionCount(selectedCount: number, desiredSeedCount: number): string | undefined {
  if (desiredSeedCount < 5 || desiredSeedCount > 10) return "Seed 목표 수는 반드시 5–10편 범위여야 합니다.";
  if (selectedCount < 5 || selectedCount > 10) return "Seed는 반드시 5–10편 범위여야 합니다.";
  if (selectedCount !== desiredSeedCount) return `설정한 seed 목표 수(${desiredSeedCount}편)와 선택 수가 일치해야 합니다.`;
  return undefined;
}

export function toCandidateDraft(work: OpenAlexWork): CandidateDraft | undefined {
  const locations = [work.primary_location, ...(work.locations ?? [])].filter(Boolean) as OpenAlexLocation[];
  const venueLocation = locations.find(location => Boolean(resolveVenue(location.source?.display_name)));
  const venueName = venueLocation?.source?.display_name ?? null;
  const venue = resolveVenue(venueName);
  const title = work.title ?? work.display_name;
  if (!venue || !title || !work.id) return undefined;
  const canonicalDoi = work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") ?? null;
  const landingPage = locations.map(location => location.landing_page_url).find(Boolean);
  return {
    openAlexId: work.id, doi: canonicalDoi, title, venue: venueName ?? venue.label, venueCode: venue.code,
    year: work.publication_year ?? null, citedByCount: work.cited_by_count ?? 0, sourceUrl: work.doi ?? landingPage ?? work.id,
  };
}

export async function searchOpenAlex(query: string): Promise<OpenAlexWork[]> {
  const sourceIds = await getTopTierSourceIds();
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("filter", `locations.source.id:${sourceIds.join("|")}`);
  url.searchParams.set("select", "id,doi,title,display_name,publication_year,cited_by_count,primary_location,locations");
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenAlex 요청 실패: HTTP ${response.status}`);
  const payload = await response.json() as { results?: OpenAlexWork[] };
  return payload.results ?? [];
}
