/**
 * Full text for a digest, and the part of it worth reading.
 *
 * The digest previously saw only the abstract — about 1% of a paper — so the fields the
 * analyst schema cares most about (seeds, baselines, acknowledged limitations) were
 * honestly but uselessly empty. Those live in specific sections, and a paper's own
 * headings say which.
 *
 * Sending the whole paper instead would work and would be wasteful: a 49-page survey is
 * ~60k tokens, most of it related work and appendices that answer none of the schema.
 * Selecting by heading keeps the cost near the abstract's while reaching the sections
 * that actually carry the answers.
 *
 * arXiv serves LaTeX-derived HTML for papers since late 2023, which keeps the heading
 * structure intact — better than PDF text extraction, and with no parser dependency.
 * Older papers have no HTML, so callers fall back to the abstract.
 */

const HTML_BASE = "https://arxiv.org/html";

export type PaperSection = {
  /** Heading as printed, e.g. "4.1 Experimental Setup". */
  heading: string;
  body: string;
  /** 2 for a section, 3 for a subsection. */
  level: 2 | 3;
  /**
   * The enclosing section's heading, recorded at split time.
   *
   * A section heading followed immediately by its first subsection has no body of its own
   * and so does not survive as a section — taking its name, and with it the only signal
   * that "2.1 Benchmarks" is part of Related Work, out of reach of any later pass.
   */
  parent: string | null;
};

/**
 * What each schema field needs, as heading patterns.
 *
 * Ordered by how much the schema depends on them: a paper that has to be truncated should
 * lose related work before it loses its limitations section.
 */
const SECTION_PRIORITIES: Array<{ label: string; pattern: RegExp }> = [
  { label: "limitations", pattern: /limitation|threat[s]? to validity/i },
  {
    label: "reproducibility",
    pattern: /reproducib|code (and|&) data|availability|ethics statement/i,
  },
  {
    label: "experiments",
    pattern: /experiment|evaluation|setup|implementation detail/i,
  },
  { label: "results", pattern: /result|finding|analysis|ablation/i },
  { label: "discussion", pattern: /discussion|future work|conclusion/i },
  { label: "introduction", pattern: /introduction|overview/i },
];

/** Never worth the budget: they describe other people's work, not this paper's claims. */
const EXCLUDED =
  /related work|background|acknowledg|references|bibliography|appendix/i;

