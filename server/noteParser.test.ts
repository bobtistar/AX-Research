import { describe, expect, it } from "vitest";
import { normalizeRelativePath, parseMarkdownNote } from "./noteParser";

const dincoLikeMarkdown = `---
id: 2509.25532v2
title: Calibrating Verbalized Confidence with Self-Generated Distractors
venue: ICLR 2026
year: 2026
arxiv: 2509.25532v2
keywords: [confidence calibration, verbalized confidence]
---

## 주장
- C1 (가설): suggestibility가 존재한다 (§2.1).
- C2 (예비 검증): confidence 차이가 관찰된다 (Table 1).

## 한계

### 저자 명시
- 블랙박스 설정에서는 성능이 떨어지는 경향이 있다 (§4).

### 내가 본 것
- 이 관찰은 noisy proxy에 기대며 추가 검증이 없다(§2.1–§2.2). [외부지식]

## 내 맥락
(사용자 확인 필요) 요약됨.
`;

describe("parseMarkdownNote", () => {
  it("preserves the note identity and separates author evidence from user observation", () => {
    const parsed = parseMarkdownNote(
      "20_seeds/DINCO_LLM.md",
      dincoLikeMarkdown
    );
    expect(parsed.title).toContain("Calibrating Verbalized Confidence");
    expect(parsed.externalId).toBe("2509.25532v2");
    expect(
      parsed.sections.find(section => section.rawHeading === "저자 명시")
        ?.sectionType
    ).toBe("AUTHOR_LIMITATIONS");
    expect(
      parsed.sections.find(section => section.rawHeading === "내가 본 것")
        ?.sectionType
    ).toBe("USER_OBSERVATIONS");
    expect(
      parsed.sections.find(section => section.rawHeading === "내 맥락")
        ?.sectionType
    ).toBe("USER_CONTEXT");
    expect(parsed.warnings).toContain("section_missing:REVIEWER_CRITICISMS");
    expect(
      parsed.warnings.some(warning => warning.startsWith("unknown_heading"))
    ).toBe(false);
  });

  it("parses DINCO colon subsections under a generic limitation heading", () => {
    const parsed = parseMarkdownNote(
      "DINCO_LLM.md",
      "---\ntitle: DINCO\n---\n\n## 한계\n\n저자 명시:\n- 비용이 증가한다 (§4).\n\n내가 본 것:\n- 추가 검증이 필요하다. [외부지식]\n\n## 내 맥락\n(사용자 확인 필요) 요약됨.\n"
    );
    expect(
      parsed.sections.find(section => section.rawHeading === "저자 명시")
        ?.sectionType
    ).toBe("AUTHOR_LIMITATIONS");
    expect(
      parsed.sections.find(section => section.rawHeading === "내가 본 것")
        ?.sectionType
    ).toBe("USER_OBSERVATIONS");
    expect(parsed.warnings).toContain("section_missing:REVIEWER_CRITICISMS");
  });

  it("indexes wikilinks, Markdown URLs, and paper identifiers with source locators", () => {
    const parsed = parseMarkdownNote(
      "20_seeds/linked.md",
      "---\nid: 2509.25532v2\ntitle: Linked\n---\n\n## 주장\nSee [[DINCO_LLM|the note]] and [paper](https://arxiv.org/abs/2509.25532).\n"
    );
    expect(parsed.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linkType: "IDENTIFIER",
          target: "2509.25532v2",
          sourceLocator: "frontmatter:id",
        }),
        expect.objectContaining({
          linkType: "WIKILINK",
          target: "DINCO_LLM",
          label: "the note",
          sourceLocator: "line:7",
        }),
        expect.objectContaining({
          linkType: "MARKDOWN_URL",
          target: "https://arxiv.org/abs/2509.25532",
          label: "paper",
          sourceLocator: "line:7",
        }),
      ])
    );
  });

  it("marks explicit empty sections differently from missing sections", () => {
    const parsed = parseMarkdownNote(
      "empty.md",
      "---\ntitle: Empty\n---\n\n## 주장\n없음\n"
    );
    expect(parsed.sectionPresence.CLAIM).toBe(true);
    expect(parsed.explicitEmptySections).toContain("CLAIM");
    expect(parsed.warnings).toContain("section_missing:AUTHOR_LIMITATIONS");
  });

  it("reads Obsidian YAML block sequences instead of dropping them", () => {
    const parsed = parseMarkdownNote(
      "tagged.md",
      "---\nid: 2509.25532v2\ntitle: Tagged\ntags:\n  - calibration\n  - llm\nauthors:\n  - Kim\n---\n\n## 주장\n- C1.\n"
    );
    expect(parsed.metadata.tags).toEqual(["calibration", "llm"]);
    expect(parsed.metadata.authors).toEqual(["Kim"]);
    expect(parsed.externalId).toBe("2509.25532v2");
    expect(
      parsed.warnings.some(warning =>
        warning.startsWith("frontmatter_unparsed")
      )
    ).toBe(false);
  });

  it("keeps a key with no value and no items as null", () => {
    const parsed = parseMarkdownNote(
      "bare.md",
      "---\ntitle: Bare\ntags:\n---\n\n## 주장\n- C1.\n"
    );
    expect(parsed.metadata.tags).toBeNull();
    expect(
      parsed.warnings.some(warning =>
        warning.startsWith("frontmatter_unparsed")
      )
    ).toBe(false);
  });

  it("does not turn a list-valued identifier field into a joined string", () => {
    const parsed = parseMarkdownNote(
      "listy.md",
      "---\ntitle: Listy\nid:\n  - a\n  - b\ndoi: 10.1000/example\n---\n\n## 주장\n- C1.\n"
    );
    expect(parsed.externalId).toBe("10.1000/example");
  });

  it("unescapes quoted frontmatter scalars", () => {
    const parsed = parseMarkdownNote(
      "quoted.md",
      "---\ntitle: \"A \\\"quoted\\\" title: with a colon\"\nnote: 'it''s fine'\n---\n\n## 주장\n- C1.\n"
    );
    expect(parsed.title).toBe('A "quoted" title: with a colon');
    expect(parsed.metadata.note).toBe("it's fine");
  });

  it("rejects unsafe absolute and parent paths", () => {
    expect(() => normalizeRelativePath("../private.md")).toThrow();
    expect(() => normalizeRelativePath("/Users/me/private.md")).toThrow();
    expect(normalizeRelativePath("20_seeds\\DINCO_LLM.md")).toBe(
      "20_seeds/DINCO_LLM.md"
    );
  });
});
