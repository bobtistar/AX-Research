import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/lib/trpc";
import { BrainCircuit } from "lucide-react";
import { useState } from "react";
import {
  INFERABLE_SECTIONS,
  InferableSection,
  missingLabel,
  sectionLabels,
} from "./noteSectionMeta";

type LibraryNote = RouterOutputs["notes"]["library"]["notes"][number];
/**
 * The panel renders a run fetched from the server, never the mutation's return value.
 * That is what lets a run from any past session be reviewed: the run just executed and a
 * run picked out of the history arrive through the same query and the same code path.
 */
type InferenceRun = RouterOutputs["notes"]["getInference"];
type ReviewRow = RouterOutputs["notes"]["inferenceReviews"]["reviews"][number];
type ReviewSummary = RouterOutputs["notes"]["inferenceReviews"]["summary"];

export type ReviewInput = {
  targetKind: "CLAIM" | "MISSING";
  noteId: string;
  sectionType: InferableSection;
  verdict: "APPROVED" | "REJECTED";
  correctedQuote?: string;
};

/** A verdict is recorded per (kind, note, section) cell, not per rendered card. */
function cellKey(cell: {
  targetKind: string;
  noteId: string;
  sectionType: string;
}) {
  return `${cell.targetKind}:${cell.noteId}:${cell.sectionType}`;
}

/**
 * Approve or reject one cell. A rejection has to carry the quote the answer should have
 * used, because a bare "wrong" cannot be turned into an evaluation case later; the server
 * enforces the same rule.
 */
