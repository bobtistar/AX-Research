import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  researchCollectionNotes,
  researchCollections,
  researchNoteSections,
  researchNoteLinks,
  researchNoteVersions,
  researchNotes,
  workspaces,
} from "../drizzle/schema";
import { getDb } from "./db";
import { storageGetSignedUrl, storagePut } from "./storage";
import {
  NOTE_PARSER_VERSION,
  NoteSectionType,
  ParsedNote,
  calculateSectionFillRates,
  normalizeRelativePath,
  parseMarkdownNote,
} from "./noteParser";

const FILL_RATE_TYPES: NoteSectionType[] = [
  "CLAIM",
  "SETTING",
  "AUTHOR_LIMITATIONS",
  "REVIEWER_CRITICISMS",
  "USER_OBSERVATIONS",
  "REPRODUCIBILITY",
  "USER_CONTEXT",
];

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
  const existing = (await db.select().from(workspaces).where(eq(workspaces.userId, userId)).limit(1))[0];
  if (existing) return { db, workspace: existing };
  const id = nanoid(16);
  try {
    await db.insert(workspaces).values({ id, userId, name: "Private Research Workspace" });
  } catch {
    const raced = (await db.select().from(workspaces).where(eq(workspaces.userId, userId)).limit(1))[0];
    if (raced) return { db, workspace: raced };
    throw new Error("사용자 workspace를 만들 수 없습니다.");
  }
  const created = (await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1))[0];
  if (!created) throw new Error("사용자 workspace 생성 결과를 확인할 수 없습니다.");
  return { db, workspace: created };
}

async function ensureInbox(db: Awaited<ReturnType<typeof requireDb>>, workspaceId: string) {
  const existing = (await db.select().from(researchCollections).where(and(eq(researchCollections.workspaceId, workspaceId), eq(researchCollections.name, "Inbox"))).limit(1))[0];
  if (existing) return existing;
  const id = nanoid(16);
  await db.insert(researchCollections).values({ id, workspaceId, name: "Inbox", description: "업로드한 Markdown이 처음 들어오는 private collection" });
  return (await db.select().from(researchCollections).where(eq(researchCollections.id, id)).limit(1))[0];
}

async function assertCollection(db: Awaited<ReturnType<typeof requireDb>>, collectionId: string, workspaceId: string) {
  const collection = (await db.select().from(researchCollections).where(and(eq(researchCollections.id, collectionId), eq(researchCollections.workspaceId, workspaceId))).limit(1))[0];
  if (!collection) throw new Error("현재 workspace에 속한 Collection이 아닙니다.");
  return collection;
}

async function ensureMembership(db: Awaited<ReturnType<typeof requireDb>>, collectionId: string, noteId: string) {
  const existing = (await db.select().from(researchCollectionNotes).where(and(eq(researchCollectionNotes.collectionId, collectionId), eq(researchCollectionNotes.noteId, noteId))).limit(1))[0];
  if (!existing) await db.insert(researchCollectionNotes).values({ collectionId, noteId });
}

function latestVersionMap<T extends { noteId: string }>(versions: T[]) {
  const map = new Map<string, T>();
  for (const version of versions) if (!map.has(version.noteId)) map.set(version.noteId, version);
  return map;
}

