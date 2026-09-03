import {
  boolean,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** Core user table backing the Manus OAuth flow. */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const researchRunStatus = [
  "DRAFT",
  "QUERIES_READY",
  "CANDIDATES_READY",
  "SEEDS_LOCKED",
  "FAILED",
] as const;

export const researchRuns = mysqlTable(
  "research_runs",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    userId: int("userId").references(() => users.id, { onDelete: "cascade" }),
    guestKey: varchar("guestKey", { length: 64 }),
    topic: text("topic").notNull(),
    desiredSeedCount: int("desiredSeedCount").notNull(),
    status: mysqlEnum("status", researchRunStatus).default("DRAFT").notNull(),
    queryCount: int("queryCount").default(0).notNull(),
    candidateCount: int("candidateCount").default(0).notNull(),
    seedCount: int("seedCount").default(0).notNull(),
    totalRetrieved: int("totalRetrieved").default(0).notNull(),
    venueExcluded: int("venueExcluded").default(0).notNull(),
    duplicatesRemoved: int("duplicatesRemoved").default(0).notNull(),
    failureCount: int("failureCount").default(0).notNull(),
    errorMessage: text("errorMessage"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("research_runs_guest_created_idx").on(
      table.guestKey,
      table.createdAt
    ),
  ]
);

export const researchQueries = mysqlTable(
  "research_queries",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    runId: varchar("runId", { length: 32 })
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    position: int("position").notNull(),
    text: text("text").notNull(),
    status: mysqlEnum("status", ["PROPOSED", "CONFIRMED"])
      .default("PROPOSED")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("research_queries_run_position_idx").on(table.runId, table.position),
  ]
);

export const paperCandidates = mysqlTable(
  "paper_candidates",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    runId: varchar("runId", { length: 32 })
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    openAlexId: varchar("openAlexId", { length: 128 }).notNull(),
    doi: varchar("doi", { length: 512 }),
    title: text("title").notNull(),
    venue: varchar("venue", { length: 256 }).notNull(),
    venueCode: varchar("venueCode", { length: 24 }).notNull(),
    year: int("year"),
    citedByCount: int("citedByCount").default(0).notNull(),
    sourceUrl: text("sourceUrl").notNull(),
    provenance: text("provenance").notNull(),
    isEligible: boolean("isEligible").default(true).notNull(),
    isSeed: boolean("isSeed").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("paper_candidates_run_idx").on(table.runId),
    index("paper_candidates_openalex_idx").on(table.openAlexId),
  ]
);

export const workspaces = mysqlTable(
  "workspaces",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    userId: int("userId").notNull().unique(),
    name: varchar("name", { length: 160 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "ws_user_fk",
    }).onDelete("cascade"),
  ]
);

/**
 * A user's own Gemini key (BYOK) and their usage against the plan.
 *
 * Bring-your-own-key exists so the free tier cannot run up the operator's bill: a user on
 * their own key is metered for visibility but never charged against the shared quota.
 *
 * The key is stored encrypted at rest — see server/_core/secrets.ts. It is never returned
 * to the client; only whether one is present and its last four characters.
 */
export const userSettings = mysqlTable(
  "user_settings",
  {
    userId: int("userId").primaryKey(),
    /** AES-GCM ciphertext of the user's Gemini key, or null when they use the shared one. */
    geminiKeyCipher: text("geminiKeyCipher"),
    /** Shown in the UI so a user can tell which key they saved. */
    geminiKeyHint: varchar("geminiKeyHint", { length: 8 }),
    plan: mysqlEnum("plan", ["FREE", "PRO"]).default("FREE").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "us_user_fk",
    }).onDelete("cascade"),
  ]
);

/**
 * One row per inference call, for quota accounting.
 *
 * Kept separate from research_inference_runs because a run can be deleted while its cost
 * must still count against the month it was spent in, and because a call that failed
 * before producing a run still consumed budget.
 */
export const inferenceUsage = mysqlTable(
  "inference_usage",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    userId: int("userId").notNull(),
    /** UTC month bucket, `YYYY-MM`, so a quota check is one indexed lookup. */
    period: varchar("period", { length: 7 }).notNull(),
    /** False when the user supplied their own key, which the operator does not pay for. */
    billedToOperator: boolean("billedToOperator").default(true).notNull(),
    model: varchar("model", { length: 160 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("inference_usage_user_period_idx").on(
      table.userId,
      table.period,
      table.billedToOperator
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "iu_user_fk",
    }).onDelete("cascade"),
  ]
);

