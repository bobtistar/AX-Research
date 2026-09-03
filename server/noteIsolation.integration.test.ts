import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  researchInferenceRuns,
  researchNoteSections,
  researchNoteVersions,
  researchNotes,
  users,
  workspaces,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  assertNotesInWorkspace,
  getNoteLibrary,
  getOrCreateWorkspace,
  getResearchNote,
} from "./noteDb";
import {
  authorizeInference,
  clearUserApiKey,
  currentPeriod,
  getUserSettings,
  PLAN_LIMITS,
  recordInferenceUsage,
  saveUserApiKey,
} from "./usage";
import {
  computeStaleness,
  getInferenceRun,
  listInferenceRuns,
  runEvidenceInference,
} from "./inferenceService";
import { listInferenceReviews, submitInferenceReview } from "./inferenceReview";

/**
 * Proves cross-workspace isolation against a real database instead of asserting it about
 * helper functions. Requires a throwaway MySQL with the project migrations applied:
 *   DATABASE_URL="mysql://..." RUN_DB_TESTS=1 pnpm test
 */
const runDbTests =
  process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);

const suffix = nanoid(8);
const openIdA = `test-a-${suffix}`;
const openIdB = `test-b-${suffix}`;

async function seedUserWithNote(openId: string, title: string) {
  const db = (await getDb())!;
  await db.insert(users).values({ openId, name: openId, loginMethod: "test" });
  const user = (
    await db.select().from(users).where(eq(users.openId, openId)).limit(1)
  )[0];
  const { workspace } = await getOrCreateWorkspace(user.id);

  const noteId = nanoid(16);
  const versionId = nanoid(16);
  await db.insert(researchNotes).values({
    id: noteId,
    workspaceId: workspace.id,
    sourcePath: "DINCO_LLM.md",
    externalId: "2509.25532v2",
    title,
  });
  await db.insert(researchNoteVersions).values({
    id: versionId,
    noteId,
    versionNumber: 1,
    contentHash: nanoid(32),
    rawStorageKey: `${workspace.id}/notes/${noteId}/x.md`,
    parserVersion: "notes-v1",
    parsedMetadata: "{}",
    parseWarnings: "[]",
  });
  await db.insert(researchNoteSections).values({
    id: nanoid(16),
    versionId,
    rawHeading: "저자 명시",
    sectionType: "AUTHOR_LIMITATIONS",
    body: `${title} 전용 비공개 근거 문장.`,
    explicitEmpty: false,
    sectionOrder: 0,
  });
  return { user, workspace, noteId, versionId };
}

