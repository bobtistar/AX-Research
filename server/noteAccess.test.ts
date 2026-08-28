import { describe, expect, it } from "vitest";
import { canReadPrivateResource, filterByWorkspace, isCrossWorkspace } from "./noteAccess";

describe("private note workspace boundary", () => {
  const sameFileName = [
    { id: "note-a", workspaceId: "workspace-a", sourcePath: "DINCO_LLM.md", externalId: "2509.25532v2" },
    { id: "note-b", workspaceId: "workspace-b", sourcePath: "DINCO_LLM.md", externalId: "2509.25532v2" },
  ];

  it("returns only documents owned by the requested workspace", () => {
    expect(filterByWorkspace(sameFileName, "workspace-a").map(note => note.id)).toEqual(["note-a"]);
    expect(filterByWorkspace(sameFileName, "workspace-b").map(note => note.id)).toEqual(["note-b"]);
  });

  it("does not treat the same filename or paper ID as shared ownership", () => {
    expect(canReadPrivateResource(sameFileName[0], "workspace-a")).toBe(true);
    expect(canReadPrivateResource(sameFileName[0], "workspace-b")).toBe(false);
    expect(isCrossWorkspace(sameFileName[0], "workspace-b")).toBe(true);
  });
});
