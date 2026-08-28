import { createHash } from "node:crypto";

export const NOTE_PARSER_VERSION = "notes-v1";

export type NoteSectionType =
  | "FRONTMATTER"
  | "CLAIM"
  | "SETTING"
  | "AUTHOR_LIMITATIONS"
  | "REVIEWER_CRITICISMS"
  | "USER_OBSERVATIONS"
  | "USER_CONTEXT"
  | "REPRODUCIBILITY"
  | "UNKNOWN";

export type ParsedNoteSection = {
  rawHeading: string;
  sectionType: NoteSectionType;
  body: string;
  explicitEmpty: boolean;
  sectionOrder: number;
};

export type NoteLinkType = "WIKILINK" | "MARKDOWN_URL" | "IDENTIFIER";

export type ParsedNoteLink = {
  linkType: NoteLinkType;
  target: string;
  label: string | null;
  sourceLocator: string;
};

export type ParsedNote = {
  sourcePath: string;
  title: string;
  externalId: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  rawFrontmatter: string | null;
  sections: ParsedNoteSection[];
  links: ParsedNoteLink[];
  warnings: string[];
  sectionPresence: Record<NoteSectionType, boolean>;
  explicitEmptySections: NoteSectionType[];
};

const SECTION_ALIASES: Array<{ type: NoteSectionType; names: string[] }> = [
  { type: "CLAIM", names: ["주장", "claim", "claims"] },
  { type: "SETTING", names: ["세팅", "setting", "settings", "실험 세팅"] },
  { type: "AUTHOR_LIMITATIONS", names: ["저자가 인정한 한계", "저자 명시", "author limitations", "author acknowledged limitations"] },
  { type: "REVIEWER_CRITICISMS", names: ["리뷰어 지적", "reviewer criticisms", "reviewer comments", "review"] },
  { type: "USER_OBSERVATIONS", names: ["내가 본 것", "사용자 관찰", "my observations", "user observations"] },
  { type: "USER_CONTEXT", names: ["내 주제와의 접점", "내 맥락", "user context", "research context"] },
  { type: "REPRODUCIBILITY", names: ["재현 정보", "재현성", "reproducibility", "reproduction"] },
];

const CANONICAL_TYPES: NoteSectionType[] = [
  "CLAIM",
  "SETTING",
  "AUTHOR_LIMITATIONS",
  "REVIEWER_CRITICISMS",
  "REPRODUCIBILITY",
  "USER_CONTEXT",
];

const TRACKED_SECTION_TYPES: NoteSectionType[] = [...CANONICAL_TYPES, "USER_OBSERVATIONS"];

export function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new Error("절대 경로는 업로드할 수 없습니다.");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some(segment => segment === "..")) throw new Error("상위 경로가 포함된 파일은 업로드할 수 없습니다.");
  const safeSegments = segments.filter(segment => segment !== "." && segment !== "__MACOSX");
  if (!safeSegments.length) throw new Error("파일 경로를 확인할 수 없습니다.");
  const result = safeSegments.join("/");
  if (result.length > 512) throw new Error("파일 경로는 512자 이하만 허용됩니다.");
  return result;
}

function normalizeHeading(value: string): string {
  return value.toLocaleLowerCase("ko-KR").replace(/[：:]/g, "").replace(/\s+/g, " ").trim();
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean).map(parseScalar);
  }
  return trimmed;
}

function parseFrontmatter(raw: string): { metadata: Record<string, unknown>; frontmatter: string | null; body: string; warnings: string[] } {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, frontmatter: null, body: normalized, warnings: ["frontmatter_missing"] };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { metadata: {}, frontmatter: null, body: normalized, warnings: ["frontmatter_unclosed"] };
  const frontmatter = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, "");
  const metadata: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const line of frontmatter.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      warnings.push(`frontmatter_unparsed:${line.slice(0, 80)}`);
      continue;
    }
    metadata[match[1]] = parseScalar(match[2]);
  }
  return { metadata, frontmatter, body, warnings };
}

function resolveSectionType(rawHeading: string): NoteSectionType {
  const normalized = normalizeHeading(rawHeading);
  return SECTION_ALIASES.find(alias => alias.names.some(name => normalizeHeading(name) === normalized))?.type ?? "UNKNOWN";
}

function isExplicitEmpty(body: string): boolean {
  const normalized = body.replace(/^[\s>*-]+/gm, "").trim().toLocaleLowerCase("ko-KR");
  return normalized === "없음" || normalized === "none" || normalized === "n/a";
}

function parseInlineSubsections(body: string, startOrder: number): ParsedNoteSection[] {
  const inlinePattern = /^(저자 명시|내가 본 것|사용자 관찰|reviewer criticisms|author limitations)\s*:\s*$/gm;
  const matches = Array.from(body.matchAll(inlinePattern));
  return matches.map((match, index) => {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? body.length;
    const inlineBody = body.slice(bodyStart, bodyEnd).trim();
    const rawHeading = match[1].trim();
    return {
      rawHeading,
      sectionType: resolveSectionType(rawHeading),
      body: inlineBody,
      explicitEmpty: isExplicitEmpty(inlineBody),
      sectionOrder: startOrder + index,
    };
  });
}

function sourceLocator(raw: string, offset: number): string {
  return `line:${raw.slice(0, offset).split("\n").length}`;
}

