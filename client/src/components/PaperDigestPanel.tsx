import { cn } from "@/lib/utils";
import { sectionLabels } from "@/components/noteSectionMeta";
import { AlertTriangle, Copy, X } from "lucide-react";
import { toast } from "sonner";

type DigestEntry = {
  sectionType: string;
  draft: string;
  quote: string;
  status: "SUPPORTED" | "ABSENT" | "REJECTED";
  rejectedReason?: string;
};

export type PaperDigestResult = {
  title: string;
  summary: string;
  entries: DigestEntry[];
  readingChecklist: string[];
  provisional: boolean;
  sourceKind: string;
  sourceRef: string;
  model: string;
  promptVersion: string;
  warnings: string[];
};

const REJECTED_LABEL: Record<string, string> = {
  quote_not_in_source: "모델이 인용한 문장이 초록에 없어 버렸습니다.",
  quote_too_short: "인용이 너무 짧아 근거로 인정하지 않았습니다.",
  empty_draft: "초안이 비어 있어 버렸습니다.",
};

/**
 * Shows a digest as what it is: a machine draft over the abstract, with each line's quote
 * next to it and the unverifiable line marked. Nothing here writes to a note — pasting it
 * into the vault is the user's action, which is the same boundary `seedExport` holds.
 */
export function PaperDigestPanel({
  digest,
  onClose,
}: {
  digest: PaperDigestResult;
  onClose: () => void;
}) {
  const supported = digest.entries.filter(
    entry => entry.status === "SUPPORTED"
  );

  const copyDraft = async () => {
    // Only verified lines are copied, each with its quote, so what lands in the vault can
    // still be checked against the paper.
    const text = [
      `# ${digest.title}`,
      "",
      ...supported.flatMap(entry => [
        `## ${sectionLabels[entry.sectionType] ?? entry.sectionType}`,
        entry.draft,
        `> ${entry.quote}`,
        "",
      ]),
      digest.readingChecklist.length > 0
        ? `<!-- 원문에서 확인 필요: ${digest.readingChecklist
            .map(section => sectionLabels[section] ?? section)
            .join(", ")} -->`
        : "",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(
        "검증된 항목만 복사했습니다. 노트에 붙여넣기 전에 원문과 대조하세요."
      );
    } catch {
      toast.error("클립보드에 접근하지 못했습니다.");
    }
  };

  return (
    <div className="border border-zinc-700 bg-zinc-900/60 p-4 md:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="meta-face text-[9px] text-zinc-500">
            빠른 이해 · 초록만 읽은 초안 · {digest.model} ·{" "}
            {digest.promptVersion}
          </p>
          <p className="mt-1 text-sm font-bold leading-5 text-zinc-100">
            {digest.summary || "요약을 만들지 못했습니다."}
          </p>
          <p className="mt-1 text-[10px] text-zinc-500">
            한 줄 요약은 인용으로 검증할 수 없는 유일한 항목입니다. 나머지는
            아래 인용으로 확인하세요.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="빠른 이해 닫기"
          className="shrink-0 border border-zinc-700 p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {digest.entries.map(entry => (
          <div
            key={entry.sectionType}
            className={cn(
              "border-l-2 pl-3",
              entry.status === "SUPPORTED"
                ? "border-zinc-400"
                : entry.status === "REJECTED"
                  ? "border-amber-700"
                  : "border-zinc-700"
            )}
          >
            <p className="meta-face text-[9px] text-zinc-400">
              {sectionLabels[entry.sectionType] ?? entry.sectionType}
              {entry.status !== "SUPPORTED" && (
                <span className="ml-2 text-zinc-600">
                  {entry.status === "ABSENT" ? "초록에 없음" : "버려짐"}
                </span>
              )}
            </p>
            {entry.status === "SUPPORTED" ? (
              <>
                <p className="mt-1 text-xs leading-5 text-zinc-200">
                  {entry.draft}
                </p>
                <blockquote className="mt-1.5 border-l border-zinc-700 pl-2 text-[10px] italic leading-4 text-zinc-500">
                  {entry.quote}
                </blockquote>
              </>
            ) : (
              <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                {entry.status === "REJECTED"
                  ? (REJECTED_LABEL[entry.rejectedReason ?? ""] ??
                    "검증에 실패해 버렸습니다.")
                  : "초록이 이 항목을 말하지 않습니다. 원문에서 직접 확인하세요."}
              </p>
            )}
          </div>
        ))}
      </div>

      {digest.readingChecklist.length > 0 && (
        <div className="mt-4 border border-amber-900/60 bg-amber-950/20 p-3">
          <p className="meta-face flex items-center gap-1.5 text-[9px] text-amber-200">
            <AlertTriangle className="h-3 w-3" />
            원문에서 직접 확인할 것
          </p>
          <p className="mt-1.5 text-[11px] leading-4 text-amber-100/80">
            {digest.readingChecklist
              .map(section => sectionLabels[section] ?? section)
              .join(" · ")}
          </p>
          <p className="mt-1 text-[10px] leading-4 text-amber-100/50">
            초록만으로는 답할 수 없는 항목입니다. PDF에서 이 부분을 찾아 읽으면
            노트가 채워집니다.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copyDraft}
          disabled={supported.length === 0}
          className="meta-face flex items-center gap-1.5 border border-zinc-600 px-2.5 py-1.5 text-[9px] text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-40"
        >
          <Copy className="h-3 w-3" />
          검증된 {supported.length}개 항목 복사
        </button>
        <p className="text-[9px] text-zinc-600">
          이 초안은 노트로 저장되지 않으며 근거로 쓰이지 않습니다.
        </p>
      </div>
    </div>
  );
}
