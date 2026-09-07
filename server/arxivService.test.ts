import { describe, expect, it } from "vitest";
import { extractArxivId, parseArxivFeed } from "./arxivService";

describe("arXiv identifier extraction", () => {
  it("reads the id out of the DOI stub OpenAlex assigns preprints", () => {
    expect(
      extractArxivId({ doi: "https://doi.org/10.48550/arxiv.2308.09687" })
    ).toBe("2308.09687");
    expect(extractArxivId({ doi: "10.48550/arXiv.2401.14295" })).toBe(
      "2401.14295"
    );
  });

  it("reads the id out of an arXiv landing page or PDF link", () => {
    expect(extractArxivId({ sourceUrl: "http://arxiv.org/abs/1706.02216" })).toBe(
      "1706.02216"
    );
    expect(extractArxivId({ sourceUrl: "https://arxiv.org/pdf/2305.16582" })).toBe(
      "2305.16582"
    );
  });

  it("drops the version suffix so the note points at the paper, not one revision", () => {
    expect(extractArxivId({ sourceUrl: "https://arxiv.org/abs/2308.09687v3" })).toBe(
      "2308.09687"
    );
  });

  it("accepts the pre-2007 identifier scheme", () => {
    expect(extractArxivId({ sourceUrl: "https://arxiv.org/abs/cs/0112017" })).toBe(
      "cs/0112017"
    );
  });

  it("refuses to read a digit run in an unrelated DOI as an arXiv id", () => {
    // Journal DOIs carry number sequences too; only values that name arXiv are consulted.
    expect(
      extractArxivId({ doi: "https://doi.org/10.1103/physreve.64.026118" })
    ).toBeNull();
    expect(extractArxivId({ doi: null, sourceUrl: null })).toBeNull();
  });
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2308.09687v3</id>
    <updated>2024-02-06T18:00:18Z</updated>
    <published>2023-08-18T17:16:33Z</published>
    <title>Graph of Thoughts: Solving Elaborate
  Problems with Large Language Models</title>
    <summary>  We introduce Graph of Thoughts (GoT): a framework
that advances prompting &amp; capabilities.
</summary>
    <author><name>Maciej Besta</name></author>
    <author><name>Nils Blach</name></author>
  </entry>
</feed>`;

describe("arXiv feed parsing", () => {
  const [record] = parseArxivFeed(FEED);

  it("collapses the newlines arXiv wraps titles and abstracts at", () => {
    expect(record.title).toBe(
      "Graph of Thoughts: Solving Elaborate Problems with Large Language Models"
    );
    expect(record.abstract).toBe(
      "We introduce Graph of Thoughts (GoT): a framework that advances prompting & capabilities."
    );
  });

  it("keeps the versionless id and derives stable links from it", () => {
    expect(record.arxivId).toBe("2308.09687");
    expect(record.absUrl).toBe("https://arxiv.org/abs/2308.09687");
    expect(record.pdfUrl).toBe("https://arxiv.org/pdf/2308.09687");
  });

  it("keeps both dates apart so a revised preprint can be spotted", () => {
    expect(record.published).toBe("2023-08-18T17:16:33Z");
    expect(record.updated).toBe("2024-02-06T18:00:18Z");
  });

  it("reads every author in order", () => {
    expect(record.authors).toEqual(["Maciej Besta", "Nils Blach"]);
  });

  it("skips the error entry arXiv returns for an unknown id", () => {
    // arXiv answers a bad id with a 200 and an entry titled "Error", not with a failure.
    const errorFeed = `<feed><entry><id>http://arxiv.org/api/errors</id>
      <title>Error</title><summary>incorrect id format</summary></entry></feed>`;
    expect(parseArxivFeed(errorFeed)).toEqual([]);
  });
});
