import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  deletedStorageObjects,
  researchCollectionNotes,
  researchCollections,
  researchNoteSections,
  researchNoteLinks,
  researchNoteVersions,
  researchNotes,
  workspaces,
} from "../drizzle/schema";
import { getDb } from "./db";
import { storageDelete, storageGetSignedUrl, storagePut } from "./storage";
import {
  NOTE_PARSER_VERSION,
  ParsedNote,
  buildSectionPresence,
  calculateSectionFillRates,
  normalizeRelativePath,
  parseMarkdownNote,
} from "./noteParser";

export type IngestFileInput = { name: string; content: string };

function requireDb() {
  return getDb().then(db => {
    if (!db) throw new Error("데이터베이스에 연결할 수 없습니다.");
    return db;
  });
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function getOrCreateWorkspace(userId: number) {
  const db = await requireDb();
  const existing = (
    await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, userId))
      .limit(1)
  )[0];
  if (existing) return { db, workspace: existing };
  const id = nanoid(16);
  try {
    await db
      .insert(workspaces)
      .values({ id, userId, name: "Private Research Workspace" });
  } catch {
    const raced = (
      await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.userId, userId))
        .limit(1)
    )[0];
    if (raced) return { db, workspace: raced };
    throw new Error("사용자 workspace를 만들 수 없습니다.");
  }
  const created = (
    await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  )[0];
  if (!created)
    throw new Error("사용자 workspace 생성 결과를 확인할 수 없습니다.");
  return { db, workspace: created };
}

async function ensureInbox(
  db: Awaited<ReturnType<typeof requireDb>>,
  workspaceId: string
) {
  const existing = (
    await db
      .select()
      .from(researchCollections)
      .where(
        and(
          eq(researchCollections.workspaceId, workspaceId),
          eq(researchCollections.name, "Inbox")
        )
      )
      .limit(1)
  )[0];
  if (existing) return existing;
  const id = nanoid(16);
  await db.insert(researchCollections).values({
    id,
    workspaceId,
    name: "Inbox",
    description: "업로드한 Markdown이 처음 들어오는 private collection",
  });
  return (
    await db
      .select()
      .from(researchCollections)
      .where(eq(researchCollections.id, id))
      .limit(1)
  )[0];
}

async function assertCollection(
  db: Awaited<ReturnType<typeof requireDb>>,
  collectionId: string,
  workspaceId: string
) {
  const collection = (
    await db
      .select()
      .from(researchCollections)
      .where(
        and(
          eq(researchCollections.id, collectionId),
          eq(researchCollections.workspaceId, workspaceId)
        )
      )
      .limit(1)
  )[0];
  if (!collection)
    throw new Error("현재 workspace에 속한 Collection이 아닙니다.");
  return collection;
}

async function ensureMembership(
  db: Awaited<ReturnType<typeof requireDb>>,
  collectionId: string,
  noteId: string
) {
  const existing = (
    await db
      .select()
      .from(researchCollectionNotes)
      .where(
        and(
          eq(researchCollectionNotes.collectionId, collectionId),
          eq(researchCollectionNotes.noteId, noteId)
        )
      )
      .limit(1)
  )[0];
  if (!existing)
    await db.insert(researchCollectionNotes).values({ collectionId, noteId });
}

function latestVersionMap<T extends { noteId: string }>(versions: T[]) {
  const map = new Map<string, T>();
  for (const version of versions)
    if (!map.has(version.noteId)) map.set(version.noteId, version);
  return map;
}

function makeMetrics(
  parsedNotes: Array<
    Pick<ParsedNote, "sectionPresence" | "explicitEmptySections">
  >,
  warningCount: number,
  duplicateCount = 0,
  failedCount = 0
) {
  const fillRates = calculateSectionFillRates(parsedNotes);
  return {
    uploaded: parsedNotes.length + duplicateCount + failedCount,
    parsed: parsedNotes.length,
    duplicates: duplicateCount,
    failed: failedCount,
    warnings: warningCount,
    sectionFillRates: fillRates,
  };
}