function makeMetrics(parsedNotes: Array<Pick<ParsedNote, "sectionPresence" | "explicitEmptySections">>, warningCount: number, duplicateCount = 0, failedCount = 0) {
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
  const collections = await db.select().from(researchCollections).where(eq(researchCollections.workspaceId, workspace.id)).orderBy(desc(researchCollections.updatedAt));
  const notes = await db.select().from(researchNotes).where(eq(researchNotes.workspaceId, workspace.id)).orderBy(desc(researchNotes.updatedAt));
  const memberships = notes.length ? await db.select().from(researchCollectionNotes).where(inArray(researchCollectionNotes.noteId, notes.map(note => note.id))) : [];
  const visibleNoteIds = collectionId
    ? new Set(memberships.filter(item => item.collectionId === collectionId).map(item => item.noteId))
    : new Set(notes.map(note => note.id));
  if (collectionId) await assertCollection(db, collectionId, workspace.id);
  const scopedNotes = notes.filter(note => visibleNoteIds.has(note.id));
  const versions = scopedNotes.length ? await db.select().from(researchNoteVersions).where(inArray(researchNoteVersions.noteId, scopedNotes.map(note => note.id))).orderBy(desc(researchNoteVersions.createdAt)) : [];
  const latest = latestVersionMap(versions);
  const parsedNotes = scopedNotes.map(note => {
    const version = latest.get(note.id);
    const metadata = version ? parseJson<Record<string, unknown>>(version.parsedMetadata, {}) : {};
    const warnings = version ? parseJson<string[]>(version.parseWarnings, []) : ["version_missing"];
    return {
      ...note,
      latestVersionId: version?.id ?? null,
      contentHash: version?.contentHash ?? null,
      parserVersion: version?.parserVersion ?? null,
      metadata,
      warnings,
      versionCount: versions.filter(item => item.noteId === note.id).length,
      collectionIds: memberships.filter(item => item.noteId === note.id).map(item => item.collectionId),
    };
  });
  const sectionRows = versions.length ? await db.select().from(researchNoteSections).where(inArray(researchNoteSections.versionId, versions.map(version => version.id))) : [];
  const parsedForMetrics = versions.map(version => {
    const sections = sectionRows.filter(section => section.versionId === version.id);
    return {
      sectionPresence: Object.fromEntries(FILL_RATE_TYPES.map(type => [type, sections.some(section => section.sectionType === type && (section.body.trim() || section.explicitEmpty))])) as ParsedNote["sectionPresence"],
      explicitEmptySections: sections.filter(section => section.explicitEmpty).map(section => section.sectionType),
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

export async function createResearchCollection(userId: number, name: string, description?: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Collection 이름을 입력해 주세요.");
  const existing = (await db.select().from(researchCollections).where(and(eq(researchCollections.workspaceId, workspace.id), eq(researchCollections.name, cleanName))).limit(1))[0];
  if (existing) return existing;
  const id = nanoid(16);
  await db.insert(researchCollections).values({ id, workspaceId: workspace.id, name: cleanName, description: description?.trim() || null });
  return (await db.select().from(researchCollections).where(eq(researchCollections.id, id)).limit(1))[0];
}

export async function ingestMarkdownFiles(userId: number, files: IngestFileInput[], collectionId?: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const inbox = await ensureInbox(db, workspace.id);
  const targetCollection = collectionId ? await assertCollection(db, collectionId, workspace.id) : inbox;
  const results: Array<Record<string, unknown>> = [];
  const parsedForMetrics: ParsedNote[] = [];
  let duplicateCount = 0;
  let failedCount = 0;
  let warningCount = 0;

  for (const file of files) {
    try {
      const sourcePath = normalizeRelativePath(file.name);
      if (!sourcePath.toLocaleLowerCase("en-US").endsWith(".md")) throw new Error("Markdown(.md) 파일만 업로드할 수 있습니다.");
      if (Buffer.byteLength(file.content, "utf8") > 700_000) throw new Error("파일 크기는 700KB 이하만 허용됩니다.");
      const parsed = parseMarkdownNote(sourcePath, file.content);
      let note = (await db.select().from(researchNotes).where(and(eq(researchNotes.workspaceId, workspace.id), eq(researchNotes.sourcePath, sourcePath))).limit(1))[0];
      if (!note) {
        const noteId = nanoid(16);
        const storage = await storagePut(`${workspace.id}/notes/${noteId}/${parsed.contentHash}.md`, Buffer.from(file.content, "utf8"), "text/markdown; charset=utf-8");
        await db.insert(researchNotes).values({ id: noteId, workspaceId: workspace.id, sourcePath, externalId: parsed.externalId, title: parsed.title, visibility: "PRIVATE" });
        note = (await db.select().from(researchNotes).where(eq(researchNotes.id, noteId)).limit(1))[0];
        if (!note) throw new Error("문서 레코드를 생성할 수 없습니다.");
        await saveVersion(db, note.id, parsed, storage.key);
      } else {
        const existingVersion = (await db.select().from(researchNoteVersions).where(and(eq(researchNoteVersions.noteId, note.id), eq(researchNoteVersions.contentHash, parsed.contentHash))).limit(1))[0];
        if (existingVersion) {
          duplicateCount += 1;
          await ensureMembership(db, targetCollection.id, note.id);
          results.push({ fileName: sourcePath, status: "duplicate", noteId: note.id, title: note.title, warnings: parseJson<string[]>(existingVersion.parseWarnings, []) });
          continue;
        }
        const storage = await storagePut(`${workspace.id}/notes/${note.id}/${parsed.contentHash}.md`, Buffer.from(file.content, "utf8"), "text/markdown; charset=utf-8");
        await db.update(researchNotes).set({ title: parsed.title, externalId: parsed.externalId, sourcePath }).where(eq(researchNotes.id, note.id));
        await saveVersion(db, note.id, parsed, storage.key);
      }
      await ensureMembership(db, targetCollection.id, note.id);
      parsedForMetrics.push(parsed);
      warningCount += parsed.warnings.length;
      results.push({ fileName: sourcePath, status: "parsed", noteId: note.id, title: parsed.title, warnings: parsed.warnings, sectionCount: parsed.sections.length, linkCount: parsed.links.length, sectionPresence: parsed.sectionPresence });
    } catch (error) {
      failedCount += 1;
      results.push({ fileName: file.name, status: "failed", error: error instanceof Error ? error.message : "처리할 수 없는 파일 오류" });
    }
  }

  const library = await getNoteLibrary(userId, targetCollection.id);
  return {
    workspaceId: workspace.id,
    collectionId: targetCollection.id,
    results,
    metrics: { ...makeMetrics(parsedForMetrics, warningCount, duplicateCount, failedCount), library: library.metrics },
  };
}

async function saveVersion(db: Awaited<ReturnType<typeof requireDb>>, noteId: string, parsed: ParsedNote, storageKey: string) {
  const versionId = nanoid(16);
  await db.insert(researchNoteVersions).values({
    id: versionId,
    noteId,
    contentHash: parsed.contentHash,
    rawStorageKey: storageKey,
    parserVersion: NOTE_PARSER_VERSION,
    parsedMetadata: JSON.stringify({ ...parsed.metadata, sourcePath: parsed.sourcePath, rawFrontmatter: parsed.rawFrontmatter }),
    parseWarnings: JSON.stringify(parsed.warnings),
  });
  if (parsed.sections.length) {
    await db.insert(researchNoteSections).values(parsed.sections.map(section => ({
      id: nanoid(16), versionId, rawHeading: section.rawHeading, sectionType: section.sectionType,
      body: section.body || (section.explicitEmpty ? "없음" : ""), explicitEmpty: section.explicitEmpty, sectionOrder: section.sectionOrder,
    })));
  }
  if (parsed.links.length) {
    await db.insert(researchNoteLinks).values(parsed.links.map(link => ({
      id: nanoid(16), versionId, linkType: link.linkType, target: link.target, label: link.label, sourceLocator: link.sourceLocator,
    })));
  }
}

export async function getResearchNoteSource(userId: number, noteId: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const note = (await db.select().from(researchNotes).where(and(eq(researchNotes.id, noteId), eq(researchNotes.workspaceId, workspace.id))).limit(1))[0];
  if (!note) return undefined;
  const latest = (await db.select().from(researchNoteVersions).where(eq(researchNoteVersions.noteId, note.id)).orderBy(desc(researchNoteVersions.createdAt)).limit(1))[0];
  if (!latest) return { noteId: note.id, title: note.title, content: "", sourceVersionId: null };
  const signedUrl = await storageGetSignedUrl(latest.rawStorageKey);
  const response = await fetch(signedUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("원문 Markdown을 불러올 수 없습니다.");
  return { noteId: note.id, title: note.title, content: await response.text(), sourceVersionId: latest.id };
}

export async function getResearchNote(userId: number, noteId: string) {
  const { db, workspace } = await getOrCreateWorkspace(userId);
  const note = (await db.select().from(researchNotes).where(and(eq(researchNotes.id, noteId), eq(researchNotes.workspaceId, workspace.id))).limit(1))[0];
  if (!note) return undefined;
  const versions = await db.select().from(researchNoteVersions).where(eq(researchNoteVersions.noteId, note.id)).orderBy(desc(researchNoteVersions.createdAt));
  const latest = versions[0];
  const sections = latest ? await db.select().from(researchNoteSections).where(eq(researchNoteSections.versionId, latest.id)).orderBy(researchNoteSections.sectionOrder) : [];
  const links = latest ? await db.select().from(researchNoteLinks).where(eq(researchNoteLinks.versionId, latest.id)).orderBy(researchNoteLinks.sourceLocator) : [];
  const memberships = await db.select().from(researchCollectionNotes).where(eq(researchCollectionNotes.noteId, note.id));
  const collectionIds = memberships.map(item => item.collectionId);
  const collections = collectionIds.length ? await db.select().from(researchCollections).where(and(eq(researchCollections.workspaceId, workspace.id), inArray(researchCollections.id, collectionIds))) : [];
  return {
    ...note,
    versionCount: versions.length,
    versions: versions.map(version => ({ id: version.id, contentHash: version.contentHash, parserVersion: version.parserVersion, createdAt: version.createdAt, warnings: parseJson<string[]>(version.parseWarnings, []) })),
    latestVersion: latest ? { id: latest.id, contentHash: latest.contentHash, parserVersion: latest.parserVersion, metadata: parseJson<Record<string, unknown>>(latest.parsedMetadata, {}), warnings: parseJson<string[]>(latest.parseWarnings, []), sections, links } : null,
    collections,
  };
}