export const researchCollections = mysqlTable(
  "research_collections",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("research_collections_workspace_idx").on(table.workspaceId),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "rc_workspace_fk",
    }).onDelete("cascade"),
  ]
);

export const researchNotes = mysqlTable(
  "research_notes",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
    sourcePath: varchar("sourcePath", { length: 512 }).notNull(),
    externalId: varchar("externalId", { length: 256 }),
    title: text("title").notNull(),
    visibility: mysqlEnum("visibility", ["PRIVATE"])
      .default("PRIVATE")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("research_notes_workspace_idx").on(table.workspaceId),
    index("research_notes_external_idx").on(
      table.workspaceId,
      table.externalId
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "rn_workspace_fk",
    }).onDelete("cascade"),
  ]
);

export const researchNoteVersions = mysqlTable(
  "research_note_versions",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    noteId: varchar("noteId", { length: 32 }).notNull(),
    /**
     * 1-based position in this note's history. `createdAt` is a second-precision TIMESTAMP,
     * so two uploads inside the same second left "which version is current" undefined —
     * and five call sites decided exactly that by ordering on it. Order by this instead.
     * It is also what a reader wants to see: "v3", not a hash.
     */
    versionNumber: int("versionNumber").default(1).notNull(),
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    rawStorageKey: varchar("rawStorageKey", { length: 512 }).notNull(),
    parserVersion: varchar("parserVersion", { length: 32 }).notNull(),
    parsedMetadata: text("parsedMetadata").notNull(),
    parseWarnings: text("parseWarnings").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("research_note_versions_note_idx").on(table.noteId),
    uniqueIndex("research_note_versions_number_idx").on(
      table.noteId,
      table.versionNumber
    ),
    index("research_note_versions_hash_idx").on(
      table.noteId,
      table.contentHash
    ),
    foreignKey({
      columns: [table.noteId],
      foreignColumns: [researchNotes.id],
      name: "rnv_note_fk",
    }).onDelete("cascade"),
  ]
);

export const researchNoteSections = mysqlTable(
  "research_note_sections",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    versionId: varchar("versionId", { length: 32 }).notNull(),
    rawHeading: varchar("rawHeading", { length: 255 }).notNull(),
    sectionType: mysqlEnum("sectionType", [
      "FRONTMATTER",
      "CLAIM",
      "SETTING",
      "AUTHOR_LIMITATIONS",
      "REVIEWER_CRITICISMS",
      "USER_OBSERVATIONS",
      "USER_CONTEXT",
      "REPRODUCIBILITY",
      "UNKNOWN",
    ]).notNull(),
    body: text("body").notNull(),
    explicitEmpty: boolean("explicitEmpty").default(false).notNull(),
    sectionOrder: int("sectionOrder").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("research_note_sections_version_idx").on(table.versionId),
    foreignKey({
      columns: [table.versionId],
      foreignColumns: [researchNoteVersions.id],
      name: "rns_version_fk",
    }).onDelete("cascade"),
  ]
);

export const researchNoteLinks = mysqlTable(
  "research_note_links",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    versionId: varchar("versionId", { length: 32 }).notNull(),
    linkType: mysqlEnum("linkType", [
      "WIKILINK",
      "MARKDOWN_URL",
      "IDENTIFIER",
    ]).notNull(),
    target: varchar("target", { length: 1_024 }).notNull(),
    label: text("label"),
    sourceLocator: varchar("sourceLocator", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("research_note_links_version_idx").on(table.versionId),
    foreignKey({
      columns: [table.versionId],
      foreignColumns: [researchNoteVersions.id],
      name: "rnl_version_fk",
    }).onDelete("cascade"),
  ]
);

/**
 * How the run itself ended. Deliberately excludes staleness: whether a run's notes have
 * since changed is a property of the notes, not the run, so it changes without the run
 * changing and is computed on read (`computeStaleness`). A stored STALE value was never
 * set by anything and would have been wrong the moment the next note was uploaded.
 */
export const inferenceRunStatus = [
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
] as const;

export const researchInferenceRuns = mysqlTable(
  "research_inference_runs",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
    question: text("question").notNull(),
    noteVersionIds: text("noteVersionIds").notNull(),
    model: varchar("model", { length: 160 }).notNull(),
    promptVersion: varchar("promptVersion", { length: 32 }).notNull(),
    status: mysqlEnum("status", inferenceRunStatus)
      .default("RUNNING")
      .notNull(),
    resultJson: text("resultJson"),
    evidenceCount: int("evidenceCount").default(0).notNull(),
    missingCount: int("missingCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("inference_runs_workspace_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "rir_workspace_fk",
    }).onDelete("cascade"),
  ]
);

