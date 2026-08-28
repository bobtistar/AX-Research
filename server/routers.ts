import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createResearchRun, getResearchRun, listResearchRuns, lockSeeds, persistSearchResults, replaceQueries } from "./db";
import { createResearchCollection, getNoteLibrary, getResearchNote, getResearchNoteSource, ingestMarkdownFiles } from "./noteDb";
import { searchOpenAlex, toCandidateDraft, TOP_TIER_VENUES } from "./seedService";

const topicInput = z.string().trim().min(3, "주제는 세 글자 이상 입력해 주세요.").max(500);
const runIdInput = z.string().min(8).max(32);
const guestKeyInput = z.string().uuid("유효한 게스트 워크스페이스 키가 필요합니다.");
const noteIdInput = z.string().min(8).max(32);
const collectionIdInput = z.string().min(8).max(32);
const noteFileInput = z.object({
  name: z.string().trim().min(1).max(512),
  content: z.string().max(700_000, "파일 크기는 700KB 이하만 허용됩니다."),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  seed: router({
    venues: publicProcedure.query(() => TOP_TIER_VENUES.map(({ code, label }) => ({ code, label }))),
    listRuns: publicProcedure.input(z.object({ guestKey: guestKeyInput })).query(({ input }) => listResearchRuns(input.guestKey)),
    getRun: publicProcedure.input(z.object({ runId: runIdInput, guestKey: guestKeyInput })).query(({ input }) => getResearchRun(input.guestKey, input.runId)),
    createRun: publicProcedure.input(z.object({ guestKey: guestKeyInput, topic: topicInput, desiredSeedCount: z.number().int().min(5).max(10) })).mutation(async ({ input }) => {
      const id = await createResearchRun(input.guestKey, input.topic, input.desiredSeedCount);
      return { id };
    }),
    confirmQueries: publicProcedure.input(z.object({ guestKey: guestKeyInput, runId: runIdInput, queries: z.array(topicInput).min(3, "검색 질의는 3개 이상이어야 합니다.").max(5, "검색 질의는 5개까지 허용됩니다.") })).mutation(async ({ input }) => {
      const normalized = input.queries.map(query => query.trim()).filter(Boolean);
      if (new Set(normalized.map(query => query.toLowerCase())).size !== normalized.length) throw new Error("같은 검색 질의가 중복되어 있습니다.");
      return replaceQueries(input.guestKey, input.runId, normalized);
    }),
    searchCandidates: publicProcedure.input(z.object({ guestKey: guestKeyInput, runId: runIdInput })).mutation(async ({ input }) => {
      const run = await getResearchRun(input.guestKey, input.runId);
      if (!run) throw new Error("실행 이력을 찾을 수 없습니다.");
      if (run.status === "DRAFT") throw new Error("먼저 3–5개 검색 질의를 확정해 주세요.");
      if (run.status === "SEEDS_LOCKED") throw new Error("Seed가 이미 고정된 실행입니다.");

      const byPaper = new Map<string, ReturnType<typeof toCandidateDraft> & { provenance: string[] }>();
      let totalRetrieved = 0;
      let venueExcluded = 0;
      let duplicatesRemoved = 0;
      let failureCount = 0;
      for (const query of run.queries) {
        try {
          const works = await searchOpenAlex(query.text);
          totalRetrieved += works.length;
          for (const work of works) {
            const draft = toCandidateDraft(work);
            if (!draft) {
              venueExcluded += 1;
              continue;
            }
            const identity = draft.doi ? `doi:${draft.doi.toLowerCase()}` : `openalex:${draft.openAlexId}`;
            const prior = byPaper.get(identity);
            if (prior) {
              prior.provenance.push(query.text);
              duplicatesRemoved += 1;
              continue;
            }
            byPaper.set(identity, { ...draft, provenance: [query.text] });
          }
        } catch (error) {
          console.warn("[Seed search] query failed", { query: query.text, error: error instanceof Error ? error.message : "unknown" });
          failureCount += 1;
        }
      }
      const drafts = Array.from(byPaper.values()).filter((draft): draft is NonNullable<typeof draft> => Boolean(draft)).sort((a, b) => b.citedByCount - a.citedByCount);
      return persistSearchResults(input.guestKey, input.runId, drafts, { totalRetrieved, venueExcluded, duplicatesRemoved, failureCount });
    }),
    lockSeeds: publicProcedure.input(z.object({ guestKey: guestKeyInput, runId: runIdInput, candidateIds: z.array(z.string().min(8)).min(5).max(10) })).mutation(({ input }) => lockSeeds(input.guestKey, input.runId, Array.from(new Set(input.candidateIds)))),
  }),
  notes: router({
    library: protectedProcedure.input(z.object({ collectionId: collectionIdInput.optional() })).query(({ ctx, input }) => getNoteLibrary(ctx.user.id, input.collectionId)),
    get: protectedProcedure.input(z.object({ noteId: noteIdInput })).query(({ ctx, input }) => getResearchNote(ctx.user.id, input.noteId)),
    source: protectedProcedure.input(z.object({ noteId: noteIdInput })).query(({ ctx, input }) => getResearchNoteSource(ctx.user.id, input.noteId)),
    createCollection: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(2_000).optional() })).mutation(({ ctx, input }) => createResearchCollection(ctx.user.id, input.name, input.description)),
    ingest: protectedProcedure.input(z.object({ collectionId: collectionIdInput.optional(), files: z.array(noteFileInput).min(1, "Markdown 파일을 하나 이상 선택해 주세요.").max(20, "한 번에 20개 파일까지 업로드할 수 있습니다.") }).superRefine((input, context) => {
      const totalBytes = input.files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
      if (totalBytes > 4_000_000) context.addIssue({ code: "custom", path: ["files"], message: "한 번에 4MB까지 업로드할 수 있습니다." });
    })).mutation(({ ctx, input }) => ingestMarkdownFiles(ctx.user.id, input.files, input.collectionId)),
  }),
});

export type AppRouter = typeof appRouter;