function ReviewControls({
  cell,
  verdict,
  correctedQuote,
  disabled,
  onReview,
}: {
  cell: Pick<ReviewInput, "targetKind" | "noteId" | "sectionType">;
  verdict?: "APPROVED" | "REJECTED";
  correctedQuote?: string | null;
  disabled: boolean;
  onReview: (input: ReviewInput) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const open = draft !== null;

  return (
    <div className="mt-3 border-t border-zinc-800 pt-2">
      <div className="flex items-center gap-2">
        <button
          disabled={disabled}
          onClick={() => {
            setDraft(null);
            onReview({ ...cell, verdict: "APPROVED" });
          }}
          className={cn(
            "border px-2 py-1 font-mono text-[9px] transition-colors disabled:opacity-40",
            verdict === "APPROVED"
              ? "border-zinc-200 bg-zinc-200 text-zinc-950"
              : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
          )}
        >
          승인
        </button>
        <button
          disabled={disabled}
          onClick={() => setDraft(open ? null : (correctedQuote ?? ""))}
          className={cn(
            "border px-2 py-1 font-mono text-[9px] transition-colors disabled:opacity-40",
            verdict === "REJECTED"
              ? "border-zinc-400 bg-zinc-800 text-zinc-100"
              : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
          )}
        >
          거부
        </button>
        {verdict && (
          <span className="font-mono text-[9px] text-zinc-600">
            REVIEWED / {verdict}
          </span>
        )}
      </div>
      {open && (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            rows={3}
            placeholder="원문에서 옳은 인용 문장. 근거가 실제로 없으면 '근거 없음'."
            className="w-full resize-none border border-zinc-700 bg-zinc-900 p-2 text-[10px] leading-4 text-zinc-200 outline-none focus:border-zinc-500"
          />
          <div className="mt-1 flex gap-2">
            <button
              disabled={disabled || !draft.trim()}
              onClick={() => {
                onReview({
                  ...cell,
                  verdict: "REJECTED",
                  correctedQuote: draft.trim(),
                });
                setDraft(null);
              }}
              className="border border-zinc-200 bg-zinc-200 px-2 py-1 font-mono text-[9px] text-zinc-950 disabled:opacity-40"
            >
              거부 저장
            </button>
            <button
              onClick={() => setDraft(null)}
              className="border border-zinc-700 px-2 py-1 font-mono text-[9px] text-zinc-500"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Manual, evidence-first inference over the notes and sections the user selected. */
export default function NoteInferencePanel({
  notes,
  selectedInferenceNoteIds,
  setSelectedInferenceNoteIds,
  inferenceQuestion,
  setInferenceQuestion,
  sectionScope,
  setSectionScope,
  onRun,
  running,
  run,
  runLoading,
  reviews,
  reviewSummary,
  onReview,
  reviewPending,
}: {
  notes: LibraryNote[];
  selectedInferenceNoteIds: string[];
  setSelectedInferenceNoteIds: React.Dispatch<React.SetStateAction<string[]>>;
  inferenceQuestion: string;
  setInferenceQuestion: (value: string) => void;
  sectionScope: InferableSection[];
  setSectionScope: React.Dispatch<React.SetStateAction<InferableSection[]>>;
  onRun: () => void;
  running: boolean;
  run: InferenceRun;
  runLoading: boolean;
  reviews: ReviewRow[];
  reviewSummary?: ReviewSummary;
  onReview: (input: ReviewInput) => void;
  reviewPending: boolean;
}) {
  const library = { notes };
  const inference = { isPending: running };
  const reviewByCell = new Map(
    reviews.map(review => [cellKey(review), review] as const)
  );

  return (
    <section className="border border-zinc-700 bg-zinc-950/85 p-5">
      <div className="flex items-center gap-3 border-b border-white/15 pb-4">
        <BrainCircuit className="h-4 w-4 text-zinc-300" />
        <div>
          <p className="meta-face text-[10px] text-zinc-500">
            EVIDENCE-FIRST / MANUAL RUN
          </p>
          <p className="mt-2 text-sm font-extrabold text-zinc-100">
            선택 노트로 추론
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-zinc-500">
        원문 section을 먼저 고정합니다. `저자 명시`와 `리뷰어 지적`은 분리하고,
        인용을 검증할 수 없는 문장은 저장하지 않습니다.
      </p>
      <div className="mt-4 space-y-2">
        {(library?.notes ?? []).map(note => (
          <label
            key={note.id}
            className="flex cursor-pointer items-center gap-2 border border-zinc-800 bg-zinc-900 p-2"
          >
            <input
              type="checkbox"
              checked={selectedInferenceNoteIds.includes(note.id)}
              onChange={event =>
                setSelectedInferenceNoteIds(previous =>
                  event.target.checked
                    ? Array.from(new Set(previous.concat(note.id)))
                    : previous.filter(id => id !== note.id)
                )
              }
              className="h-3.5 w-3.5 accent-zinc-200"
            />
            <span className="truncate text-[11px] text-zinc-300">
              {note.title}
            </span>
          </label>
        ))}
      </div>
      <Input
        value={inferenceQuestion}
        onChange={event => setInferenceQuestion(event.target.value)}
        className="mt-4 h-10 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100"
      />
      <div className="mt-3">
        <p className="meta-face text-[9px] text-zinc-500">
          SECTION SCOPE{" "}
          {sectionScope.length === 0 && (
            <span className="ml-1 text-zinc-600">/ 질문에서 자동 판별</span>
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {INFERABLE_SECTIONS.map(type => (
            <button
              key={type}
              onClick={() =>
                setSectionScope(previous =>
                  previous.includes(type)
                    ? previous.filter(item => item !== type)
                    : previous.concat(type)
                )
              }
              className={cn(
                "border px-2 py-1 font-mono text-[9px] transition-colors",
                sectionScope.includes(type)
                  ? "border-zinc-200 bg-zinc-200 text-zinc-950"
                  : "border-zinc-700 text-zinc-500 hover:border-zinc-500"
              )}
            >
              {sectionLabels[type] ?? type}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-4 text-zinc-600">
          선택한 section만 근거 부족 여부를 판정합니다. 비워 두면 질문 문장에서
          판별합니다.
        </p>
      </div>
      <Button
        disabled={
          !selectedInferenceNoteIds.length ||
          inferenceQuestion.trim().length < 10 ||
          inference.isPending
        }
        onClick={onRun}
        className="mt-3 h-10 w-full rounded-none bg-zinc-100 text-xs font-black text-zinc-950 hover:bg-zinc-300"
      >
        <BrainCircuit className="mr-2 h-3.5 w-3.5" />
        {inference.isPending ? "근거 검색·추론 중" : "근거 기반 추론 실행"}
      </Button>
      {runLoading && (
        <p className="mt-5 border-t border-zinc-800 pt-4 font-mono text-[9px] text-zinc-600">
          실행 기록을 불러오는 중…
        </p>
      )}
      {run?.result && (
        <div className="mt-5 border-t border-zinc-800 pt-4">
          <div className="flex items-center justify-between">
            <p className="meta-face text-[9px] text-zinc-500">
              RUN / {run.status}
            </p>
            <span className="text-[10px] text-zinc-600">
              {run.result.claims.length} claims · {run.result.missing.length}{" "}
              missing
            </span>
          </div>
          {/* A past run is no longer self-evident from the input box above it. */}
          <p className="mt-2 text-[10px] leading-4 text-zinc-500">
            “{run.result.question}”
          </p>
          <p className="mt-1 font-mono text-[9px] text-zinc-600">
            {new Date(run.createdAt).toLocaleString("ko-KR")} ·{" "}
            {run.result.model} · {run.result.promptVersion}
          </p>
          {/*
            A stale run stays reviewable on purpose. The evidence on screen is the text of
            the version this run read, so a verdict on it is still a correct label for that
            text — and the gold set freezes that text anyway. Blocking review here would
            cost labels and buy nothing.
          */}
          {run.staleness && run.staleness.state !== "fresh" && (
            <div className="mt-2 border border-zinc-600 bg-zinc-900 p-2">
              <p className="text-[10px] font-bold text-zinc-200">
                {run.staleness.state === "stale"
                  ? "원문이 이 실행 이후 수정되었습니다"
                  : "이 실행이 읽은 원문을 찾을 수 없습니다"}
              </p>
              <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                {run.staleness.state === "stale"
                  ? `노트 ${run.staleness.notes.length}건이 새 버전으로 바뀌었습니다. 아래 결과는 수정 전 원문 기준입니다. 최신 기준 답이 필요하면 다시 실행하세요. 검토는 그대로 하셔도 됩니다 — 당시 원문에 대한 판단으로 기록됩니다.`
                  : `노트 ${run.staleness.notes.length}건이 삭제되었습니다. 다시 실행할 수 없으며, 아래 결과는 삭제 전 원문 기준입니다.`}
              </p>
              <p className="mt-1 font-mono text-[9px] text-zinc-600">
                {run.staleness.notes
                  .map(note =>
                    note.ranWithNumber && note.currentNumber
                      ? `${note.noteId.slice(0, 8)} v${note.ranWithNumber}→v${note.currentNumber}`
                      : `${note.noteId.slice(0, 8)} 없음`
                  )
                  .join(" · ")}
              </p>
            </div>
          )}
          {reviewSummary && reviewSummary.total > 0 && (
            <p className="mt-1 font-mono text-[9px] text-zinc-600">
              REVIEW / {reviewSummary.status} · 승인 {reviewSummary.approved} ·
              거부 {reviewSummary.rejected} · 미검토 {reviewSummary.pending}
            </p>
          )}
          <p className="mt-1 font-mono text-[9px] text-zinc-600">
            SCOPE /{" "}
            {run.result.targetSections
              .map(type => sectionLabels[type] ?? type)
              .join(" · ")}
          </p>
          <div className="mt-3 space-y-3">
            {run.result.claims.map((claim, index) => (
              <article
                key={`${claim.noteId}-${index}`}
                className="border border-zinc-800 bg-zinc-900 p-3"
              >
                <p className="text-[10px] font-bold text-zinc-200">
                  {claim.sectionType} · {claim.supportStatus}
                </p>
                <p className="mt-2 text-xs leading-5 text-zinc-400">
                  {claim.answer}
                </p>
                {claim.evidence.map(evidence => (
                  <blockquote
                    key={evidence.evidenceId}
                    className="mt-2 border-l border-zinc-500 pl-2 text-[10px] leading-4 text-zinc-500"
                  >
                    “{evidence.quote}”<br />
                    <span className="font-mono text-zinc-600">
                      {evidence.rawHeading} · {evidence.versionId.slice(0, 8)}
                    </span>
                  </blockquote>
                ))}
                {(() => {
                  const cell = {
                    targetKind: "CLAIM" as const,
                    noteId: claim.noteId,
                    sectionType: claim.sectionType,
                  };
                  const review = reviewByCell.get(cellKey(cell));
                  return (
                    <ReviewControls
                      cell={cell}
                      verdict={review?.verdict}
                      correctedQuote={review?.correctedQuote}
                      disabled={reviewPending}
                      onReview={onReview}
                    />
                  );
                })()}
              </article>
            ))}
            {run.result.missing.map((missing, index) => {
              const cell = {
                targetKind: "MISSING" as const,
                noteId: missing.noteId,
                sectionType: missing.sectionType,
              };
              const review = reviewByCell.get(cellKey(cell));
              return (
                <div
                  key={`${missing.noteId}-${index}`}
                  className="border border-dashed border-zinc-700 p-2"
                >
                  <p className="text-[10px] leading-4 text-zinc-500">
                    <span className="font-mono text-zinc-600">
                      {missing.noteId.slice(0, 8)} /{" "}
                      {sectionLabels[missing.sectionType] ??
                        missing.sectionType}
                    </span>
                    <br />
                    {missingLabel(missing.reason)}
                  </p>
                  <ReviewControls
                    cell={cell}
                    verdict={review?.verdict}
                    correctedQuote={review?.correctedQuote}
                    disabled={reviewPending}
                    onReview={onReview}
                  />
                </div>
              );
            })}
          </div>
          {run.result.error && (
            <p className="mt-3 border border-zinc-700 p-2 text-[10px] leading-4 text-zinc-400">
              실행 실패 — {run.result.error}
            </p>
          )}
        </div>
      )}
      {run && !run.result && !runLoading && (
        <p className="mt-5 border-t border-zinc-800 pt-4 text-[10px] leading-4 text-zinc-500">
          이 실행은 결과가 저장되기 전에 중단되었습니다. 상태 / {run.status}
        </p>
      )}
    </section>
  );
}
