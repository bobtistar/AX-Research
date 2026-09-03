import { Button } from "@/components/ui/button";
import type { RouterOutputs } from "@/lib/trpc";
import { Link2, RefreshCw, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { SECTION_ORDER, SectionChip, sectionLabels } from "./noteSectionMeta";

type NoteDetail = NonNullable<RouterOutputs["notes"]["get"]>;
type NoteSource = RouterOutputs["notes"]["source"] | undefined;

/** Read-only view of one note's parsed sections, links, warnings and raw Markdown. */
export default function NoteSourceInspector({
  note,
  source,
  onRefresh,
  onDelete,
  deleting,
}: {
  note: NoteDetail | undefined;
  source: NoteSource;
  onRefresh: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const sectionByType = useMemo(
    () =>
      new Map(
        (note?.latestVersion?.sections ?? []).map(section => [
          section.sectionType,
          section,
        ])
      ),
    [note?.latestVersion?.id]
  );
  const selectedWarnings = note?.latestVersion?.warnings ?? [];
  const noteSections = note?.latestVersion?.sections ?? [];
  const noteLinks = note?.latestVersion?.links ?? [];
  const selectedNote = note;

  return (
    <section className="border border-zinc-700 bg-zinc-950/85 p-5">
      <div className="flex items-center justify-between border-b border-white/15 pb-4">
        <div>
          <p className="meta-face text-[10px] text-zinc-500">
            SOURCE INSPECTOR
          </p>
          <p className="mt-2 text-sm font-extrabold">원문 구조 확인</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            onClick={onRefresh}
            className="h-8 w-8 rounded-none p-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            aria-label="선택 문서 삭제"
            disabled={!selectedNote || deleting}
            onClick={() => {
              if (
                selectedNote &&
                window.confirm(
                  `문서 "${selectedNote.title}"과 모든 버전을 삭제할까요? 되돌릴 수 없습니다.`
                )
              )
                onDelete();
            }}
            className="h-8 w-8 rounded-none p-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {!selectedNote ? (
        <p className="py-8 text-xs leading-5 text-zinc-600">
          왼쪽 문서를 선택하면 파싱된 원문 section과 warning을 확인할 수
          있습니다.
        </p>
      ) : (
        <div className="mt-5">
          <p className="text-lg font-extrabold leading-6 text-zinc-100">
            {selectedNote.title}
          </p>
          <p className="mt-2 break-all font-mono text-[10px] text-zinc-600">
            {selectedNote.sourcePath}
          </p>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {SECTION_ORDER.map(type => (
              <SectionChip
                key={type}
                type={type}
                present={Boolean(sectionByType.get(type))}
                explicitEmpty={sectionByType.get(type)?.explicitEmpty}
              />
            ))}
          </div>
          {selectedWarnings.length > 0 && (
            <div className="mt-5 border-l-2 border-zinc-500 bg-zinc-900 p-3">
              <p className="meta-face text-[9px] text-zinc-500">
                PARSE WARNINGS / {selectedWarnings.length}
              </p>
              <div className="mt-2 space-y-1">
                {selectedWarnings.map(warning => (
                  <p
                    key={warning}
                    className="break-words text-[10px] leading-4 text-zinc-400"
                  >
                    {warning}
                  </p>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 space-y-3">
            {noteSections.map(section => (
              <article
                key={section.id}
                className="border-t border-zinc-800 pt-3"
              >
                <p className="meta-face text-[9px] text-zinc-500">
                  {sectionLabels[section.sectionType] ?? section.rawHeading}{" "}
                  <span className="ml-2 text-zinc-700">
                    / {section.rawHeading}
                  </span>
                </p>
                <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-zinc-400">
                  {section.body || "(empty)"}
                </p>
              </article>
            ))}
          </div>
          {noteLinks.length > 0 && (
            <div className="mt-6 border-t border-zinc-800 pt-4">
              <div className="flex items-center gap-2">
                <Link2 className="h-3.5 w-3.5 text-zinc-500" />
                <p className="meta-face text-[9px] text-zinc-500">
                  INDEXED LINKS / {noteLinks.length}
                </p>
              </div>
              <div className="mt-3 space-y-2">
                {noteLinks.map(link => (
                  <div
                    key={link.id}
                    className="border border-zinc-800 bg-zinc-900 p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[9px] text-zinc-400">
                        {link.linkType}
                      </span>
                      <span className="font-mono text-[9px] text-zinc-600">
                        {link.sourceLocator}
                      </span>
                    </div>
                    <p className="mt-1 break-all text-[10px] leading-4 text-zinc-500">
                      {link.label ? `${link.label}: ` : ""}
                      {link.target}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {source && (
            <details className="mt-6 border-t border-zinc-800 pt-3">
              <summary className="cursor-pointer list-none">
                <p className="meta-face text-[9px] text-zinc-500">
                  RAW MARKDOWN / READ ONLY
                </p>
                <p className="mt-1 text-[10px] text-zinc-600">
                  원문 파일을 펼쳐 확인
                </p>
              </summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words bg-zinc-900 p-3 text-[10px] leading-4 text-zinc-500">
                {source.content}
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