export async function getNoteLibrary(userId: number, collectionId?: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const inbox = await ensureInbox(db, workspace.id);
  const collections = await db
    .select()
    .from(researchCollections)
    .where(eq(researchCollections.workspaceId, workspace.id))
    .orderBy(desc(researchCollections.updatedAt));
  const notes = await db
    .select()
    .from(researchNotes)
    .where(eq(researchNotes.workspaceId, workspace.id))
    .orderBy(desc(researchNotes.updatedAt));
  const memberships = notes.length
    ? await db
        .select()
        .from(researchCollectionNotes)
        .where(
          inArray(
            researchCollectionNotes.noteId,
            notes.map(note => note.id)
          )
        )
    : [];
  const visibleNoteIds = collectionId
    ? new Set(
        memberships
          .filter(item => item.collectionId === collectionId)
          .map(item => item.noteId)
      )
    : new Set(notes.map(note => note.id));
  if (collectionId) await assertCollection(db, collectionId, workspace.id);
  const scopedNotes = notes.filter(note => visibleNoteIds.has(note.id));
  const versions = scopedNotes.length
    ? await db
        .select()
        .from(researchNoteVersions)
        .where(
          inArray(
            researchNoteVersions.noteId,
            scopedNotes.map(note => note.id)
          )
        )
        .orderBy(desc(researchNoteVersions.versionNumber))
    : [];
  const latest = latestVersionMap(versions);
  const sectionRows = versions.length
    ? await db
        .select()
        .from(researchNoteSections)
        .where(
          inArray(
            researchNoteSections.versionId,
            versions.map(version => version.id)
          )
        )
    : [];
  const parsedNotes = scopedNotes.map(note => {
    const version = latest.get(note.id);
    const metadata = version
      ? parseJson<Record<string, unknown>>(version.parsedMetadata, {})
      : {};
    const warnings = version
      ? parseJson<string[]>(version.parseWarnings, [])
      : ["version_missing"];
    // Section state comes from the stored rows, not from reverse-parsing warning strings:
    // USER_OBSERVATIONS never emits a section_missing warning, so the old UI read it as present.
    const versionSections = version
      ? sectionRows.filter(section => section.versionId === version.id)
      : [];
    return {
      ...note,
      latestVersionId: version?.id ?? null,
      contentHash: version?.contentHash ?? null,
      parserVersion: version?.parserVersion ?? null,
      metadata,
      warnings,
      sectionPresence: buildSectionPresence(versionSections),
      explicitEmptySections: versionSections
        .filter(section => section.explicitEmpty)
        .map(section => section.sectionType),
      versionCount: versions.filter(item => item.noteId === note.id).length,
      collectionIds: memberships
        .filter(item => item.noteId === note.id)
        .map(item => item.collectionId),
    };
  });
  const parsedForMetrics = versions.map(version => {
    const sections = sectionRows.filter(
      section => section.versionId === version.id
    );
    return {
      sectionPresence: buildSectionPresence(sections),
      explicitEmptySections: sections
        .filter(section => section.explicitEmpty)
        .map(section => section.sectionType),
    };
  });
  const warningCount = parsedNoteWarnings(parsedNotes);
  return {
    workspace: { id: workspace.id, name: workspace.name },
    inboxId: inbox?.id ?? null,
    collections,
    notes: parsedNotes,
    metrics: {
      noteCount: scopedNotes.length,
      versionCount: versions.length,
      warningCount,
      sectionFillRates: calculateSectionFillRates(parsedForMetrics),
    },
  };
}

function parsedNoteWarnings(notes: Array<{ warnings: string[] }>) {
  return notes.reduce((total, note) => total + note.warnings.length, 0);
}

/**
 * Pure ownership decision, split out so it can be tested without a database.
 * Returns the requested IDs that the workspace does not own.
 */
export function pickUnauthorizedNoteIds(
  requestedIds: readonly string[],
  ownedRows: ReadonlyArray<{ id: string }>
): string[] {
  const owned = new Set(ownedRows.map(row => row.id));
  return requestedIds.filter(id => !owned.has(id));
}

/**
 * Note IDs arrive straight from the client, so every read that starts from them must prove
 * workspace ownership first. Without this, an ID from another workspace reached the version
 * and section tables, which are keyed by noteId and carry no workspace column of their own.
 */
export async function assertNotesInWorkspace(
  db: Awaited<ReturnType<typeof requireDb>>,
  workspaceId: string,
  noteIds: readonly string[]
) {
  if (!noteIds.length) throw new Error("추론 대상 노트를 선택해 주세요.");
  const owned = await db
    .select({ id: researchNotes.id })
    .from(researchNotes)
    .where(
      and(
        eq(researchNotes.workspaceId, workspaceId),
        inArray(researchNotes.id, [...noteIds])
      )
    );
  if (pickUnauthorizedNoteIds(noteIds, owned).length > 0) {
    throw new Error("현재 workspace에 속하지 않은 문서가 선택되었습니다.");
  }
  return owned;
}

