import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import NoteLibraryView from "@/components/NoteLibraryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  ExternalLink,
  FileSearch,
  LockKeyhole,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type QueryDraft = { id: string; text: string };

const GUEST_KEY_STORAGE = "research-collector-guest-key";

function getGuestKey(): string {
  const existing = window.localStorage.getItem(GUEST_KEY_STORAGE);
  if (existing) return existing;
  const key = window.crypto.randomUUID();
  window.localStorage.setItem(GUEST_KEY_STORAGE, key);
  return key;
}

/**
 * The Obsidian vault stays the canonical source, so a locked seed set leaves as files the
 * user drops in themselves. The app never writes into the vault.
 */
function downloadMarkdownFiles(
  files: Array<{ fileName: string; content: string }>
) {
  files.forEach((file, index) => {
    const url = URL.createObjectURL(
      new Blob([file.content], { type: "text/markdown;charset=utf-8" })
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.fileName;
    // Browsers throttle bursts of programmatic downloads; stagger them slightly.
    window.setTimeout(() => {
      anchor.click();
      URL.revokeObjectURL(url);
    }, index * 150);
  });
}

const statusLabel: Record<string, string> = {
  DRAFT: "질의 검토 대기",
  QUERIES_READY: "검색 준비 완료",
  CANDIDATES_READY: "후보 검토 중",
  SEEDS_LOCKED: "seed 고정 완료",
  FAILED: "검증 필요",
};

function BlockHeading({
  eyebrow,
  children,
  action,
}: {
  eyebrow: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/15 pb-4">
      <div>
        <p className="meta-face text-[10px] text-zinc-500">{eyebrow}</p>
        <h2 className="mt-2 text-xl font-extrabold tracking-tight text-white">
          {children}
        </h2>
      </div>
      {action}
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix?: string;
}) {
  return (
    <div className="border-l border-zinc-600 pl-3">
      <p className="meta-face text-[9px] text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold tabular-nums text-zinc-100">
        {value}
        <span className="ml-1 text-xs font-medium text-zinc-500">{suffix}</span>
      </p>
    </div>
  );
}

export default function Home() {
  const { user, loading: authLoading, logout } = useAuth();
  const [guestKey] = useState(getGuestKey);
  const [view, setView] = useState<"seed" | "library">("seed");
  const utils = trpc.useUtils();
  const { data: venues = [] } = trpc.seed.venues.useQuery();
  const { data: runs = [] } = trpc.seed.listRuns.useQuery({ guestKey });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { data: run, isFetching: runLoading } = trpc.seed.getRun.useQuery(
    { runId: selectedRunId ?? "none", guestKey },
    { enabled: Boolean(selectedRunId) }
  );
  const [topic, setTopic] = useState("time-series conformal prediction");
  const [desiredSeedCount, setDesiredSeedCount] = useState(8);
  const [draftQueries, setDraftQueries] = useState<QueryDraft[]>([]);
  const [selectedSeeds, setSelectedSeeds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);
  useEffect(() => {
    if (run) {
      setDraftQueries(
        run.queries.map(query => ({ id: query.id, text: query.text }))
      );
      setSelectedSeeds(
        new Set(
          run.candidates
            .filter(candidate => candidate.isSeed)
            .map(candidate => candidate.id)
        )
      );
    }
  }, [run?.id, run?.updatedAt]);

  const refresh = async () => {
    await Promise.all([
      utils.seed.listRuns.invalidate({ guestKey }),
      selectedRunId
        ? utils.seed.getRun.invalidate({ runId: selectedRunId, guestKey })
        : Promise.resolve(),
    ]);
  };
  const createRun = trpc.seed.createRun.useMutation({
    onSuccess: async ({ id }) => {
      setSelectedRunId(id);
      await utils.seed.listRuns.invalidate();
      toast.success("실행을 만들고 5개의 검토용 질의를 제안했습니다.");
    },
    onError: error => toast.error(error.message),
  });
  const confirmQueries = trpc.seed.confirmQueries.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("검색 질의를 확정했습니다.");
    },
    onError: error => toast.error(error.message),
  });
  const searchCandidates = trpc.seed.searchCandidates.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("top-tier 후보 검색을 마쳤습니다.");
    },
    onError: error => toast.error(error.message),
  });
  const exportSeedNotes = async () => {
    if (!run) return;
    try {
      const bundle = await utils.seed.exportSeedNotes.fetch({
        guestKey,
        runId: run.id,
      });
      downloadMarkdownFiles(bundle.files);
      toast.success(
        `${bundle.files.length}개 노트를 내려받습니다. Obsidian vault에 넣고 각 section을 직접 채우세요.`
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "노트를 내보내지 못했습니다."
      );
    }
  };
  const claimRuns = trpc.seed.claimRuns.useMutation({
    onSuccess: async ({ claimed }) => {
      await utils.seed.listRuns.invalidate({ guestKey });
      toast.success(
        claimed > 0
          ? `실행 ${claimed}건을 계정으로 옮겼습니다. 이제 브라우저 저장소와 무관하게 유지됩니다.`
          : "이 브라우저에 계정으로 옮길 실행 이력이 없습니다."
      );
    },
    onError: error => toast.error(error.message),
  });
  const deleteRun = trpc.seed.deleteRun.useMutation({
    onSuccess: async ({ runId }) => {
      if (selectedRunId === runId) setSelectedRunId(null);
      await utils.seed.listRuns.invalidate({ guestKey });
      toast.success("실행 이력을 삭제했습니다.");
    },
    onError: error => toast.error(error.message),
  });
  const lockSeeds = trpc.seed.lockSeeds.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("Seed가 고정되었습니다. 후속 모듈은 아직 잠겨 있습니다.");
    },
    onError: error => toast.error(error.message),
  });

  const queryValid =
    draftQueries.length >= 3 &&
    draftQueries.length <= 5 &&
    draftQueries.every(query => query.text.trim().length >= 3);
  const selectedCount = selectedSeeds.size;
  const canLock =
    run?.status === "CANDIDATES_READY" &&
    selectedCount === run.desiredSeedCount;
  const runMetrics = run ?? {
    totalRetrieved: 0,
    candidateCount: 0,
    venueExcluded: 0,
    duplicatesRemoved: 0,
    failureCount: 0,
  };
  const stage =
    run?.status === "SEEDS_LOCKED"
      ? 4
      : run?.status === "CANDIDATES_READY"
        ? 3
        : run?.status === "QUERIES_READY"
          ? 2
          : 1;
  const currentRunSummary = useMemo(
    () =>
      run
        ? `${run.topic.slice(0, 30)}${run.topic.length > 30 ? "…" : ""}`
        : "새 실행을 시작하세요",
    [run]
  );

  const addQuery = () =>
    setDraftQueries(previous =>
      previous.length >= 5
        ? previous
        : [...previous, { id: `local-${Date.now()}`, text: "" }]
    );
  const removeQuery = (id: string) =>
    setDraftQueries(previous =>
      previous.length <= 3
        ? previous
        : previous.filter(query => query.id !== id)
    );
  const changeQuery = (id: string, text: string) =>
    setDraftQueries(previous =>
      previous.map(query => (query.id === id ? { ...query, text } : query))
    );
  const toggleSeed = (id: string) =>
    setSelectedSeeds(previous => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <main className="industrial-grid min-h-screen bg-[#101010] text-zinc-100">
      <header className="border-b border-zinc-700 bg-zinc-950/90 px-4 py-4 backdrop-blur md:px-8">
        <div className="mx-auto flex max-w-[1520px] items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="grid h-9 w-9 place-items-center bg-zinc-100 text-xs font-black text-zinc-950">
              SF
            </div>
            <div>
              <p className="meta-face text-[9px] text-zinc-500">
                RESEARCH COLLECTOR // MODULE 01
              </p>
              <p className="text-sm font-extrabold tracking-tight">
                SEED FOUNDRY
              </p>
            </div>
            <div className="ml-2 hidden items-center gap-1 border-l border-zinc-700 pl-3 sm:flex">
              <button
                onClick={() => setView("seed")}
                className={cn(
                  "px-2 py-1 text-[10px] font-black transition-colors",
                  view === "seed"
                    ? "bg-zinc-100 text-zinc-950"
                    : "text-zinc-500 hover:text-zinc-200"
                )}
              >
                SEEDS
              </button>
              <button
                onClick={() => setView("library")}
                className={cn(
                  "px-2 py-1 text-[10px] font-black transition-colors",
                  view === "library"
                    ? "bg-zinc-100 text-zinc-950"
                    : "text-zinc-500 hover:text-zinc-200"
                )}
              >
                NOTES
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-3 md:flex">
              <span className="meta-face text-[10px] text-zinc-500">
                WORKSPACE
              </span>
              <span className="max-w-[180px] truncate text-xs font-bold text-zinc-300">
                {user
                  ? (user.email ?? user.name ?? "SIGNED IN")
                  : `GUEST / ${guestKey.slice(0, 8).toUpperCase()}`}
              </span>
              <span
                className={cn(
                  "h-2 w-2",
                  user ? "bg-zinc-200" : "border border-zinc-600"
                )}
              />
            </div>
            {/*
              Signed-out is the default state and has to be visible: notes, inference and
              review all sit behind an account, so a visitor who cannot see a way in has no
              way to reach any of it.
            */}
            {authLoading ? (
              <span className="meta-face text-[10px] text-zinc-600">···</span>
            ) : user ? (
              <button
                onClick={() => void logout()}
                className="border border-zinc-700 px-3 py-1.5 font-mono text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
              >
                로그아웃
              </button>
            ) : (
              <button
                onClick={() => startLogin()}
                className="bg-zinc-100 px-3 py-1.5 font-mono text-[10px] font-black text-zinc-950 transition-colors hover:bg-zinc-300"
              >
                Google로 로그인
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex justify-center border-b border-zinc-800 bg-zinc-950/70 px-4 py-2 sm:hidden">
        <div className="flex w-full max-w-sm gap-1">
          <button
            onClick={() => setView("seed")}
            className={cn(
              "flex-1 py-2 text-[10px] font-black",
              view === "seed"
                ? "bg-zinc-100 text-zinc-950"
                : "bg-zinc-900 text-zinc-500"
            )}
          >
            SEED FOUNDRY
          </button>
          <button
            onClick={() => setView("library")}
            className={cn(
              "flex-1 py-2 text-[10px] font-black",
              view === "library"
                ? "bg-zinc-100 text-zinc-950"
                : "bg-zinc-900 text-zinc-500"
            )}
          >
            NOTE LIBRARY
          </button>
        </div>
      </div>
      {view === "library" ? (
        <NoteLibraryView
          authenticated={Boolean(user)}
          onSignIn={() => startLogin()}
        />
      ) : (
        <div className="mx-auto grid max-w-[1520px] grid-cols-1 lg:grid-cols-[235px_minmax(0,1fr)]">
          <aside className="border-b border-zinc-700 bg-zinc-950/75 p-4 lg:min-h-[calc(100vh-73px)] lg:border-b-0 lg:border-r lg:p-6">
            <p className="meta-face text-[10px] text-zinc-500">EXECUTION LOG</p>
            <div className="mt-4 space-y-1">
              {runs.length === 0 ? (
                <p className="py-6 text-xs leading-5 text-zinc-500">
                  저장된 실행이 없습니다.
                  <br />
                  우측에서 새 작업을 시작하세요.
                </p>
              ) : (
                runs.map(item => (
                  <div
                    key={item.id}
                    className={cn(
                      "group flex items-start gap-1 border transition-colors",
                      selectedRunId === item.id
                        ? "border-zinc-200 bg-zinc-800"
                        : "border-transparent hover:border-zinc-700 hover:bg-zinc-900"
                    )}
                  >
                    <button
                      onClick={() => setSelectedRunId(item.id)}
                      className="min-w-0 flex-1 p-3 text-left"
                    >
                      <p className="truncate text-xs font-bold text-zinc-200">
                        {item.topic}
                      </p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="meta-face text-[8px] text-zinc-500">
                          {statusLabel[item.status]}
                        </span>
                        <span className="text-[10px] font-bold text-zinc-400">
                          {item.seedCount}/10
                        </span>
                      </div>
                    </button>
                    <button
                      aria-label={`${item.topic} 실행 이력 삭제`}
                      disabled={deleteRun.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `실행 "${item.topic}"과 후보·seed 기록을 삭제할까요?`
                          )
                        )
                          deleteRun.mutate({ guestKey, runId: item.id });
                      }}
                      className="mr-1 mt-2 grid h-7 w-7 shrink-0 place-items-center text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
            {user && runs.some(item => !item.userId) && (
              <div className="mt-5 border border-zinc-700 bg-zinc-900 p-3">
                <p className="meta-face text-[9px] text-zinc-500">
                  GUEST HISTORY / UNCLAIMED
                </p>
                <p className="mt-2 text-[10px] leading-4 text-zinc-400">
                  이 브라우저의 실행 이력은 저장소를 지우면 사라집니다. 계정으로
                  옮기면 다른 기기에서도 열립니다.
                </p>
                <Button
                  disabled={claimRuns.isPending}
                  onClick={() => claimRuns.mutate({ guestKey })}
                  className="mt-3 h-8 w-full rounded-none bg-zinc-700 text-[10px] font-black text-zinc-100 hover:bg-zinc-600"
                >
                  {claimRuns.isPending
                    ? "이전 중"
                    : "계정으로 실행 이력 옮기기"}
                </Button>
              </div>
            )}
            <div className="mt-9 border-t border-zinc-800 pt-5">
              <p className="meta-face text-[10px] text-zinc-500">
                PIPELINE STATUS
              </p>
              <div className="mt-4 space-y-3 text-xs">
                <div className="flex items-center justify-between text-zinc-200">
                  <span>01 / Seed foundry</span>
                  <span className="bg-zinc-100 px-1.5 py-0.5 text-[9px] font-black text-zinc-950">
                    LIVE
                  </span>
                </div>
                <div className="flex items-center justify-between text-zinc-600">
                  <span>02 / 1-hop graph</span>
                  <LockKeyhole className="h-3 w-3" />
                </div>
                <div className="flex items-center justify-between text-zinc-600">
                  <span>03 / OpenReview</span>
                  <LockKeyhole className="h-3 w-3" />
                </div>
                <div className="flex items-center justify-between text-zinc-600">
                  <span>04 / Tier & vault</span>
                  <LockKeyhole className="h-3 w-3" />
                </div>
              </div>
            </div>
          </aside>

          <section className="min-w-0 p-4 md:p-8 lg:p-10">
            <div className="reveal grid gap-6 border-b border-zinc-700 pb-8 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div>
                <p className="meta-face text-[10px] text-zinc-500">
                  TOP-TIER SELECTION / EVIDENCE-FIRST
                </p>
                <h1 className="display-face mt-4 max-w-4xl text-5xl leading-[0.88] tracking-[-0.06em] text-zinc-100 sm:text-7xl">
                  SELECT
                  <br />
                  <span className="text-zinc-500">WITH PROOF.</span>
                </h1>
                <p className="mt-5 max-w-2xl text-sm leading-6 text-zinc-400">
                  주제에서 시작해 수정 가능한 3–5개 질의를 검토하고, 허용 학회만
                  통과시킨 후보에서 5–10편을 seed로 고정합니다. 검색 원문과 판정
                  수치는 실행별로 저장됩니다.
                </p>
              </div>
              <div className="flex flex-col justify-end bg-zinc-800 p-5">
                <p className="meta-face text-[10px] text-zinc-400">
                  CURRENT EXECUTION
                </p>
                <p className="mt-2 truncate text-lg font-extrabold">
                  {currentRunSummary}
                </p>
                <div className="mt-5 flex items-center gap-2">
                  <span className="h-2 w-2 bg-zinc-100" />
                  <span className="meta-face text-[10px] text-zinc-300">
                    {run ? statusLabel[run.status] : "READY FOR INPUT"}
                  </span>
                </div>
              </div>
            </div>

            <div className="reveal-delay mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_315px]">
              <div className="space-y-6">
                <section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7">
                  <BlockHeading eyebrow="STAGE 01 / DEFINE THE JOB">
                    <span>주제와 seed 수</span>
                    <span className="meta-face mt-2 inline-block bg-zinc-800 px-2 py-1 text-[9px] text-zinc-300">
                      01 / 04
                    </span>
                  </BlockHeading>
                  <div className="mt-6 grid gap-5 md:grid-cols-[minmax(0,1fr)_170px]">
                    <div>
                      <Label
                        htmlFor="topic"
                        className="meta-face text-[10px] text-zinc-500"
                      >
                        RESEARCH TOPIC
                      </Label>
                      <Input
                        id="topic"
                        value={topic}
                        onChange={event => setTopic(event.target.value)}
                        disabled={createRun.isPending}
                        className="mt-3 h-12 rounded-none border-zinc-600 bg-zinc-900 px-4 text-base font-semibold text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-zinc-200"
                        placeholder="예: time-series conformal prediction"
                      />
                    </div>
                    <div>
                      <Label
                        htmlFor="seed-count"
                        className="meta-face text-[10px] text-zinc-500"
                      >
                        SEED COUNT
                      </Label>
                      <div className="mt-3 flex h-12 border border-zinc-600 bg-zinc-900">
                        <button
                          aria-label="seed 수 감소"
                          onClick={() =>
                            setDesiredSeedCount(count => Math.max(5, count - 1))
                          }
                          className="grid w-11 place-items-center text-zinc-400 hover:bg-zinc-800"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <input
                          id="seed-count"
                          readOnly
                          value={desiredSeedCount}
                          className="min-w-0 flex-1 bg-transparent text-center text-lg font-black text-zinc-100 outline-none"
                        />
                        <button
                          aria-label="seed 수 증가"
                          onClick={() =>
                            setDesiredSeedCount(count =>
                              Math.min(10, count + 1)
                            )
                          }
                          className="grid w-11 place-items-center text-zinc-400 hover:bg-zinc-800"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                      <p className="mt-2 text-[10px] text-zinc-500">
                        HARD RANGE: 5–10
                      </p>
                    </div>
                  </div>
                  <Button
                    onClick={() =>
                      createRun.mutate({ guestKey, topic, desiredSeedCount })
                    }
                    disabled={topic.trim().length < 3 || createRun.isPending}
                    className="mt-6 h-11 rounded-none bg-zinc-100 px-5 text-xs font-black text-zinc-950 hover:bg-zinc-300"
                  >
                    <Sparkles className="mr-2 h-4 w-4" />
                    {createRun.isPending
                      ? "질의 설계 중"
                      : "새 실행과 질의 제안"}
                    <ChevronRight className="ml-2 h-4 w-4" />
                  </Button>
                </section>

                {run && (
                  <section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7">
                    <BlockHeading
                      eyebrow="STAGE 02 / REVIEW BEFORE SEARCH"
                      action={
                        <span className="meta-face bg-zinc-800 px-2 py-1 text-[9px] text-zinc-300">
                          02 / 04
                        </span>
                      }
                    >
                      검색 질의 검토
                    </BlockHeading>
                    <p className="mt-4 text-xs leading-5 text-zinc-500">
                      수정·삭제 후 3–5개 질의를 확정하세요. 확정 전에는 외부
                      논문 검색을 호출하지 않습니다.
                    </p>
                    <div className="mt-5 space-y-2">
                      {draftQueries.map((query, index) => (
                        <div
                          key={query.id}
                          className="flex items-center gap-2 border border-zinc-700 bg-zinc-900/70 p-2"
                        >
                          <span className="meta-face w-7 text-center text-[10px] text-zinc-500">
                            Q{index + 1}
                          </span>
                          <Input
                            value={query.text}
                            disabled={run.status === "SEEDS_LOCKED"}
                            onChange={event =>
                              changeQuery(query.id, event.target.value)
                            }
                            className="h-9 rounded-none border-0 bg-transparent px-2 text-sm text-zinc-100 focus-visible:ring-1 focus-visible:ring-zinc-300"
                          />
                          <button
                            aria-label={`질의 ${index + 1} 삭제`}
                            disabled={
                              draftQueries.length <= 3 ||
                              run.status === "SEEDS_LOCKED"
                            }
                            onClick={() => removeQuery(query.id)}
                            className="grid h-8 w-8 place-items-center text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      <Button
                        variant="outline"
                        disabled={
                          draftQueries.length >= 5 ||
                          run.status === "SEEDS_LOCKED"
                        }
                        onClick={addQuery}
                        className="h-9 rounded-none border-zinc-600 bg-transparent text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        질의 추가
                      </Button>
                      <Button
                        disabled={
                          !queryValid ||
                          run.status === "SEEDS_LOCKED" ||
                          confirmQueries.isPending
                        }
                        onClick={() =>
                          confirmQueries.mutate({
                            guestKey,
                            runId: run.id,
                            queries: draftQueries.map(query => query.text),
                          })
                        }
                        className="h-9 rounded-none bg-zinc-100 text-xs font-black text-zinc-950 hover:bg-zinc-300"
                      >
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                        질의 확정
                      </Button>
                      {run.status !== "DRAFT" &&
                        run.status !== "SEEDS_LOCKED" && (
                          <Button
                            disabled={searchCandidates.isPending}
                            onClick={() =>
                              searchCandidates.mutate({
                                guestKey,
                                runId: run.id,
                              })
                            }
                            className="h-9 rounded-none bg-zinc-600 text-xs font-black text-white hover:bg-zinc-500"
                          >
                            <Search className="mr-1.5 h-3.5 w-3.5" />
                            {searchCandidates.isPending
                              ? "OpenAlex 검색 중"
                              : "top-tier 후보 검색"}
                          </Button>
                        )}
                    </div>
                  </section>
                )}

                {run &&
                  (run.status === "CANDIDATES_READY" ||
                    run.status === "SEEDS_LOCKED") && (
                    <section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7">
                      <BlockHeading
                        eyebrow="STAGE 03 / FIX THE SEED SET"
                        action={
                          <span className="meta-face bg-zinc-800 px-2 py-1 text-[9px] text-zinc-300">
                            03 / 04
                          </span>
                        }
                      >
                        top-tier 후보와 seed 고정
                      </BlockHeading>
                      <div className="mt-5 overflow-x-auto">
                        <table className="w-full min-w-[760px] text-left text-xs">
                          <thead className="meta-face border-y border-zinc-700 text-[9px] text-zinc-500">
                            <tr>
                              <th className="w-10 py-3">USE</th>
                              <th className="py-3">PAPER / DOI</th>
                              <th className="py-3">VENUE</th>
                              <th className="py-3">YEAR</th>
                              <th className="py-3">PROVENANCE</th>
                            </tr>
                          </thead>
                          <tbody>
                            {run.candidates.map(candidate => (
                              <tr
                                key={candidate.id}
                                className="border-b border-zinc-800 align-top hover:bg-zinc-900/70"
                              >
                                <td className="py-4">
                                  <button
                                    aria-label={`${candidate.title} seed 선택`}
                                    disabled={run.status === "SEEDS_LOCKED"}
                                    onClick={() => toggleSeed(candidate.id)}
                                    className={cn(
                                      "grid h-5 w-5 place-items-center border transition-colors",
                                      selectedSeeds.has(candidate.id)
                                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                                        : "border-zinc-600 text-transparent",
                                      run.status === "SEEDS_LOCKED" &&
                                        "cursor-not-allowed opacity-80"
                                    )}
                                  >
                                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                                  </button>
                                </td>
                                <td className="max-w-[330px] py-4 pr-5">
                                  <a
                                    href={candidate.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-bold leading-5 text-zinc-100 hover:underline"
                                  >
                                    {candidate.title}
                                    <ExternalLink className="ml-1 inline h-3 w-3 text-zinc-500" />
                                  </a>
                                  <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                                    {candidate.doi ??
                                      "DOI 미확인 · OpenAlex ID 보존"}
                                  </p>
                                </td>
                                <td className="py-4 pr-4">
                                  <Badge className="rounded-none bg-zinc-700 text-[10px] text-zinc-100 hover:bg-zinc-700">
                                    {candidate.venueCode}
                                  </Badge>
                                  <p className="mt-1 max-w-[150px] leading-4 text-zinc-500">
                                    {candidate.venue}
                                  </p>
                                </td>
                                <td className="py-4 text-zinc-300">
                                  {candidate.year ?? "—"}
                                </td>
                                <td className="py-4 pr-2">
                                  <div className="space-y-1">
                                    {candidate.provenance.map((item, idx) => (
                                      <p
                                        title={item}
                                        key={`${candidate.id}-${idx}`}
                                        className="max-w-[190px] truncate font-mono text-[9px] text-zinc-500"
                                      >
                                        Q{idx + 1} · {item}
                                      </p>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {run.candidates.length === 0 ? (
                        <div className="mt-6 border border-dashed border-zinc-700 p-6 text-center">
                          <CircleAlert className="mx-auto h-5 w-5 text-zinc-500" />
                          <p className="mt-2 text-xs text-zinc-400">
                            allowlist를 통과한 후보가 없습니다. 질의를 수정해
                            다시 검색하세요.
                          </p>
                        </div>
                      ) : (
                        <div className="mt-6 flex flex-col justify-between gap-4 border-t border-zinc-800 pt-5 sm:flex-row sm:items-center">
                          <p
                            className={cn(
                              "text-sm font-extrabold",
                              canLock || run.status === "SEEDS_LOCKED"
                                ? "text-zinc-100"
                                : "text-zinc-500"
                            )}
                          >
                            SELECTED{" "}
                            <span className="text-2xl">{selectedCount}</span>{" "}
                            <span className="meta-face text-[10px]">
                              / TARGET {run.desiredSeedCount} · HARD RANGE 5–10
                            </span>
                          </p>
                          <Button
                            disabled={!canLock || lockSeeds.isPending}
                            onClick={() =>
                              lockSeeds.mutate({
                                guestKey,
                                runId: run.id,
                                candidateIds: Array.from(selectedSeeds),
                              })
                            }
                            className="h-10 rounded-none bg-zinc-100 text-xs font-black text-zinc-950 hover:bg-zinc-300"
                          >
                            <ShieldCheck className="mr-2 h-4 w-4" />
                            {run.status === "SEEDS_LOCKED"
                              ? "SEED FIXED"
                              : lockSeeds.isPending
                                ? "고정 검증 중"
                                : "선택 seed 고정"}
                          </Button>
                          {run.status === "SEEDS_LOCKED" && (
                            <Button
                              variant="outline"
                              onClick={() => void exportSeedNotes()}
                              className="h-10 rounded-none border-zinc-600 bg-transparent text-xs font-black text-zinc-200 hover:bg-zinc-800 hover:text-white"
                            >
                              <Download className="mr-2 h-4 w-4" />
                              Obsidian 노트로 내보내기
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                  )}
              </div>

              <aside className="space-y-6">
                <section className="bg-zinc-200 p-5 text-zinc-950">
                  <p className="meta-face text-[10px] text-zinc-600">
                    RUN TELEMETRY
                  </p>
                  <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-6">
                    <Metric
                      label="RETRIEVED"
                      value={runMetrics.totalRetrieved}
                    />
                    <Metric
                      label="ELIGIBLE"
                      value={runMetrics.candidateCount}
                    />
                    <Metric
                      label="VENUE OUT"
                      value={runMetrics.venueExcluded}
                    />
                    <Metric
                      label="DEDUPED"
                      value={runMetrics.duplicatesRemoved}
                    />
                    <Metric label="FAILURES" value={runMetrics.failureCount} />
                    <Metric
                      label="SEEDS"
                      value={run?.seedCount ?? 0}
                      suffix="/ 10"
                    />
                  </div>
                  {run?.errorMessage && (
                    <p className="mt-5 border-t border-zinc-400 pt-3 text-xs leading-5 text-zinc-700">
                      {run.errorMessage}
                    </p>
                  )}
                </section>
                <section className="border border-zinc-700 bg-zinc-950/85 p-5">
                  <BlockHeading eyebrow="ALLOWLIST / INSPECTABLE">
                    <span>허용 venue</span>
                  </BlockHeading>
                  <div className="mt-4 space-y-3">
                    {venues.map(venue => (
                      <div key={venue.code} className="flex gap-3">
                        <span className="meta-face w-14 shrink-0 text-[10px] text-zinc-300">
                          {venue.code}
                        </span>
                        <p className="text-[11px] leading-4 text-zinc-500">
                          {venue.label}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="border border-zinc-700 bg-zinc-900/70 p-5">
                  <p className="meta-face text-[10px] text-zinc-500">
                    PIPELINE LOCKS
                  </p>
                  <div className="mt-4 space-y-4">
                    <div className="flex gap-3">
                      <Database className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                      <p className="text-xs leading-5 text-zinc-400">
                        <strong className="text-zinc-200">
                          01-hop citation
                        </strong>
                        <br />
                        준비 상태. 다음 모듈에서만 실행하며 T0은 최대 50편에서
                        중단합니다.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                      <p className="text-xs leading-5 text-zinc-400">
                        <strong className="text-zinc-200">
                          OpenReview / T1–T2 / notes
                        </strong>
                        <br />
                        준비 상태. 현재 실행에서는 호출·추출·노트 생성하지
                        않습니다.
                      </p>
                    </div>
                  </div>
                </section>
              </aside>
            </div>
            {runLoading && (
              <p className="meta-face mt-6 text-[10px] text-zinc-600">
                SYNCING EXECUTION STATE…
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