export const inferenceReviewTarget = ["CLAIM", "MISSING"] as const;
export const inferenceReviewVerdict = ["APPROVED", "REJECTED"] as const;

/**
 * A human verdict on one cell of an inference run: either a claim the model made, or a
 * section the server reported as missing. One row per (run, kind, note, section) so a
 * reviewer who changes their mind updates the label instead of appending a second one.
 *
 * The reviewed run already records model, promptVersion and note versions, but they are
 * copied here as well: a label is only meaningful for the exact inputs it was given, and a
 * later re-upload or prompt bump must leave old labels visibly attached to the old inputs
 * rather than silently inheriting the new ones.
 */
export const researchInferenceReviews = mysqlTable(
  "research_inference_reviews",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
    runId: varchar("runId", { length: 32 }).notNull(),
    targetKind: mysqlEnum("targetKind", inferenceReviewTarget).notNull(),
    noteId: varchar("noteId", { length: 32 }).notNull(),
    sectionType: varchar("sectionType", { length: 32 }).notNull(),
    verdict: mysqlEnum("verdict", inferenceReviewVerdict).notNull(),
    /** What the reviewer says the answer should have been, quoted from the note verbatim. */
    correctedQuote: text("correctedQuote"),
    reviewerNote: text("reviewerNote"),
    sourceVersionIds: text("sourceVersionIds").notNull(),
    promptVersion: varchar("promptVersion", { length: 32 }).notNull(),
    model: varchar("model", { length: 160 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("inference_reviews_cell_idx").on(
      table.runId,
      table.targetKind,
      table.noteId,
      table.sectionType
    ),
    index("inference_reviews_workspace_idx").on(
      table.workspaceId,
      table.createdAt
    ),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
      name: "rirev_workspace_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [researchInferenceRuns.id],
      name: "rirev_run_fk",
    }).onDelete("cascade"),
  ]
);

/**
 * Object storage keys whose owning note is gone. The Forge storage helpers expose put and
 * presign only, so deleting a note cannot remove its raw Markdown copy; recording the key
 * keeps the leftover auditable and gives a purge worklist once a delete path exists.
 *
 * Deliberately carries no foreign key: the note is already deleted, and the row must
 * outlive its workspace so a deleted account's copies remain purgeable.
 */
export const deletedStorageObjects = mysqlTable(
  "deleted_storage_objects",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
    noteId: varchar("noteId", { length: 32 }).notNull(),
    storageKey: varchar("storageKey", { length: 512 }).notNull(),
    reason: mysqlEnum("reason", ["NOTE_DELETED", "COLLECTION_DELETED"])
      .default("NOTE_DELETED")
      .notNull(),
    purgedAt: timestamp("purgedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("deleted_storage_objects_purged_idx").on(
      table.purgedAt,
      table.createdAt
    ),
    index("deleted_storage_objects_workspace_idx").on(table.workspaceId),
  ]
);

export const researchCollectionNotes = mysqlTable(
  "research_collection_notes",
  {
    collectionId: varchar("collectionId", { length: 32 }).notNull(),
    noteId: varchar("noteId", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    primaryKey({ columns: [table.collectionId, table.noteId] }),
    index("research_collection_notes_note_idx").on(table.noteId),
    foreignKey({
      columns: [table.collectionId],
      foreignColumns: [researchCollections.id],
      name: "rcn_collection_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.noteId],
      foreignColumns: [researchNotes.id],
      name: "rcn_note_fk",
    }).onDelete("cascade"),
  ]
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type ResearchRun = typeof researchRuns.$inferSelect;
export type ResearchQuery = typeof researchQueries.$inferSelect;
export type PaperCandidate = typeof paperCandidates.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type ResearchCollection = typeof researchCollections.$inferSelect;
export type ResearchNote = typeof researchNotes.$inferSelect;
export type ResearchNoteVersion = typeof researchNoteVersions.$inferSelect;
export type ResearchNoteSection = typeof researchNoteSections.$inferSelect;
export type ResearchNoteLink = typeof researchNoteLinks.$inferSelect;
export type ResearchCollectionNote =
  typeof researchCollectionNotes.$inferSelect;
export type ResearchInferenceRun = typeof researchInferenceRuns.$inferSelect;
export type DeletedStorageObject = typeof deletedStorageObjects.$inferSelect;
