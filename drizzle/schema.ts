import { boolean, foreignKey, index, int, mysqlEnum, mysqlTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/mysql-core";

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

export const researchRunStatus = ["DRAFT", "QUERIES_READY", "CANDIDATES_READY", "SEEDS_LOCKED", "FAILED"] as const;

export const researchRuns = mysqlTable("research_runs", {
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
}, table => [index("research_runs_guest_created_idx").on(table.guestKey, table.createdAt)]);

export const researchQueries = mysqlTable("research_queries", {
  id: varchar("id", { length: 32 }).primaryKey(),
  runId: varchar("runId", { length: 32 }).notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  position: int("position").notNull(),
  text: text("text").notNull(),
  status: mysqlEnum("status", ["PROPOSED", "CONFIRMED"]).default("PROPOSED").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("research_queries_run_position_idx").on(table.runId, table.position)]);

export const paperCandidates = mysqlTable("paper_candidates", {
  id: varchar("id", { length: 32 }).primaryKey(),
  runId: varchar("runId", { length: 32 }).notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
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
}, table => [index("paper_candidates_run_idx").on(table.runId), index("paper_candidates_openalex_idx").on(table.openAlexId)]);

export const workspaces = mysqlTable("workspaces", {
  id: varchar("id", { length: 32 }).primaryKey(),
  userId: int("userId").notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "ws_user_fk" }).onDelete("cascade")]);

export const researchCollections = mysqlTable("research_collections", {
  id: varchar("id", { length: 32 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("research_collections_workspace_idx").on(table.workspaceId),
  foreignKey({ columns: [table.workspaceId], foreignColumns: [workspaces.id], name: "rc_workspace_fk" }).onDelete("cascade"),
]);

export const researchNotes = mysqlTable("research_notes", {
  id: varchar("id", { length: 32 }).primaryKey(),
  workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
  sourcePath: varchar("sourcePath", { length: 512 }).notNull(),
  externalId: varchar("externalId", { length: 256 }),
  title: text("title").notNull(),
  visibility: mysqlEnum("visibility", ["PRIVATE"]).default("PRIVATE").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("research_notes_workspace_idx").on(table.workspaceId),
  index("research_notes_external_idx").on(table.workspaceId, table.externalId),
  foreignKey({ columns: [table.workspaceId], foreignColumns: [workspaces.id], name: "rn_workspace_fk" }).onDelete("cascade"),
]);

export const researchNoteVersions = mysqlTable("research_note_versions", {
  id: varchar("id", { length: 32 }).primaryKey(),
  noteId: varchar("noteId", { length: 32 }).notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  rawStorageKey: varchar("rawStorageKey", { length: 512 }).notNull(),
  parserVersion: varchar("parserVersion", { length: 32 }).notNull(),
  parsedMetadata: text("parsedMetadata").notNull(),
  parseWarnings: text("parseWarnings").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("research_note_versions_note_idx").on(table.noteId),
  index("research_note_versions_hash_idx").on(table.noteId, table.contentHash),
  foreignKey({ columns: [table.noteId], foreignColumns: [researchNotes.id], name: "rnv_note_fk" }).onDelete("cascade"),
]);

export const researchNoteSections = mysqlTable("research_note_sections", {
  id: varchar("id", { length: 32 }).primaryKey(),
  versionId: varchar("versionId", { length: 32 }).notNull(),
  rawHeading: varchar("rawHeading", { length: 255 }).notNull(),
  sectionType: mysqlEnum("sectionType", ["FRONTMATTER", "CLAIM", "SETTING", "AUTHOR_LIMITATIONS", "REVIEWER_CRITICISMS", "USER_OBSERVATIONS", "USER_CONTEXT", "REPRODUCIBILITY", "UNKNOWN"]).notNull(),
  body: text("body").notNull(),
  explicitEmpty: boolean("explicitEmpty").default(false).notNull(),
  sectionOrder: int("sectionOrder").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("research_note_sections_version_idx").on(table.versionId),
  foreignKey({ columns: [table.versionId], foreignColumns: [researchNoteVersions.id], name: "rns_version_fk" }).onDelete("cascade"),
]);

export const researchNoteLinks = mysqlTable("research_note_links", {
  id: varchar("id", { length: 32 }).primaryKey(),
  versionId: varchar("versionId", { length: 32 }).notNull(),
  linkType: mysqlEnum("linkType", ["WIKILINK", "MARKDOWN_URL", "IDENTIFIER"]).notNull(),
  target: varchar("target", { length: 1_024 }).notNull(),
  label: text("label"),
  sourceLocator: varchar("sourceLocator", { length: 255 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("research_note_links_version_idx").on(table.versionId),
  foreignKey({ columns: [table.versionId], foreignColumns: [researchNoteVersions.id], name: "rnl_version_fk" }).onDelete("cascade"),
]);

export const researchCollectionNotes = mysqlTable("research_collection_notes", {
  collectionId: varchar("collectionId", { length: 32 }).notNull(),
  noteId: varchar("noteId", { length: 32 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  primaryKey({ columns: [table.collectionId, table.noteId] }),
  index("research_collection_notes_note_idx").on(table.noteId),
  foreignKey({ columns: [table.collectionId], foreignColumns: [researchCollections.id], name: "rcn_collection_fk" }).onDelete("cascade"),
  foreignKey({ columns: [table.noteId], foreignColumns: [researchNotes.id], name: "rcn_note_fk" }).onDelete("cascade"),
]);

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
export type ResearchCollectionNote = typeof researchCollectionNotes.$inferSelect;