export async function createResearchCollection(
  userId: number,
  name: string,
  description?: string
) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Collection 이름을 입력해 주세요.");
  const existing = (
    await db
      .select()
      .from(researchCollections)
      .where(
        and(
          eq(researchCollections.workspaceId, workspace.id),
          eq(researchCollections.name, cleanName)
        )
      )
      .limit(1)
  )[0];
  if (existing) return existing;
  const id = nanoid(16);
  await db.insert(researchCollections).values({
    id,
    workspaceId: workspace.id,
    name: cleanName,
    description: description?.trim() || null,
  });
  return (
    await db
      .select()
      .from(researchCollections)
      .where(eq(researchCollections.id, id))
      .limit(1)
  )[0];
}

export async function ingestMarkdownFiles(
  userId: number,
  files: IngestFileInput[],
  collectionId?: string
) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const inbox = await ensureInbox(db, workspace.id);
  const targetCollection = collectionId
    ? await assertCollection(db, collectionId, workspace.id)
    : inbox;
  const results: Array<Record<string, unknown>> = [];
  const parsedForMetrics: ParsedNote[] = [];
  let duplicateCount = 0;
  let failedCount = 0;
  let warningCount = 0;

  for (const file of files) {
    try {
      const sourcePath = normalizeRelativePath(file.name);
      if (!sourcePath.toLocaleLowerCase("en-US").endsWith(".md"))
        throw new Error("Markdown(.md) 파일만 업로드할 수 있습니다.");
      if (Buffer.byteLength(file.content, "utf8") > 700_000)
        throw new Error("파일 크기는 700KB 이하만 허용됩니다.");
      const parsed = parseMarkdownNote(sourcePath, file.content);
      let note = (
        await db
          .select()
          .from(researchNotes)
          .where(
            and(
              eq(researchNotes.workspaceId, workspace.id),
              eq(researchNotes.sourcePath, sourcePath)
            )
          )
          .limit(1)
      )[0];
      if (!note) {
        const noteId = nanoid(16);
        const storage = await storagePut(
          `${workspace.id}/notes/${noteId}/${parsed.contentHash}.md`,
          Buffer.from(file.content, "utf8"),
          "text/markdown; charset=utf-8"
        );
        await db.insert(researchNotes).values({
          id: noteId,
          workspaceId: workspace.id,
          sourcePath,
          externalId: parsed.externalId,
          title: parsed.title,
          visibility: "PRIVATE",
        });
        note = (
          await db
            .select()
            .from(researchNotes)
            .where(eq(researchNotes.id, noteId))
            .limit(1)
        )[0];
        if (!note) throw new Error("문서 레코드를 생성할 수 없습니다.");
        await saveVersion(db, note.id, parsed, storage.key);
      } else {
        const existingVersion = (
          await db
            .select()
            .from(researchNoteVersions)
            .where(
              and(
                eq(researchNoteVersions.noteId, note.id),
                eq(researchNoteVersions.contentHash, parsed.contentHash)
              )
            )
            .limit(1)
        )[0];
        if (existingVersion) {
          duplicateCount += 1;
          await ensureMembership(db, targetCollection.id, note.id);
          results.push({
            fileName: sourcePath,
            status: "duplicate",
            noteId: note.id,
            title: note.title,
            warnings: parseJson<string[]>(existingVersion.parseWarnings, []),
          });
          continue;
        }
        const storage = await storagePut(
          `${workspace.id}/notes/${note.id}/${parsed.contentHash}.md`,
          Buffer.from(file.content, "utf8"),
          "text/markdown; charset=utf-8"
        );
        await db
          .update(researchNotes)
          .set({
            title: parsed.title,
            externalId: parsed.externalId,
            sourcePath,
          })
          .where(eq(researchNotes.id, note.id));
        await saveVersion(db, note.id, parsed, storage.key);
      }
      await ensureMembership(db, targetCollection.id, note.id);
      parsedForMetrics.push(parsed);
      warningCount += parsed.warnings.length;
      results.push({
        fileName: sourcePath,
        status: "parsed",
        noteId: note.id,
        title: parsed.title,
        warnings: parsed.warnings,
        sectionCount: parsed.sections.length,
        linkCount: parsed.links.length,
        sectionPresence: parsed.sectionPresence,
      });
    } catch (error) {
      failedCount += 1;
      results.push({
        fileName: file.name,
        status: "failed",
        error:
          error instanceof Error ? error.message : "처리할 수 없는 파일 오류",
      });
    }
  }

  const library = await getNoteLibrary(userId, targetCollection.id);
  return {
    workspaceId: workspace.id,
    collectionId: targetCollection.id,
    results,
    metrics: {
      ...makeMetrics(
        parsedForMetrics,
        warningCount,
        duplicateCount,
        failedCount
      ),
      library: library.metrics,
    },
  };
}

