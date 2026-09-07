/**
 * arXiv lookup for seed candidates.
 *
 * Why this exists: OpenAlex stopped populating conference proceedings after 2021, so most
 * recent candidates arrive as preprints whose canonical copy lives on arXiv. Their DOI is
 * a `10.48550/arxiv.<id>` stub that resolves to a landing page, and the note the user then
 * fills in has no author list, no direct PDF and no stable arXiv identifier — all of which
 * arXiv publishes for free.
 *
 * The response is Atom XML. It is parsed here by hand rather than with a dependency: the
 * feed is small and fixed-shape, and adding a package would mean regenerating
 * pnpm-lock.yaml, which is a heavier change than this warrants.
 */

const ARXIV_ENDPOINT = "http://export.arxiv.org/api/query";

/** arXiv asks for one request every three seconds; batching keeps us to one per export. */
export const ARXIV_MAX_BATCH = 100;

export type ArxivRecord = {
  /** Versionless arXiv id, e.g. "2308.09687". */
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  /** First submission date, ISO 8601. */
  published: string | null;
  /** Latest revision date, ISO 8601. Differs from `published` for revised papers. */
  updated: string | null;
  absUrl: string;
  pdfUrl: string;
};

/** What `extractArxivId` will accept: anything a candidate row carries. */
export type ArxivIdentifiable = {
  doi?: string | null;
  sourceUrl?: string | null;
  openAlexId?: string | null;
};

/**
 * arXiv ids come in two eras: the current "2308.09687" form and the pre-2007
 * "cs/0112017" / "math.GT/0309136" form. Both still appear in OpenAlex, so both are
 * matched. A trailing "v3" is dropped — the note should point at the paper, not at one
 * revision of it, and the abs/pdf URLs resolve to the latest version without it.
 */
const MODERN_ID = /(\d{4}\.\d{4,5})(?:v\d+)?/i;
const LEGACY_ID = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i;

function matchArxivId(value: string): string | null {
  const modern = value.match(MODERN_ID);
  if (modern) return modern[1];
  const legacy = value.match(LEGACY_ID);
  return legacy ? legacy[1] : null;
}

/**
 * Pull an arXiv id out of whatever identifiers a candidate has.
 *
 * Only fields that genuinely denote arXiv are consulted. A bare number sequence in an
 * unrelated DOI must not be read as an arXiv id, so the value has to mention arxiv first.
 */
export function extractArxivId(
  candidate: ArxivIdentifiable
): string | null {
  for (const raw of [candidate.doi, candidate.sourceUrl, candidate.openAlexId]) {
    if (!raw) continue;
    const value = raw.trim();
    if (!/arxiv/i.test(value)) continue;
    const found = matchArxivId(value);
    if (found) return found;
  }
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // Ampersand last: decoding it first would let "&amp;lt;" collapse into "<".
    .replace(/&amp;/g, "&");
}

/** Collapse the newlines arXiv wraps titles and abstracts at. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tagContent(entry: string, tag: string): string | null {
  const match = entry.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")
  );
  return match ? decodeXmlEntities(match[1]) : null;
}

/**
 * Split the feed into `<entry>` blocks and read the fields we use.
 *
 * arXiv returns an entry with the title "Error" when an id does not exist, rather than
 * omitting it or failing the request. Such entries carry no `<id>` of the usual shape, so
 * they fall out when the id cannot be matched.
 */
export function parseArxivFeed(xml: string): ArxivRecord[] {
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi));
  const records: ArxivRecord[] = [];
  for (const [, entry] of entries) {
    const idUrl = tagContent(entry, "id");
    const arxivId = idUrl ? matchArxivId(idUrl) : null;
    if (!arxivId) continue;
    const title = collapseWhitespace(tagContent(entry, "title") ?? "");
    if (!title || title.toLowerCase() === "error") continue;
    const authors = Array.from(
      entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)
    ).map(([, name]) => collapseWhitespace(decodeXmlEntities(name)));
    records.push({
      arxivId,
      title,
      abstract: collapseWhitespace(tagContent(entry, "summary") ?? ""),
      authors,
      published: tagContent(entry, "published")?.trim() ?? null,
      updated: tagContent(entry, "updated")?.trim() ?? null,
      absUrl: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
    });
  }
  return records;
}

/**
 * Fetch metadata for up to `ARXIV_MAX_BATCH` ids in one request.
 *
 * Returns a map keyed by arXiv id. Ids arXiv does not know are simply absent from the map:
 * a missing preprint must degrade to "no extra metadata", never to a failed export.
 */
export async function fetchArxivRecords(
  arxivIds: string[]
): Promise<Map<string, ArxivRecord>> {
  const unique = Array.from(new Set(arxivIds.filter(Boolean)));
  const found = new Map<string, ArxivRecord>();
  for (let index = 0; index < unique.length; index += ARXIV_MAX_BATCH) {
    const batch = unique.slice(index, index + ARXIV_MAX_BATCH);
    const url = new URL(ARXIV_ENDPOINT);
    url.searchParams.set("id_list", batch.join(","));
    url.searchParams.set("max_results", String(batch.length));
    const response = await fetch(url, {
      headers: { Accept: "application/atom+xml", "User-Agent": "AX-Research/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`arXiv 요청 실패: HTTP ${response.status}`);
    for (const record of parseArxivFeed(await response.text()))
      found.set(record.arxivId, record);
  }
  return found;
}

/**
 * Best-effort enrichment: never let a metadata lookup break the flow that needs it.
 *
 * The export it feeds is the user's way out of the product, so a arXiv outage must cost
 * the author list, not the notes.
 */
export async function fetchArxivRecordsSafely(
  arxivIds: string[]
): Promise<Map<string, ArxivRecord>> {
  if (arxivIds.length === 0) return new Map();
  try {
    return await fetchArxivRecords(arxivIds);
  } catch (error) {
    console.warn("[arXiv] enrichment skipped", {
      error: error instanceof Error ? error.message : "unknown",
      count: arxivIds.length,
    });
    return new Map();
  }
}
