import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

/** Display order of the parsed note sections, including the ones inference never cites. */
export const SECTION_ORDER = [
  "CLAIM",
  "SETTING",
  "AUTHOR_LIMITATIONS",
  "USER_OBSERVATIONS",
  "REVIEWER_CRITICISMS",
  "REPRODUCIBILITY",
  "USER_CONTEXT",
] as const;

/** Sections an inference run may cite. User observations and user context stay out by design. */
// The list itself lives in shared/sections.ts so the client, the server and the database
// enum cannot drift apart; re-exported here because this module is where the UI reads
// section vocabulary from.
export { INFERABLE_SECTIONS, type InferableSection } from "@shared/sections";

export const sectionLabels: Record<string, string> = {
  FRONTMATTER: "FRONTMATTER",
  CLAIM: "주장",
  SETTING: "세팅",
  AUTHOR_LIMITATIONS: "저자 명시",
  REVIEWER_CRITICISMS: "리뷰어 지적",
  USER_OBSERVATIONS: "내가 본 것",
  USER_CONTEXT: "내 맥락",
  REPRODUCIBILITY: "재현 정보",
  UNKNOWN: "기타 heading",
};

/** Turns an internal missing code into the user-facing 없음 / 근거 부족 wording. */
export function missingLabel(reason: string) {
  if (reason === "section_missing")
    return "없음: 해당 section이 원문에 없습니다.";
  if (reason === "source_unavailable")
    return "근거 부족: 선택 원문을 사용할 수 없습니다.";
  if (reason === "no_quote_found")
    return "근거 부족: 질문에 답할 인용 문장을 찾지 못했습니다.";
  return "근거 부족: 확인되지 않은 상태입니다.";
}

export function SectionChip({
  type,
  present,
  explicitEmpty,
}: {
  type: string;
  present: boolean;
  explicitEmpty?: boolean;
}) {
  return (
    <span
      className={cn(
        "border px-2 py-1 font-mono text-[9px]",
        present
          ? "border-zinc-500 text-zinc-200"
          : "border-zinc-800 text-zinc-600"
      )}
    >
      {present ? <Check className="mr-1 inline h-3 w-3" /> : "— "}
      {sectionLabels[type] ?? type}
      {explicitEmpty ? " · EMPTY" : ""}
    </span>
  );
}
