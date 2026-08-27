import { boolean, index, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

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
  /** Optional when a former authenticated workspace owns this run. New runs use guestKey. */
  userId: int("userId").references(() => users.id, { onDelete: "cascade" }),
  /** Browser-generated UUID; new guest runs always supply it, older authenticated runs remain preserved. */
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
}, table => [
  index("paper_candidates_run_idx").on(table.runId),
  index("paper_candidates_openalex_idx").on(table.openAlexId),
]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type ResearchRun = typeof researchRuns.$inferSelect;
export type ResearchQuery = typeof researchQueries.$inferSelect;
export type PaperCandidate = typeof paperCandidates.$inferSelect;
