import { describe, expect, it } from "vitest";
import {
  renderSections,
  selectRelevantSections,
  splitArxivHtml,
  type PaperSection,
} from "./paperFullText";

function section(
  heading: string,
  body: string,
  level: 2 | 3 = 2,
  parent: string | null = null
): PaperSection {
  return { heading, body, level, parent };
}

describe("arXiv HTML splitting", () => {
  const html = `
    <h2 class="ltx_title ltx_title_section"><span class="ltx_tag">1 </span>Introduction</h2>
    <p>We propose a benchmark.</p>
    <h2 class="ltx_title ltx_title_section"><span class="ltx_tag">2 </span>Related Work</h2>
    <h3 class="ltx_title ltx_title_subsection"><span class="ltx_tag">2.1 </span>Benchmarks</h3>
    <p>Others built benchmarks.</p>
    <h2 class="ltx_title ltx_title_section"><span class="ltx_tag">3 </span>Limitations</h2>
    <p>Our evaluation covers Korean only.</p>`;

  it("splits at headings and records each subsection's parent", () => {
    const sections = splitArxivHtml(html);
    expect(sections.map(s => s.heading)).toEqual([
      "1 Introduction",
      "2.1 Benchmarks",
      "3 Limitations",
    ]);
    // "2 Related Work" has no body of its own and does not survive as a section — but its
    // name still has to reach its children, or they lose the only signal that they are
    // related work.
    expect(sections[1]).toMatchObject({ level: 3, parent: "2 Related Work" });
  });

  it("strips markup and collapses whitespace", () => {
    expect(splitArxivHtml(html)[0].body).toBe("We propose a benchmark.");
  });
});

describe("an unconvertible paper", () => {
  it("yields no sections from an abstract landing page", () => {
    // A converter that lacks a paper answers with the arXiv abstract page and HTTP 200.
    // Nothing about the response says so; the absence of sections is the only signal, which
    // is what makes the caller's zero-section check load-bearing rather than defensive.
    const landingPage = `
      <h1 class="title mathjax">Optimization of DNN-based speaker verification</h1>
      <h3 class="browse-context-heading">Browse context</h3>
      <blockquote class="abstract">Some abstract text.</blockquote>`;
    expect(splitArxivHtml(landingPage)).toEqual([]);
  });
});

describe("section selection", () => {
  it("drops a subsection because its parent is excluded", () => {
    // The defect this guards: excluding by heading alone let "2.1 Benchmarks" through,
    // and an appendix subsection was once the single largest thing in the budget.
    const result = selectRelevantSections([
      section("1 Introduction", "intro"),
      section("2.1 Benchmarks", "others", 3, "2 Related Work"),
      section("A.1 Extra tables", "tables", 3, "Appendix A"),
    ]);
    expect(result.sections.map(s => s.heading)).toEqual(["1 Introduction"]);
  });

  it("keeps limitations when the budget forces a choice", () => {
    // Ranked first on purpose: a paper that states its limits must not read as one that
    // does not, just because an earlier section was long.
    const result = selectRelevantSections(
      [
        section("1 Introduction", "x".repeat(5_000)),
        section("8 Limitations", "y".repeat(100)),
      ],
      // Leaves 500 characters after the limitations section — below the useful floor, so
      // the introduction is named as omitted rather than cut to a citable fragment.
      600
    );
    expect(result.sections.map(s => s.heading)).toContain("8 Limitations");
    expect(result.omitted).toContain("1 Introduction");
  });

  it("truncates an oversized section, but only while the remainder is still useful", () => {
    // Half a limitations section still names a limitation; a hundred characters of one is
    // noise that can still be cited, so that case is omitted instead.
    const result = selectRelevantSections(
      [section("8 Limitations", "y".repeat(5_000))],
      2_000
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].body.endsWith("…")).toBe(true);
    expect(result.sections[0].body.length).toBeLessThanOrEqual(2_001);
  });

  it("returns sections in the paper's own order, not priority order", () => {
    const result = selectRelevantSections([
      section("1 Introduction", "intro"),
      section("5 Results", "results"),
      section("8 Limitations", "limits"),
    ]);
    expect(result.sections.map(s => s.heading)).toEqual([
      "1 Introduction",
      "5 Results",
      "8 Limitations",
    ]);
  });

  it("renders headings the model can attribute a limitation to", () => {
    const rendered = renderSections([section("8 Limitations", "Korean only.")]);
    expect(rendered).toBe("## 8 Limitations\nKorean only.");
  });
});