function extractLinks(raw: string, metadata: Record<string, unknown>): ParsedNoteLink[] {
  const links: ParsedNoteLink[] = [];
  const seen = new Set<string>();
  const add = (link: ParsedNoteLink) => {
    const key = `${link.linkType}:${link.target}:${link.sourceLocator}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push(link);
    }
  };

  const wikilinkPattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const match of Array.from(raw.matchAll(wikilinkPattern))) {
    const target = match[1].trim();
    if (target) add({ linkType: "WIKILINK", target, label: match[2]?.trim() || null, sourceLocator: sourceLocator(raw, match.index ?? 0) });
  }

  const markdownLinkPattern = /!?(?:\[([^\]]*)\])\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of Array.from(raw.matchAll(markdownLinkPattern))) {
    const target = match[2].trim();
    if (/^https?:\/\//i.test(target) || target.toLocaleLowerCase("en-US").endsWith(".md")) {
      add({ linkType: "MARKDOWN_URL", target, label: match[1]?.trim() || null, sourceLocator: sourceLocator(raw, match.index ?? 0) });
    }
  }

  for (const key of ["doi", "arxiv", "id"]) {
    const value = metadata[key];
    if (typeof value !== "string" || !value.trim()) continue;
    add({ linkType: "IDENTIFIER", target: value.trim(), label: key, sourceLocator: `frontmatter:${key}` });
  }
  return links;
}

function buildSectionPresence(sections: ParsedNoteSection[]): Record<NoteSectionType, boolean> {
  const presence: Record<NoteSectionType, boolean> = {
    FRONTMATTER: false,
    CLAIM: false,
    SETTING: false,
    AUTHOR_LIMITATIONS: false,
    REVIEWER_CRITICISMS: false,
    USER_OBSERVATIONS: false,
    USER_CONTEXT: false,
    REPRODUCIBILITY: false,
    UNKNOWN: false,
  };
  for (const section of sections) {
    if (section.body.trim() || section.explicitEmpty) presence[section.sectionType] = true;
  }
  return presence;
}

export function parseMarkdownNote(sourcePath: string, raw: string): ParsedNote {
  const parsedFrontmatter = parseFrontmatter(raw);
  const safeSourcePath = normalizeRelativePath(sourcePath);
  const sourcePathOnly = safeSourcePath;
  const fallbackTitle = sourcePathOnly.split("/").at(-1)?.replace(/\.md$/i, "") || "Untitled note";
  const metadata = parsedFrontmatter.metadata;
  const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : fallbackTitle;
  const externalIdValue = metadata.id ?? metadata.doi ?? metadata.arxiv ?? null;
  const externalId = externalIdValue === null || externalIdValue === undefined ? null : String(externalIdValue);
  const sections: ParsedNoteSection[] = [];
  if (parsedFrontmatter.frontmatter !== null) {
    sections.push({ rawHeading: "frontmatter", sectionType: "FRONTMATTER", body: parsedFrontmatter.frontmatter, explicitEmpty: false, sectionOrder: 0 });
  }

  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  const headings = Array.from(parsedFrontmatter.body.matchAll(headingPattern));
  headings.forEach((heading, index) => {
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? parsedFrontmatter.body.length;
    const body = parsedFrontmatter.body.slice(bodyStart, bodyEnd).trim();
    const rawHeading = heading[2].trim();
    const sectionType = resolveSectionType(rawHeading);
    sections.push({ rawHeading, sectionType, body, explicitEmpty: isExplicitEmpty(body), sectionOrder: sections.length });
    if (normalizeHeading(rawHeading) === "한계") sections.push(...parseInlineSubsections(body, sections.length));
  });

  const warnings = [...parsedFrontmatter.warnings];
  if (headings.length === 0) warnings.push("headings_missing");
  for (const section of sections) {
    if (section.sectionType === "UNKNOWN" && section.rawHeading.toLocaleLowerCase("ko-KR") !== "한계") warnings.push(`unknown_heading:${section.rawHeading}`);
  }
  const sectionPresence = buildSectionPresence(sections);
  for (const type of CANONICAL_TYPES) {
    if (!sectionPresence[type]) warnings.push(`section_missing:${type}`);
  }
  const uniqueWarnings = Array.from(new Set(warnings));
  return {
    sourcePath: sourcePathOnly,
    title,
    externalId,
    contentHash: createHash("sha256").update(raw, "utf8").digest("hex"),
    metadata,
    rawFrontmatter: parsedFrontmatter.frontmatter,
    sections,
    links: extractLinks(raw, metadata),
    warnings: uniqueWarnings,
    sectionPresence,
    explicitEmptySections: sections.filter(section => section.explicitEmpty).map(section => section.sectionType),
  };
}

export function calculateSectionFillRates(notes: Array<Pick<ParsedNote, "sectionPresence" | "explicitEmptySections">>) {
  const types = TRACKED_SECTION_TYPES;
  return Object.fromEntries(types.map(type => [type, {
    present: notes.filter(note => note.sectionPresence[type]).length,
    evidence: notes.filter(note => note.sectionPresence[type] && !note.explicitEmptySections.includes(type)).length,
    total: notes.length,
  }])) as Record<string, { present: number; evidence: number; total: number }>;
}