describe.runIf(runDbTests)(
  "cross-workspace isolation against a real database",
  () => {
    afterAll(async () => {
      const db = await getDb();
      if (!db) return;
      // Workspaces, notes, versions and sections cascade from the user row.
      await db.delete(users).where(inArray(users.openId, [openIdA, openIdB]));
    });

    it("keeps identical filenames and paper IDs in separate workspaces", async () => {
      const alice = await seedUserWithNote(openIdA, "Alice private note");
      const bob = await seedUserWithNote(openIdB, "Bob private note");
      expect(alice.workspace.id).not.toBe(bob.workspace.id);

      const aliceLibrary = await getNoteLibrary(alice.user.id);
      expect(aliceLibrary.notes.map(note => note.id)).toEqual([alice.noteId]);
      expect(aliceLibrary.notes.map(note => note.id)).not.toContain(bob.noteId);
    });

    it("refuses a direct read of another workspace's note", async () => {
      const alice = (
        await getDb().then(db =>
          db!.select().from(users).where(eq(users.openId, openIdA)).limit(1)
        )
      )[0];
      const db = (await getDb())!;
      const bobWorkspace = (
        await db
          .select()
          .from(workspaces)
          .innerJoin(users, eq(workspaces.userId, users.id))
          .where(eq(users.openId, openIdB))
      )[0];
      const bobNote = (
        await db
          .select()
          .from(researchNotes)
          .where(eq(researchNotes.workspaceId, bobWorkspace.workspaces.id))
          .limit(1)
      )[0];

      expect(await getResearchNote(alice.id, bobNote.id)).toBeUndefined();
    });

    it("rejects an inference run that names another workspace's note", async () => {
      const db = (await getDb())!;
      const alice = (
        await db.select().from(users).where(eq(users.openId, openIdA)).limit(1)
      )[0];
      const aliceWorkspace = (
        await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.userId, alice.id))
          .limit(1)
      )[0];
      const bobWorkspace = (
        await db
          .select()
          .from(workspaces)
          .innerJoin(users, eq(workspaces.userId, users.id))
          .where(eq(users.openId, openIdB))
      )[0];
      const bobNote = (
        await db
          .select()
          .from(researchNotes)
          .where(eq(researchNotes.workspaceId, bobWorkspace.workspaces.id))
          .limit(1)
      )[0];

      await expect(
        assertNotesInWorkspace(db, aliceWorkspace.id, [bobNote.id])
      ).rejects.toThrow(/workspace/);
      await expect(
        runEvidenceInference(
          alice.id,
          [bobNote.id],
          "저자가 인정한 한계를 정리해줘."
        )
      ).rejects.toThrow(/workspace/);

      // The rejected run must not have produced a stored result either.
      const leaked = await db
        .select()
        .from(researchNotes)
        .where(
          and(
            eq(researchNotes.id, bobNote.id),
            eq(researchNotes.workspaceId, aliceWorkspace.id)
          )
        );
      expect(leaked).toEqual([]);
    });

    it("refuses to review another workspace's inference run", async () => {
      const db = (await getDb())!;
      const [alice, bob] = await Promise.all(
        [openIdA, openIdB].map(
          async openId =>
            (
              await db
                .select()
                .from(users)
                .where(eq(users.openId, openId))
                .limit(1)
            )[0]
        )
      );
      const bobWorkspace = (
        await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.userId, bob.id))
          .limit(1)
      )[0];
      const bobNote = (
        await db
          .select()
          .from(researchNotes)
          .where(eq(researchNotes.workspaceId, bobWorkspace.id))
          .limit(1)
      )[0];

      // A completed run in Bob's workspace, written directly so the test does not spend a
      // model call to produce something Alice must be refused.
      const runId = nanoid(16);
      await db.insert(researchInferenceRuns).values({
        id: runId,
        workspaceId: bobWorkspace.id,
        question: "저자가 인정한 한계를 정리해줘.",
        noteVersionIds: JSON.stringify([]),
        model: "test-model",
        promptVersion: "evidence-v2",
        status: "SUCCEEDED",
        resultJson: JSON.stringify({
          claims: [
            {
              noteId: bobNote.id,
              sectionType: "AUTHOR_LIMITATIONS",
              answer: "Bob 전용 결과.",
              evidenceIds: [],
              supportStatus: "supported",
            },
          ],
          missing: [],
        }),
      });

      const review = {
        runId,
        targetKind: "CLAIM" as const,
        noteId: bobNote.id,
        sectionType: "AUTHOR_LIMITATIONS",
        verdict: "APPROVED" as const,
      };
      await expect(submitInferenceReview(alice.id, review)).rejects.toThrow(
        /찾을 수 없습니다/
      );
      await expect(listInferenceReviews(alice.id, runId)).rejects.toThrow(
        /찾을 수 없습니다/
      );

      // Bob's own review of the same run still lands, so the refusal is ownership and not
      // a broken write path.
      const saved = await submitInferenceReview(bob.id, review);
      expect(saved.summary).toMatchObject({ approved: 1, pending: 0 });
    });

    it("refuses a verdict on a cell the run never produced", async () => {
      const db = (await getDb())!;
      const bob = (
        await db.select().from(users).where(eq(users.openId, openIdB)).limit(1)
      )[0];
      const run = (
        await db
          .select()
          .from(researchInferenceRuns)
          .where(eq(researchInferenceRuns.model, "test-model"))
          .limit(1)
      )[0];

      await expect(
        submitInferenceReview(bob.id, {
          runId: run.id,
          targetKind: "CLAIM",
          noteId: "note_never_seen",
          sectionType: "SETTING",
          verdict: "APPROVED",
        })
      ).rejects.toThrow(/없는 항목/);
    });

    it("reads a stored run back well enough to review it in a later session", async () => {
      // The regression this guards: the read path used to return an untyped blob, so a run
      // could only be reviewed in the session that produced it and every earlier run's
      // verdicts were unreachable — which starved the evaluation set.
      const db = (await getDb())!;
      const bob = (
        await db.select().from(users).where(eq(users.openId, openIdB)).limit(1)
      )[0];
      const stored = (
        await db
          .select()
          .from(researchInferenceRuns)
          .where(eq(researchInferenceRuns.model, "test-model"))
          .limit(1)
      )[0];

      const run = await getInferenceRun(bob.id, stored.id);
      expect(run?.result?.question).toBe("저자가 인정한 한계를 정리해줘.");
      expect(run?.result?.claims[0]).toMatchObject({
        sectionType: "AUTHOR_LIMITATIONS",
        answer: "Bob 전용 결과.",
      });
      // Cells are what the review UI renders buttons for.
      expect(run?.cells).toEqual([
        {
          targetKind: "CLAIM",
          noteId: run!.result!.claims[0].noteId,
          sectionType: "AUTHOR_LIMITATIONS",
        },
      ]);
      // Reviewed in the earlier test, so it comes back complete rather than pending.
      expect(run?.review).toMatchObject({ approved: 1, pending: 0 });

      const listed = await listInferenceRuns(bob.id);
      const row = listed.find(item => item.id === stored.id);
      expect(row?.result?.claims).toHaveLength(1);
      expect(row?.review).toMatchObject({ approved: 1, pending: 0 });
      // Nothing has changed yet, so the run still rests on the notes as they stand.
      expect(run?.staleness?.state).toBe("fresh");
    });

    it("marks a run stale once its note gets a newer version", async () => {
      const db = (await getDb())!;
      const bob = (
        await db.select().from(users).where(eq(users.openId, openIdB)).limit(1)
      )[0];
      const stored = (
        await db
          .select()
          .from(researchInferenceRuns)
          .where(eq(researchInferenceRuns.model, "test-model"))
          .limit(1)
      )[0];
      const readVersion = (
        await db
          .select()
          .from(researchNoteVersions)
          .where(
            eq(
              researchNoteVersions.noteId,
              (await getInferenceRun(bob.id, stored.id))!.result!.claims[0]
                .noteId
            )
          )
          .limit(1)
      )[0];

      // Point the run at a version that exists, then re-upload the note.
      await db
        .update(researchInferenceRuns)
        .set({ noteVersionIds: JSON.stringify([readVersion.id]) })
        .where(eq(researchInferenceRuns.id, stored.id));
      expect(
        (
          await computeStaleness(db, [
            { id: stored.id, noteVersionIds: JSON.stringify([readVersion.id]) },
          ])
        ).get(stored.id)?.state
      ).toBe("fresh");

      const newerVersionId = nanoid(16);
      await db.insert(researchNoteVersions).values({
        id: newerVersionId,
        noteId: readVersion.noteId,
        versionNumber: readVersion.versionNumber + 1,
        contentHash: nanoid(32),
        rawStorageKey: `x/${newerVersionId}.md`,
        parserVersion: "notes-v1",
        parsedMetadata: "{}",
        parseWarnings: "[]",
      });

      const after = await getInferenceRun(bob.id, stored.id);
      expect(after?.staleness?.state).toBe("stale");
      expect(after?.staleness?.notes[0]).toMatchObject({
        noteId: readVersion.noteId,
        ranWith: readVersion.id,
        current: newerVersionId,
        ranWithNumber: 1,
        currentNumber: 2,
      });
      // The run's own status is untouched — staleness is not how the run ended.
      expect(after?.status).toBe("SUCCEEDED");

      // A version that no longer exists is a different, unrecoverable state.
      const gone = await computeStaleness(db, [
        { id: "ghost", noteVersionIds: JSON.stringify(["version_deleted"]) },
      ]);
      expect(gone.get("ghost")?.state).toBe("source_missing");
    });

    it("stops a free user at the monthly limit and lets a BYOK user past it", async () => {
      const db = (await getDb())!;
      const alice = (
        await db.select().from(users).where(eq(users.openId, openIdA)).limit(1)
      )[0];

      // A fresh account is on FREE with the whole allowance unspent.
      const initial = await getUserSettings(alice.id);
      expect(initial).toMatchObject({
        plan: "FREE",
        hasOwnKey: false,
        used: 0,
        limit: PLAN_LIMITS.FREE,
        period: currentPeriod(),
      });

      // Spend the allowance.
      for (let i = 0; i < PLAN_LIMITS.FREE; i += 1) {
        const grant = await authorizeInference(alice.id);
        expect(grant.billedToOperator).toBe(true);
        await recordInferenceUsage(alice.id, grant, "test-model");
      }
      await expect(authorizeInference(alice.id)).rejects.toThrow(
        /모두 사용했습니다/
      );

      // Their own key lifts the ceiling, and is never returned to the client.
      const saved = await saveUserApiKey(
        alice.id,
        "AIzaSyExampleKeyValueThatIsLongEnough"
      );
      expect(saved).toMatchObject({ hasOwnKey: true, keyHint: "ough" });
      expect(JSON.stringify(saved)).not.toContain("AIzaSyExample");

      const byok = await authorizeInference(alice.id);
      expect(byok.apiKey).toBe("AIzaSyExampleKeyValueThatIsLongEnough");
      // BYOK calls are recorded for visibility but never charged to the operator.
      expect(byok.billedToOperator).toBe(false);
      await recordInferenceUsage(alice.id, byok, "test-model");
      expect((await getUserSettings(alice.id)).used).toBe(PLAN_LIMITS.FREE);

      // Removing the key puts the ceiling back.
      await clearUserApiKey(alice.id);
      await expect(authorizeInference(alice.id)).rejects.toThrow(
        /모두 사용했습니다/
      );
    });
  }
);
