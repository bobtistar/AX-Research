import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import {
  AlertTriangle,
  BrainCircuit,
  Check,
  ChevronRight,
  FileText,
  FolderPlus,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import NoteInferencePanel from "./NoteInferencePanel";
import NoteInferenceRunList from "./NoteInferenceRunList";
import AccountSettingsPanel from "./AccountSettingsPanel";
import NoteSourceInspector from "./NoteSourceInspector";
import {
  InferableSection,
  SECTION_ORDER,
  SectionChip,
} from "./noteSectionMeta";
import { toast } from "sonner";

export default function NoteLibraryView({
  authenticated,
  onSignIn,
}: {
  authenticated: boolean;
  onSignIn: () => void;
}) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | undefined
  >();
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedInferenceNoteIds, setSelectedInferenceNoteIds] = useState<
    string[]
  >([]);
  const [inferenceQuestion, setInferenceQuestion] = useState(
    "선택한 논문에서 저자가 인정한 한계와 리뷰어 지적을 각각 추출해 비교해줘."
  );
  const [sectionScope, setSectionScope] = useState<InferableSection[]>([]);
  // The selected run lives in the URL rather than in component state, so a reload, a
  // shared link and the browser's back button all land on the same run. Losing the
  // selection on reload is what previously made a run unreviewable after the fact.
  const search = useSearch();
  const [location, navigate] = useLocation();
  const selectedRunId = new URLSearchParams(search).get("run");
  const setSelectedRunId = (runId: string | null) => {
    const params = new URLSearchParams(search);
    if (runId) params.set("run", runId);
    else params.delete("run");
    const query = params.toString();
    navigate(query ? `${location}?${query}` : location);
  };
  const [collectionName, setCollectionName] = useState("");
  const [collectionDescription, setCollectionDescription] = useState("");
  const libraryQuery = trpc.notes.library.useQuery(
    { collectionId: selectedCollectionId },
    { enabled: authenticated }
  );
  const noteQuery = trpc.notes.get.useQuery(
    { noteId: selectedNoteId ?? "none" },
    { enabled: authenticated && Boolean(selectedNoteId) }
  );
  const library = libraryQuery.data;
  const selectedNote = noteQuery.data;
  const sourceQuery = trpc.notes.source.useQuery(
    { noteId: selectedNoteId ?? "none" },
    { enabled: authenticated && Boolean(selectedNoteId) }
  );
  const source = sourceQuery.data;

  const createCollection = trpc.notes.createCollection.useMutation({
    onSuccess: async collection => {
      setCollectionName("");
      setCollectionDescription("");
      await utils.notes.library.invalidate();
      if (collection?.id) setSelectedCollectionId(collection.id);
      toast.success("새 private Collection을 만들었습니다.");
    },
    onError: error => toast.error(error.message),
  });

  const deleteNote = trpc.notes.deleteNote.useMutation({
    onSuccess: async result => {
      setSelectedNoteId(null);
      setSelectedInferenceNoteIds(previous =>
        previous.filter(id => id !== result.noteId)
      );
      await utils.notes.library.invalidate();
      const orphaned = result.orphanedStorageKeys.length;
      toast.success(
        `문서를 삭제했습니다${orphaned ? ` · 원문 사본 ${orphaned}건은 정리 대기 목록에 기록했습니다` : ""}.`
      );
    },
    onError: error => toast.error(error.message),
  });

  const deleteCollection = trpc.notes.deleteCollection.useMutation({
    onSuccess: async result => {
      setSelectedCollectionId(undefined);
      await utils.notes.library.invalidate();
      toast.success(
        `Collection을 삭제했습니다. 문서 ${result.releasedNotes}건은 workspace에 그대로 남아 있습니다.`
      );
    },
    onError: error => toast.error(error.message),
  });

  const inference = trpc.notes.inference.useMutation({
    onSuccess: result => {
      setSelectedRunId(result.id);
      void utils.notes.inferenceRuns.invalidate();
      toast.success("원문 근거 기반 추론을 완료했습니다.");
    },
    onError: error => toast.error(error.message),
  });

  const runsQuery = trpc.notes.inferenceRuns.useQuery(undefined, {
    enabled: authenticated,
  });
  const runQuery = trpc.notes.getInference.useQuery(
    { runId: selectedRunId ?? "" },
    { enabled: Boolean(selectedRunId) }
  );
  // Verdicts are read back from the server rather than held in component state, so a
  // reviewed run still shows its verdicts after a reload.
  const reviewsQuery = trpc.notes.inferenceReviews.useQuery(
    { runId: selectedRunId ?? "" },
    { enabled: Boolean(selectedRunId) }
  );
  const reviewInference = trpc.notes.reviewInference.useMutation({
    onSuccess: async () => {
      await utils.notes.inferenceReviews.invalidate();
      void utils.notes.getInference.invalidate();
      void utils.notes.inferenceRuns.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const ingest = trpc.notes.ingest.useMutation({
    onSuccess: async result => {
      await utils.notes.library.invalidate({
        collectionId: selectedCollectionId,
      });
      const firstNoteId = result.results.find(
        item => typeof item.noteId === "string"
      )?.noteId;
      if (typeof firstNoteId === "string") setSelectedNoteId(firstNoteId);
      if (inputRef.current) inputRef.current.value = "";
      toast.success(
        `${result.metrics.parsed}개 파일을 파싱했습니다${result.metrics.failed ? ` · 실패 ${result.metrics.failed}건` : ""}.`
      );
    },
    onError: error => toast.error(error.message),
  });

  useEffect(() => {
    if (!selectedCollectionId && library?.inboxId)
      setSelectedCollectionId(library.inboxId);
    if (!selectedNoteId && library?.notes[0])
      setSelectedNoteId(library.notes[0].id);
    if (!selectedInferenceNoteIds.length && library?.notes[0])
      setSelectedInferenceNoteIds([library.notes[0].id]);
    if (
      selectedNoteId &&
      library &&
      !library.notes.some(note => note.id === selectedNoteId)
    )
      setSelectedNoteId(library.notes[0]?.id ?? null);
  }, [
    library?.inboxId,
    library?.notes.length,
    selectedCollectionId,
    selectedNoteId,
  ]);

  const selectedCollection = library?.collections.find(
    collection => collection.id === selectedCollectionId
  );
  const readFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    if (files.length > 20) {
      toast.error("한 번에 20개 파일까지 업로드할 수 있습니다.");
      return;
    }
    const inputs: Array<{ name: string; content: string }> = [];
    for (const file of Array.from(files)) {
      if (!file.name.toLocaleLowerCase().endsWith(".md")) continue;
      inputs.push({
        name: file.webkitRelativePath || file.name,
        content: await file.text(),
      });
    }
    if (!inputs.length) {
      toast.error(".md 파일을 하나 이상 선택해 주세요.");
      return;
    }
    ingest.mutate({ collectionId: selectedCollectionId, files: inputs });
  };

  if (!authenticated)
    return (
      <section className="mx-auto max-w-[1520px] p-4 md:p-10">
        <div className="border border-zinc-700 bg-zinc-950/90 p-8 md:p-12">
          <div className="flex items-center gap-3">
            <LockKeyhole className="h-5 w-5 text-zinc-300" />
            <p className="meta-face text-[10px] text-zinc-400">
              PRIVATE NOTE LIBRARY / ACCOUNT REQUIRED
            </p>
          </div>
          <h1 className="display-face mt-6 max-w-3xl text-5xl leading-[0.9] tracking-[-0.05em] text-zinc-100 md:text-7xl">
            YOUR NOTES.
            <br />
            <span className="text-zinc-600">YOUR SCOPE.</span>
          </h1>
          <p className="mt-6 max-w-xl text-sm leading-6 text-zinc-400">
            문서 library는 사용자별 private workspace에 저장됩니다. 로그인하면
            여러 연구 Collection과 Markdown 버전을 다른 사용자와 분리해 관리할
            수 있습니다. 게스트 seed 수집은 계속 사용할 수 있습니다.
          </p>
          <Button
            onClick={onSignIn}
            className="mt-8 h-11 rounded-none bg-zinc-100 px-5 text-xs font-black text-zinc-950 hover:bg-zinc-300"
          >
            <LockKeyhole className="mr-2 h-4 w-4" />
            계정으로 문서 library 열기
          </Button>
        </div>
      </section>
    );

  return (
    <section className="mx-auto max-w-[1520px] p-4 md:p-8 lg:p-10">
      <div className="reveal grid gap-6 border-b border-zinc-700 pb-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <p className="meta-face text-[10px] text-zinc-500">
            MODULE 02 / PRIVATE MARKDOWN LIBRARY
          </p>
          <h1 className="display-face mt-4 max-w-4xl text-5xl leading-[0.88] tracking-[-0.06em] text-zinc-100 sm:text-7xl">
            STORE
            <br />
            <span className="text-zinc-500">THE EVIDENCE.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-6 text-zinc-400">
            Obsidian에서 관리하던 Markdown을 원본 그대로 업로드하고,
            workspace·Collection·version·section 단위로 분리해 검토합니다.
            선택한 문서의 source version과 원문 section만 사용해 추론하며, AI
            결과는 원본 Markdown과 분리해 저장합니다.
          </p>
        </div>
        <div className="bg-zinc-200 p-5 text-zinc-950">
          <p className="meta-face text-[10px] text-zinc-600">
            WORKSPACE / PRIVATE
          </p>
          <p className="mt-2 text-lg font-extrabold">
            {library?.workspace.name ?? "Loading workspace"}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-5">
            <div>
              <p className="meta-face text-[9px] text-zinc-600">NOTES</p>
              <p className="mt-1 text-3xl font-black">
                {library?.metrics.noteCount ?? 0}
              </p>
            </div>
            <div>
              <p className="meta-face text-[9px] text-zinc-600">WARNINGS</p>
              <p className="mt-1 text-3xl font-black">
                {library?.metrics.warningCount ?? 0}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[235px_minmax(0,1fr)_340px]">
        <aside className="border border-zinc-700 bg-zinc-950/85 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="meta-face text-[10px] text-zinc-500">COLLECTIONS</p>
              <p className="mt-2 text-sm font-extrabold">연구 주제 묶음</p>
            </div>
            <FolderPlus className="h-4 w-4 text-zinc-500" />
          </div>
          <div className="mt-5 space-y-1">
            {library?.collections.map(collection => (
              <div
                key={collection.id}
                className={cn(
                  "flex items-start gap-1 border transition-colors",
                  selectedCollectionId === collection.id
                    ? "border-zinc-200 bg-zinc-800"
                    : "border-transparent hover:border-zinc-700 hover:bg-zinc-900"
                )}
              >
                <button
                  onClick={() => setSelectedCollectionId(collection.id)}
                  className="min-w-0 flex-1 p-3 text-left"
                >
                  <p className="truncate text-xs font-bold text-zinc-200">
                    {collection.name}
                  </p>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                    {collection.description ?? "Private collection"}
                  </p>
                </button>
                {collection.name !== "Inbox" && (
                  <button
                    aria-label={`${collection.name} Collection 삭제`}
                    disabled={deleteCollection.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Collection "${collection.name}"을 삭제할까요? 문서 자체는 삭제되지 않습니다.`
                        )
                      )
                        deleteCollection.mutate({
                          collectionId: collection.id,
                        });
                    }}
                    className="mr-1 mt-2 grid h-7 w-7 shrink-0 place-items-center text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-zinc-800 pt-5">
            <Label
              htmlFor="collection-name"
              className="meta-face text-[9px] text-zinc-500"
            >
              NEW COLLECTION
            </Label>
            <Input
              id="collection-name"
              value={collectionName}
              onChange={event => setCollectionName(event.target.value)}
              placeholder="예: LLM calibration"
              className="mt-2 h-9 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100 placeholder:text-zinc-700"
            />
            <Input
              aria-label="Collection 설명"
              value={collectionDescription}
              onChange={event => setCollectionDescription(event.target.value)}
              placeholder="짧은 설명 (선택)"
              className="mt-2 h-9 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100 placeholder:text-zinc-700"
            />
            <Button
              disabled={!collectionName.trim() || createCollection.isPending}
              onClick={() =>
                createCollection.mutate({
                  name: collectionName,
                  description: collectionDescription || undefined,
                })
              }
              className="mt-2 h-9 w-full rounded-none bg-zinc-700 text-[10px] font-black text-zinc-100 hover:bg-zinc-600"
            >
              <Plus className="mr-1.5 h-3 w-3" />
              {createCollection.isPending ? "생성 중" : "Collection 생성"}
            </Button>
          </div>
        </aside>

        <div className="min-w-0 space-y-6">
          <section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/15 pb-4">
              <div>
                <p className="meta-face text-[10px] text-zinc-500">
                  INGEST / READ-ONLY SOURCE
                </p>
                <h2 className="mt-2 text-xl font-extrabold text-white">
                  Markdown 가져오기
                </h2>
              </div>
              <Button
                variant="outline"
                onClick={() => inputRef.current?.click()}
                disabled={ingest.isPending}
                className="h-9 rounded-none border-zinc-600 bg-transparent text-xs text-zinc-200 hover:bg-zinc-800"
              >
                <Upload className="mr-2 h-3.5 w-3.5" />
                {ingest.isPending ? "파싱 중" : "파일 선택"}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".md,text/markdown"
                multiple
                className="hidden"
                onChange={event => void readFiles(event.target.files)}
              />
            </div>
            <p className="mt-4 text-xs leading-5 text-zinc-500">
              현재 대상:{" "}
              <strong className="text-zinc-300">
                {selectedCollection?.name ?? "Inbox"}
              </strong>
              . 원본 파일은 수정하지 않고, 업로드된 파일의 hash와 version을
              저장합니다. 파일당 700KB, batch당 20개·4MB까지입니다.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="border border-zinc-800 bg-zinc-900 p-3">
                <p className="meta-face text-[9px] text-zinc-500">NOTES</p>
                <p className="mt-1 text-2xl font-black">
                  {library?.metrics.noteCount ?? 0}
                </p>
              </div>
              <div className="border border-zinc-800 bg-zinc-900 p-3">
                <p className="meta-face text-[9px] text-zinc-500">VERSIONS</p>
                <p className="mt-1 text-2xl font-black">
                  {library?.metrics.versionCount ?? 0}
                </p>
              </div>
              <div className="border border-zinc-800 bg-zinc-900 p-3">
                <p className="meta-face text-[9px] text-zinc-500">WARNINGS</p>
                <p className="mt-1 text-2xl font-black">
                  {library?.metrics.warningCount ?? 0}
                </p>
              </div>
              <div className="border border-zinc-800 bg-zinc-900 p-3">
                <p className="meta-face text-[9px] text-zinc-500">SYNC</p>
                <p className="mt-1 text-xs font-black text-zinc-300">
                  {libraryQuery.isFetching ? "UPDATING" : "CURRENT"}
                </p>
              </div>
            </div>
          </section>

          <section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7">
            <div className="flex items-center justify-between border-b border-white/15 pb-4">
              <div>
                <p className="meta-face text-[10px] text-zinc-500">
                  DOCUMENT INDEX / {selectedCollection?.name ?? "ALL"}
                </p>
                <h2 className="mt-2 text-xl font-extrabold text-white">
                  논문 Markdown
                </h2>
              </div>
              <FileText className="h-5 w-5 text-zinc-500" />
            </div>
            {!library?.notes.length ? (
              <div className="border-b border-zinc-800 py-12 text-center">
                <FileText className="mx-auto h-6 w-6 text-zinc-600" />
                <p className="mt-3 text-sm font-bold text-zinc-400">
                  아직 업로드한 문서가 없습니다.
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  Obsidian에서 기존 `.md` 파일을 선택해 시작하세요.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-800">
                {library.notes.map(note => (
                  <button
                    key={note.id}
                    onClick={() => setSelectedNoteId(note.id)}
                    className={cn(
                      "grid w-full gap-3 p-4 text-left transition-colors md:grid-cols-[minmax(0,1fr)_110px]",
                      selectedNoteId === note.id
                        ? "bg-zinc-800"
                        : "hover:bg-zinc-900"
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-zinc-500" />
                        <p className="truncate text-sm font-extrabold text-zinc-100">
                          {note.title}
                        </p>
                        {note.warnings.length > 0 && (
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                        )}
                      </div>
                      <p className="mt-1 truncate pl-6 font-mono text-[10px] text-zinc-600">
                        {note.sourcePath} ·{" "}
                        {note.contentHash?.slice(0, 12) ?? "NO VERSION"}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1 pl-6">
                        {SECTION_ORDER.map(type => (
                          <SectionChip
                            key={type}
                            type={type}
                            present={Boolean(note.sectionPresence?.[type])}
                            explicitEmpty={note.explicitEmptySections?.includes(
                              type
                            )}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="meta-face text-[9px] text-zinc-500">
                        VERSIONS
                      </p>
                      <p className="mt-1 text-lg font-black text-zinc-200">
                        {note.versionCount}
                      </p>
                      <p className="mt-2 truncate text-[10px] text-zinc-500">
                        {note.externalId ?? "ID 없음"}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <NoteSourceInspector
            note={selectedNote}
            source={source}
            onRefresh={() =>
              selectedNoteId &&
              void utils.notes.get.invalidate({ noteId: selectedNoteId })
            }
            onDelete={() => {
              if (
                selectedNote &&
                window.confirm(
                  `문서 "${selectedNote.title}"과 모든 버전을 삭제할까요? 되돌릴 수 없습니다.`
                )
              )
                deleteNote.mutate({ noteId: selectedNote.id });
            }}
            deleting={deleteNote.isPending}
          />
          <AccountSettingsPanel authenticated={authenticated} />
          <NoteInferenceRunList
            runs={runsQuery.data ?? []}
            selectedRunId={selectedRunId}
            onSelect={setSelectedRunId}
            loading={runsQuery.isLoading}
          />
          <NoteInferencePanel
            notes={library?.notes ?? []}
            selectedInferenceNoteIds={selectedInferenceNoteIds}
            setSelectedInferenceNoteIds={setSelectedInferenceNoteIds}
            inferenceQuestion={inferenceQuestion}
            setInferenceQuestion={setInferenceQuestion}
            sectionScope={sectionScope}
            setSectionScope={setSectionScope}
            onRun={() =>
              inference.mutate({
                noteIds: selectedInferenceNoteIds,
                question: inferenceQuestion,
                sectionTypes: sectionScope.length ? sectionScope : undefined,
              })
            }
            running={inference.isPending}
            run={runQuery.data}
            runLoading={runQuery.isFetching}
            reviews={reviewsQuery.data?.reviews ?? []}
            reviewSummary={reviewsQuery.data?.summary}
            reviewPending={reviewInference.isPending}
            onReview={input => {
              if (!selectedRunId) return;
              reviewInference.mutate({ runId: selectedRunId, ...input });
            }}
          />
          <section className="border border-zinc-700 bg-zinc-900/70 p-5">
            <p className="meta-face text-[10px] text-zinc-500">NEXT LOCK</p>
            <div className="mt-4 flex gap-3">
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              <p className="text-xs leading-5 text-zinc-400">
                <strong className="text-zinc-200">
                  Citation graph / OpenReview / T1–T2
                </strong>
                <br />
                현재 단계에서는 실행하지 않습니다. source-backed note library와
                inference 기록을 기반으로 다음 모듈에서 활성화합니다.
              </p>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