async function saveVersion(
  db: Awaited<ReturnType<typeof requireDb>>,
  noteId: string,
  parsed: ParsedNote,
  storageKey: string
) {
  const versionId = nanoid(16);
  // Explicit sequence rather than insertion time: two uploads inside the same second are
  // indistinguishable by the second-precision createdAt column.
  const previous = await db
    .select({ versionNumber: researchNoteVersions.versionNumber })
    .from(researchNoteVersions)
    .where(eq(researchNoteVersions.noteId, noteId))
    .orderBy(desc(researchNoteVersions.versionNumber))
    .limit(1);
  const versionNumber = (previous[0]?.versionNumber ?? 0) + 1;
  await db.insert(researchNoteVersions).values({
    id: versionId,
    noteId,
    versionNumber,
    contentHash: parsed.contentHash,
    rawStorageKey: storageKey,
    parserVersion: NOTE_PARSER_VERSION,
    parsedMetadata: JSON.stringify({
      ...parsed.metadata,
      sourcePath: parsed.sourcePath,
      rawFrontmatter: parsed.rawFrontmatter,
    }),
    parseWarnings: JSON.stringify(parsed.warnings),
  });
  if (parsed.sections.length) {
    await db.insert(researchNoteSections).values(
      parsed.sections.map(section => ({
        id: nanoid(16),
        versionId,
        rawHeading: section.rawHeading,
        sectionType: section.sectionType,
        body: section.body || (section.explicitEmpty ? "없음" : ""),
        explicitEmpty: section.explicitEmpty,
        sectionOrder: section.sectionOrder,
      }))
    );
  }
  if (parsed.links.length) {
    await db.insert(researchNoteLinks).values(
      parsed.links.map(link => ({
        id: nanoid(16),
        versionId,
        linkType: link.linkType,
        target: link.target,
        label: link.label,
        sourceLocator: link.sourceLocator,
      }))
    );
  }
}

/**
 * Deletes a note and everything derived from it. Versions, sections, links and collection
 * membership cascade from the FK constraints; the raw Markdown in object storage does not,
 * because the Forge storage helpers expose put/get only. The orphaned keys are returned so
 * the caller can surface them until a delete helper exists.
 */
export async function deleteResearchNote(userId: number, noteId: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const note = (
    await db
      .select()
      .from(researchNotes)
      .where(
        and(
          eq(researchNotes.id, noteId),
          eq(researchNotes.workspaceId, workspace.id)
        )
      )
      .limit(1)
  )[0];
  if (!note) throw new Error("삭제할 문서를 찾을 수 없습니다.");
  const versions = await db
    .select()
    .from(researchNoteVersions)
    .where(eq(researchNoteVersions.noteId, note.id));

  // Delete the raw copies for real. Under the previous host this was impossible — the
  // storage helper had no delete — so the keys were only recorded for a purge that never
  // came. Anything that fails here is still recorded, so it stays on a worklist rather
  // than becoming an untracked leftover.
  const failed: string[] = [];
  for (const version of versions) {
    try {
      await storageDelete(version.rawStorageKey);
    } catch (error) {
      console.error("[Storage] 원문 삭제 실패", {
        key: version.rawStorageKey,
        error: error instanceof Error ? error.message : "unknown",
      });
      failed.push(version.rawStorageKey);
    }
  }
  if (failed.length) {
    await db.insert(deletedStorageObjects).values(
      failed.map(storageKey => ({
        id: nanoid(16),
        workspaceId: workspace.id,
        noteId: note.id,
        storageKey,
        reason: "NOTE_DELETED" as const,
      }))
    );
  }

  await db
    .delete(researchNotes)
    .where(
      and(
        eq(researchNotes.id, note.id),
        eq(researchNotes.workspaceId, workspace.id)
      )
    );
  return {
    noteId: note.id,
    title: note.title,
    deletedVersions: versions.length,
    /** Empty when every raw copy was actually removed. */
    orphanedStorageKeys: failed,
  };
}

/** Removes a collection without deleting its notes; the notes stay in the workspace library. */
export async function deleteResearchCollection(
  userId: number,
  collectionId: string
) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const collection = await assertCollection(db, collectionId, workspace.id);
  if (collection.name === "Inbox")
    throw new Error(
      "Inbox는 삭제할 수 없습니다. 문서를 먼저 다른 Collection으로 옮기세요."
    );
  const memberships = await db
    .select()
    .from(researchCollectionNotes)
    .where(eq(researchCollectionNotes.collectionId, collection.id));
  await db
    .delete(researchCollections)
    .where(
      and(
        eq(researchCollections.id, collection.id),
        eq(researchCollections.workspaceId, workspace.id)
      )
    );
  return {
    collectionId: collection.id,
    name: collection.name,
    releasedNotes: memberships.length,
  };
}

