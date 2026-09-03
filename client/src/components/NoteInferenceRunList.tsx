import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc";
import { History } from "lucide-react";
import { useState } from "react";

type Runs = RouterOutputs["notes"]["inferenceRuns"];
type Run = Runs[number];

const statusLabels: Record<string, string> = {
  RUNNING: "실행 중",
  SUCCEEDED: "완료",
  PARTIAL: "일부 근거 부족",
  FAILED: "실패",
};

const reviewLabels: Record<string, string> = {
  none: "검토할 항목 없음",
  pending: "미검토",
  partial: "검토 중",
  complete: "검토 완료",
};

/** A run still carrying unreviewed cells is the only one that can grow the gold set. */
function isUnreviewed(run: Run) {
  return (run.review?.pending ?? 0) > 0;
}

/**
 * Past inference runs. Every run has always been stored; until this list existed there was
 * no way to reach one, so a run could only be reviewed in the session that produced it and
 * every earlier run's verdicts were lost to the evaluation set.
 */
export default function NoteInferenceRunList({
  runs,
  selectedRunId,
  onSelect,
  loading,
}: {
  runs: Runs;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  loading: boolean;
}) {
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const pendingCount = runs.filter(isUnreviewed).length;
  const visible = unreviewedOnly ? runs.filter(isUnreviewed) : runs;

  return (
    <section className="border border-zinc-700 bg-zinc-950/85 p-5">
      <div className="flex items-center gap-3 border-b border-white/15 pb-4">
        <History className="h-4 w-4 text-zinc-300" />
        <div className="min-w-0 flex-1">
          <p className="meta-face text-[10px] text-zinc-500">
            INFERENCE HISTORY
          </p>
          <p className="mt-2 text-sm font-extrabold text-zinc-100">실행 기록</p>
        </div>
        {pendingCount > 0 && (
          <button
            onClick={() => setUnreviewedOnly(previous => !previous)}
            className={cn(
              "shrink-0 border px-2 py-1 font-mono text-[9px] transition-colors",
              unreviewedOnly
                ? "border-zinc-200 bg-zinc-200 text-zinc-950"
                : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
            )}
          >
            미검토 {pendingCount}
          </button>
        )}
      </div>

      {loading && (
        <p className="mt-4 font-mono text-[9px] text-zinc-600">
          기록을 불러오는 중…
        </p>
      )}

      {!loading && runs.length === 0 && (
        <p className="mt-4 text-[11px] leading-5 text-zinc-500">
          아직 실행 기록이 없습니다. 아래에서 노트를 고르고 추론을 실행하면
          여기에 쌓입니다.
        </p>
      )}

      {!loading && runs.length > 0 && visible.length === 0 && (
        <p className="mt-4 text-[11px] leading-5 text-zinc-500">
          미검토 항목이 남은 실행이 없습니다.
        </p>
      )}

      <div className="mt-4 space-y-2">
        {visible.map(run => {
          const review = run.review;
          const selected = run.id === selectedRunId;
          return (
            <button
              key={run.id}
              onClick={() => onSelect(run.id)}
              className={cn(
                "block w-full border p-3 text-left transition-colors",
                selected
                  ? "border-zinc-200 bg-zinc-900"
                  : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-[9px] text-zinc-500">
                  {statusLabels[run.status] ?? run.status}
                  {run.staleness && run.staleness.state !== "fresh" && (
                    <span className="ml-2 border border-zinc-600 px-1 text-zinc-300">
                      {run.staleness.state === "stale"
                        ? "원문 수정됨"
                        : "원문 없음"}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[9px] text-zinc-600">
                  {new Date(run.createdAt).toLocaleString("ko-KR")}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-300">
                {run.question}
              </p>
              <p className="mt-1 font-mono text-[9px] text-zinc-600">
                {run.evidenceCount} 근거 · {run.missingCount} 근거 부족
                {review && review.total > 0 && (
                  <>
                    {" · "}
                    <span
                      className={
                        review.pending > 0 ? "text-zinc-300" : "text-zinc-600"
                      }
                    >
                      {reviewLabels[review.status] ?? review.status}{" "}
                      {review.total - review.pending}/{review.total}
                    </span>
                  </>
                )}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
