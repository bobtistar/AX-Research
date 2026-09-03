import { getResearchRun, type RunOwner } from "./db";

export const SEED_EXPORT_VERSION = "seed-note-v1";

export type SeedCandidate = {
  title: string;
  doi: string | null;
  openAlexId: string;
  venue: string;
  venueCode: string;
  year: number | null;
  citedByCount: number;
  sourceUrl: string;
  provenance: string[];
};

/**
 * Section headings the Markdown parser recognises, emitted empty. The export carries
 * verified bibliographic metadata only: writing anything into these sections would create
 * paper content that no source supports, which the note model treats as author evidence.
 */
const SECTION_HEADINGS = [
  "주장",
  "세팅",
  "저자 명시",
  "리뷰어 지적",
  "재현 정보",
  "내가 본 것",
  "내 맥락",
] as const;

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Obsidian-safe file name: no path separators, no characters Windows or macOS reject. */
export function toSeedFileName(candidate: SeedCandidate): string {
  const base = candidate.title
    .replace(/[\/\\:*?"<>|#^\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  const year = candidate.year ? ` (${candidate.year})` : "";
  return `${base || "Untitled seed"}${year}.md`;
}

/**
 * Builds one Obsidian note per locked seed. The vault stays the canonical source: the web
 * app hands the user a file to drop in, and never writes back into it.
 */
export function buildSeedNoteMarkdown(
  candidate: SeedCandidate,
  context: { topic: string; exportedAt: Date }
): string {
  const identifier = candidate.doi ?? candidate.openAlexId;
  const frontmatter = [
    "---",
    `id: ${quoteYaml(identifier)}`,
    `title: ${quoteYaml(candidate.title)}`,
    `venue: ${quoteYaml(candidate.venue)}`,
    `venue_code: ${candidate.venueCode}`,
    candidate.year === null ? null : `year: ${candidate.year}`,
    candidate.doi ? `doi: ${quoteYaml(candidate.doi)}` : null,
    `openalex: ${quoteYaml(candidate.openAlexId)}`,
    `url: ${quoteYaml(candidate.sourceUrl)}`,
    `cited_by: ${candidate.citedByCount}`,
    `seed_topic: ${quoteYaml(context.topic)}`,
    `exported_at: ${quoteYaml(context.exportedAt.toISOString())}`,
    `export_version: ${SEED_EXPORT_VERSION}`,
    "queries:",
    ...candidate.provenance.map(query => `  - ${quoteYaml(query)}`),
    "---",
    "",
  ].filter((line): line is string => line !== null);

  // Empty sections are intentional: they parse as "이 노트에 아직 없음", not as "논문에 없음".
  const body = SECTION_HEADINGS.flatMap(heading => [`## ${heading}`, ""]);

  return [...frontmatter, ...body].join("\n");
}

export async function exportSeedNotes(owner: RunOwner, runId: string) {
  const run = await getResearchRun(owner, runId);
  if (!run) throw new Error("실행 이력을 찾을 수 없습니다.");
  if (run.status !== "SEEDS_LOCKED")
    throw new Error("Seed를 고정한 뒤에 노트를 내보낼 수 있습니다.");

  const seeds = run.candidates.filter(candidate => candidate.isSeed);
  if (!seeds.length) throw new Error("고정된 seed가 없습니다.");

  const exportedAt = new Date();
  const files = seeds.map(seed => ({
    fileName: toSeedFileName(seed),
    content: buildSeedNoteMarkdown(seed, { topic: run.topic, exportedAt }),
  }));
  return {
    runId: run.id,
    topic: run.topic,
    exportVersion: SEED_EXPORT_VERSION,
    files,
  };
}