/** Detaches one note from one collection, leaving both in place. */
export async function removeNoteFromCollection(
  userId: number,
  collectionId: string,
  noteId: string
) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  await assertCollection(db, collectionId, workspace.id);
  await assertNotesInWorkspace(db, workspace.id, [noteId]);
  await db
    .delete(researchCollectionNotes)
    .where(
      and(
        eq(researchCollectionNotes.collectionId, collectionId),
        eq(researchCollectionNotes.noteId, noteId)
      )
    );
  return { collectionId, noteId };
}

/**
 * Storage keys recorded by a delete but not yet removed from object storage.
 * Surfaced by `pnpm storage:orphans` so leftovers stay visible until Forge exposes a delete.
 */
export async function listUnpurgedStorageObjects(limit = 200) {
  const db = await requireDb();
  return db
    .select()
    .from(deletedStorageObjects)
    .where(isNull(deletedStorageObjects.purgedAt))
    .orderBy(deletedStorageObjects.createdAt)
    .limit(limit);
}

/** Marks recorded keys as purged once they have actually been removed. */
export async function markStorageObjectsPurged(ids: string[]) {
  if (!ids.length) return { purged: 0 };
  const db = await requireDb();
  await db
    .update(deletedStorageObjects)
    .set({ purgedAt: new Date() })
    .where(inArray(deletedStorageObjects.id, ids));
  return { purged: ids.length };
}

export async function getResearchNoteSource(userId: number, noteId: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const note = (
    await db
      .select()
      .from(researchNotes)
      .where(
        and(
          eq(researchNotes.id, noteId),
          eq(researchNotes.workspaceId, workspace.id)
        )
      )
      .limit(1)
  )[0];
  if (!note) return undefined;
  const latest = (
    await db
      .select()
      .from(researchNoteVersions)
      .where(eq(researchNoteVersions.noteId, note.id))
      .orderBy(desc(researchNoteVersions.versionNumber))
      .limit(1)
  )[0];
  if (!latest)
    return {
      noteId: note.id,
      title: note.title,
      content: "",
      sourceVersionId: null,
    };
  const signedUrl = await storageGetSignedUrl(latest.rawStorageKey);
  const response = await fetch(signedUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("원문 Markdown을 불러올 수 없습니다.");
  return {
    noteId: note.id,
    title: note.title,
    content: await response.text(),
    sourceVersionId: latest.id,
  };
}

export async function getResearchNote(userId: number, noteId: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const note = (
    await db
      .select()
      .from(researchNotes)
      .where(
        and(
          eq(researchNotes.id, noteId),
          eq(researchNotes.workspaceId, workspace.id)
        )
      )
      .limit(1)
  )[0];
  if (!note) return undefined;
  const versions = await db
    .select()
    .from(researchNoteVersions)
    .where(eq(researchNoteVersions.noteId, note.id))
    .orderBy(desc(researchNoteVersions.versionNumber));
  const latest = versions[0];
  const sections = latest
    ? await db
        .select()
        .from(researchNoteSections)
        .where(eq(researchNoteSections.versionId, latest.id))
        .orderBy(researchNoteSections.sectionOrder)
    : [];
  const links = latest
    ? await db
        .select()
        .from(researchNoteLinks)
        .where(eq(researchNoteLinks.versionId, latest.id))
        .orderBy(researchNoteLinks.sourceLocator)
    : [];
  const memberships = await db
    .select()
    .from(researchCollectionNotes)
    .where(eq(researchCollectionNotes.noteId, note.id));
  const collectionIds = memberships.map(item => item.collectionId);
  const collections = collectionIds.length
    ? await db
        .select()
        .from(researchCollections)
        .where(
          and(
            eq(researchCollections.workspaceId, workspace.id),
            inArray(researchCollections.id, collectionIds)
          )
        )
    : [];
  return {
    ...note,
    versionCount: versions.length,
    versions: versions.map(version => ({
      id: version.id,
      contentHash: version.contentHash,
      parserVersion: version.parserVersion,
      createdAt: version.createdAt,
      warnings: parseJson<string[]>(version.parseWarnings, []),
    })),
    latestVersion: latest
      ? {
          id: latest.id,
          contentHash: latest.contentHash,
          parserVersion: latest.parserVersion,
          metadata: parseJson<Record<string, unknown>>(
            latest.parsedMetadata,
            {}
          ),
          warnings: parseJson<string[]>(latest.parseWarnings, []),
          sections,
          links,
        }
      : null,
    collections,
  };
}