function stripTags(html: string) {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      // Figures and tables survive as unreadable token soup and answer nothing the schema asks.
      .replace(/<figure[\s\S]*?<\/figure>/gi, " ")
      .replace(/<math[\s\S]*?<\/math>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x?\d+;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Splits arXiv's HTML into sections at its heading tags.
 *
 * The `ltx_title_section` classes come from the LaTeX converter and carry the paper's own
 * numbering, so a section can be named back to the reader exactly as the paper prints it —
 * which is what the schema's `sourceSection` field is for.
 */
export function splitArxivHtml(html: string): PaperSection[] {
  const headingPattern =
    /<h[23][^>]*class="[^"]*ltx_title_(?:section|subsection)[^"]*"[^>]*>([\s\S]*?)<\/h[23]>/gi;
  const sections: PaperSection[] = [];
  const matches = Array.from(html.matchAll(headingPattern));
  let parent: string | null = null;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? html.length;
    const heading = stripTags(match[1]);
    const body = stripTags(html.slice(start, end));
    const level = /^<h3/i.test(match[0]) ? 3 : 2;
    if (level === 2) parent = heading;
    // Recorded before the empty-body check, so a bodiless section still names its children.
    if (heading && body)
      sections.push({
        heading,
        body,
        level,
        parent: level === 3 ? parent : null,
      });
  }
  return sections;
}

/**
 * Smallest fragment worth keeping when a section has to be cut.
 *
 * Truncation is only useful while the remainder can still hold a statement someone would
 * quote. A hundred characters of an introduction is not a shorter section, it is noise
 * that can still be cited — so below this the section is omitted and named instead.
 */
const MIN_USEFUL_FRAGMENT = 1_000;

export type SelectionResult = {
  sections: PaperSection[];
  /** Sections dropped for budget, named so the reader knows what was not consulted. */
  omitted: string[];
  characters: number;
};

/**
 * Picks the sections the schema can actually be answered from, within a character budget.
 *
 * A section is truncated rather than dropped when it does not fit whole: half of a
 * limitations section still names a limitation, while dropping it entirely turns a paper
 * that states its limits into one that appears not to.
 */
export function selectRelevantSections(
  sections: readonly PaperSection[],
  budget = 60_000
): SelectionResult {
  // Exclusion is inherited. "Related Work" is excluded by name, but "2.1 Benchmarks for
  // Large Language Models" is not — and it is still related work. Without this an appendix
  // subsection can be the largest thing in the budget, as one was.
  const candidates = sections.filter(
    section =>
      !EXCLUDED.test(section.heading) &&
      !(section.parent && EXCLUDED.test(section.parent))
  );

  const scored = candidates.map(section => {
    const rank = SECTION_PRIORITIES.findIndex(priority =>
      priority.pattern.test(section.heading)
    );
    return { section, rank: rank === -1 ? SECTION_PRIORITIES.length : rank };
  });
  // Stable within a rank, so a paper's own ordering survives among equals.
  scored.sort((a, b) => a.rank - b.rank);

  const chosen: PaperSection[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const { section } of scored) {
    const remaining = budget - used;
    const fits = section.body.length <= remaining;
    if (!fits && remaining < MIN_USEFUL_FRAGMENT) {
      omitted.push(section.heading);
      continue;
    }
    const body = fits ? section.body : `${section.body.slice(0, remaining)}…`;
    chosen.push({ ...section, body });
    used += body.length;
  }

  // Restore the paper's own order for reading; priority decided inclusion, not sequence.
  const order = new Map(
    candidates.map((section, index) => [section.heading, index])
  );
  chosen.sort(
    (a, b) => (order.get(a.heading) ?? 0) - (order.get(b.heading) ?? 0)
  );
  return { sections: chosen, omitted, characters: used };
}

/** The selected sections as one document, each span attributable to a named section. */
export function renderSections(sections: readonly PaperSection[]): string {
  return sections
    .map(section => `## ${section.heading}\n${section.body}`)
    .join("\n\n");
}

export type FullTextResult =
  | {
      kind: "arxiv_html";
      text: string;
      sections: PaperSection[];
      omitted: string[];
    }
  | { kind: "unavailable"; reason: string };

/**
 * Fetches a paper's full text, or says why it could not.
 *
 * Absence is normal: arXiv only renders HTML for papers submitted since late 2023, and a
 * caller is expected to fall back to the abstract rather than treat this as an error.
 */
export async function fetchArxivFullText(
  arxivId: string,
  budget = 60_000
): Promise<FullTextResult> {
  let html: string;
  try {
    const response = await fetch(
      `${HTML_BASE}/${encodeURIComponent(arxivId)}`,
      {
        headers: { accept: "text/html" },
        redirect: "follow",
      }
    );
    if (!response.ok)
      return {
        kind: "unavailable",
        reason:
          response.status === 404
            ? "arXiv에 HTML 전문이 없는 논문입니다 (2023년 말 이전 제출)."
            : `arXiv HTML 조회 실패 (HTTP ${response.status})`,
      };
    html = await response.text();
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "arXiv 연결 실패",
    };
  }

  const sections = splitArxivHtml(html);
  if (sections.length === 0)
    return { kind: "unavailable", reason: "HTML에서 섹션을 찾지 못했습니다." };

  const selected = selectRelevantSections(sections, budget);
  return {
    kind: "arxiv_html",
    text: renderSections(selected.sections),
    sections: selected.sections,
    omitted: selected.omitted,
  };
}
