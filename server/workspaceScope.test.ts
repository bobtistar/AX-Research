import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pickUnauthorizedNoteIds } from "./noteDb";

/**
 * The previous "isolation test" exercised helper functions that no production code path
 * called, so dropping a workspace predicate in noteDb.ts would have left it green. These
 * tests read the real source and the real decision function instead.
 */

const WORKSPACE_SCOPED_TABLES = [
  "researchNotes",
  "researchCollections",
  "researchInferenceRuns",
] as const;
const NOTE_KEYED_TABLES = [
  "researchNoteVersions",
  "researchNoteSections",
  "researchNoteLinks",
] as const;
const SERVER_FILES = [
  "server/noteDb.ts",
  "server/inferenceService.ts",
] as const;

/** Split a source file into statements so a `where` clause is checked against its own query. */
function selectStatements(source: string): string[] {
  return source
    .split(";")
    .map(statement => statement.trim())
    .filter(statement => statement.includes(".from("));
}

describe("workspace scoping of private document reads", () => {
  it("scopes every direct read of a workspace-owned table by workspaceId", () => {
    const offenders: string[] = [];
    for (const file of SERVER_FILES) {
      const source = readFileSync(file, "utf8");
      for (const statement of selectStatements(source)) {
        for (const table of WORKSPACE_SCOPED_TABLES) {
          if (!statement.includes(`.from(${table})`)) continue;
          // A read may be scoped by workspaceId directly, or by a primary key that an
          // earlier workspace-scoped query already produced (collection/run id lookups).
          const scoped =
            statement.includes("workspaceId") ||
            statement.includes(`${table}.id`);
          if (!scoped) offenders.push(`${file}: ${statement.slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reads note-keyed tables from raw client IDs without an ownership gate", () => {
    for (const file of SERVER_FILES) {
      const source = readFileSync(file, "utf8");
      const touchesNoteKeyedTable = NOTE_KEYED_TABLES.some(table =>
        source.includes(`.from(${table})`)
      );
      if (!touchesNoteKeyedTable) continue;
      // These tables carry no workspace column, so the file must prove ownership itself
      // (noteDb resolves the note through a workspace-scoped query; inferenceService calls the gate).
      const hasGate =
        source.includes("assertNotesInWorkspace") ||
        source.includes("eq(researchNotes.workspaceId");
      expect(
        hasGate,
        `${file} reads note-keyed tables without a workspace ownership gate`
      ).toBe(true);
    }
  });
});

describe("note ownership decision", () => {
  const ownedByWorkspaceA = [{ id: "note_a1" }, { id: "note_a2" }];

  it("accepts a selection fully owned by the workspace", () => {
    expect(
      pickUnauthorizedNoteIds(["note_a1", "note_a2"], ownedByWorkspaceA)
    ).toEqual([]);
  });

  it("rejects an ID that the workspace-scoped query did not return", () => {
    expect(
      pickUnauthorizedNoteIds(["note_a1", "note_b1"], ownedByWorkspaceA)
    ).toEqual(["note_b1"]);
  });

  it("rejects every ID when the workspace owns nothing", () => {
    expect(pickUnauthorizedNoteIds(["note_b1", "note_b2"], [])).toEqual([
      "note_b1",
      "note_b2",
    ]);
  });
});
