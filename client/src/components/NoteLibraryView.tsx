import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, BrainCircuit, Check, ChevronRight, FileText, FolderPlus, Link2, LockKeyhole, Plus, RefreshCw, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const SECTION_ORDER = ["CLAIM", "SETTING", "AUTHOR_LIMITATIONS", "USER_OBSERVATIONS", "REVIEWER_CRITICISMS", "REPRODUCIBILITY", "USER_CONTEXT"] as const;
const sectionLabels: Record<string, string> = {
  FRONTMATTER: "FRONTMATTER", CLAIM: "주장", SETTING: "세팅", AUTHOR_LIMITATIONS: "저자 명시",
  REVIEWER_CRITICISMS: "리뷰어 지적", USER_OBSERVATIONS: "내가 본 것", USER_CONTEXT: "내 맥락",
  REPRODUCIBILITY: "재현 정보", UNKNOWN: "기타 heading",
};

type SectionChipProps = { type: string; present: boolean; explicitEmpty?: boolean };
function missingLabel(reason: string) {
  if (reason === "section_missing") return "없음: 해당 section이 원문에 없습니다.";
  if (reason === "source_unavailable") return "근거 부족: 선택 원문을 사용할 수 없습니다.";
  if (reason === "no_quote_found") return "근거 부족: 질문에 답할 인용 문장을 찾지 못했습니다.";
  return "근거 부족: 확인되지 않은 상태입니다.";
}

function SectionChip({ type, present, explicitEmpty }: SectionChipProps) {
  return <span className={cn("border px-2 py-1 font-mono text-[9px]", present ? "border-zinc-500 text-zinc-200" : "border-zinc-800 text-zinc-600")}>
    {present ? <Check className="mr-1 inline h-3 w-3" /> : "— "}{sectionLabels[type] ?? type}{explicitEmpty ? " · EMPTY" : ""}
  </span>;
}

export default function NoteLibraryView({ authenticated, onSignIn }: { authenticated: boolean; onSignIn: () => void }) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | undefined>();
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedInferenceNoteIds, setSelectedInferenceNoteIds] = useState<string[]>([]);
  const [inferenceQuestion, setInferenceQuestion] = useState("선택한 논문에서 저자가 인정한 한계와 리뷰어 지적을 각각 추출해 비교해줘.");
  const [inferenceResult, setInferenceResult] = useState<Awaited<ReturnType<typeof trpc.notes.inference.useMutation>>["data"]>(undefined);
  const [collectionName, setCollectionName] = useState("");
  const [collectionDescription, setCollectionDescription] = useState("");
  const libraryQuery = trpc.notes.library.useQuery({ collectionId: selectedCollectionId }, { enabled: authenticated });
  const noteQuery = trpc.notes.get.useQuery({ noteId: selectedNoteId ?? "none" }, { enabled: authenticated && Boolean(selectedNoteId) });
  const library = libraryQuery.data;
  const selectedNote = noteQuery.data;
  const sourceQuery = trpc.notes.source.useQuery({ noteId: selectedNoteId ?? "none" }, { enabled: authenticated && Boolean(selectedNoteId) });
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

  const inference = trpc.notes.inference.useMutation({
    onSuccess: result => { setInferenceResult(result); void utils.notes.inferenceRuns.invalidate(); toast.success("원문 근거 기반 추론을 완료했습니다."); },
    onError: error => toast.error(error.message),
  });

  const ingest = trpc.notes.ingest.useMutation({
    onSuccess: async result => {
      await utils.notes.library.invalidate({ collectionId: selectedCollectionId });
      const firstNoteId = result.results.find(item => typeof item.noteId === "string")?.noteId;
      if (typeof firstNoteId === "string") setSelectedNoteId(firstNoteId);
      if (inputRef.current) inputRef.current.value = "";
      toast.success(`${result.metrics.parsed}개 파일을 파싱했습니다${result.metrics.failed ? ` · 실패 ${result.metrics.failed}건` : ""}.`);
    },
    onError: error => toast.error(error.message),
  });

  useEffect(() => {
    if (!selectedCollectionId && library?.inboxId) setSelectedCollectionId(library.inboxId);
    if (!selectedNoteId && library?.notes[0]) setSelectedNoteId(library.notes[0].id);
    if (!selectedInferenceNoteIds.length && library?.notes[0]) setSelectedInferenceNoteIds([library.notes[0].id]);
    if (selectedNoteId && library && !library.notes.some(note => note.id === selectedNoteId)) setSelectedNoteId(library.notes[0]?.id ?? null);
  }, [library?.inboxId, library?.notes.length, selectedCollectionId, selectedNoteId]);

  const selectedCollection = library?.collections.find(collection => collection.id === selectedCollectionId);
  const sectionByType = useMemo(() => new Map((selectedNote?.latestVersion?.sections ?? []).map(section => [section.sectionType, section])), [selectedNote?.latestVersion?.id]);
  const readFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    if (files.length > 20) { toast.error("한 번에 20개 파일까지 업로드할 수 있습니다."); return; }
    const inputs: Array<{ name: string; content: string }> = [];
    for (const file of Array.from(files)) {
      if (!file.name.toLocaleLowerCase().endsWith(".md")) continue;
      inputs.push({ name: file.webkitRelativePath || file.name, content: await file.text() });
    }
    if (!inputs.length) { toast.error(".md 파일을 하나 이상 선택해 주세요."); return; }
    ingest.mutate({ collectionId: selectedCollectionId, files: inputs });
  };

  if (!authenticated) return <section className="mx-auto max-w-[1520px] p-4 md:p-10"><div className="border border-zinc-700 bg-zinc-950/90 p-8 md:p-12"><div className="flex items-center gap-3"><LockKeyhole className="h-5 w-5 text-zinc-300" /><p className="meta-face text-[10px] text-zinc-400">PRIVATE NOTE LIBRARY / ACCOUNT REQUIRED</p></div><h1 className="display-face mt-6 max-w-3xl text-5xl leading-[0.9] tracking-[-0.05em] text-zinc-100 md:text-7xl">YOUR NOTES.<br /><span className="text-zinc-600">YOUR SCOPE.</span></h1><p className="mt-6 max-w-xl text-sm leading-6 text-zinc-400">문서 library는 사용자별 private workspace에 저장됩니다. 로그인하면 여러 연구 Collection과 Markdown 버전을 다른 사용자와 분리해 관리할 수 있습니다. 게스트 seed 수집은 계속 사용할 수 있습니다.</p><Button onClick={onSignIn} className="mt-8 h-11 rounded-none bg-zinc-100 px-5 text-xs font-black text-zinc-950 hover:bg-zinc-300"><LockKeyhole className="mr-2 h-4 w-4" />계정으로 문서 library 열기</Button></div></section>;

  const selectedWarnings = selectedNote?.latestVersion?.warnings ?? [];
  const noteSections = selectedNote?.latestVersion?.sections ?? [];
  const noteLinks = selectedNote?.latestVersion?.links ?? [];
  return <section className="mx-auto max-w-[1520px] p-4 md:p-8 lg:p-10">
    <div className="reveal grid gap-6 border-b border-zinc-700 pb-8 xl:grid-cols-[minmax(0,1fr)_360px]"><div><p className="meta-face text-[10px] text-zinc-500">MODULE 02 / PRIVATE MARKDOWN LIBRARY</p><h1 className="display-face mt-4 max-w-4xl text-5xl leading-[0.88] tracking-[-0.06em] text-zinc-100 sm:text-7xl">STORE<br /><span className="text-zinc-500">THE EVIDENCE.</span></h1><p className="mt-5 max-w-2xl text-sm leading-6 text-zinc-400">Obsidian에서 관리하던 Markdown을 원본 그대로 업로드하고, workspace·Collection·version·section 단위로 분리해 검토합니다. 선택한 문서의 source version과 원문 section만 사용해 추론하며, AI 결과는 원본 Markdown과 분리해 저장합니다.</p></div><div className="bg-zinc-200 p-5 text-zinc-950"><p className="meta-face text-[10px] text-zinc-600">WORKSPACE / PRIVATE</p><p className="mt-2 text-lg font-extrabold">{library?.workspace.name ?? "Loading workspace"}</p><div className="mt-5 grid grid-cols-2 gap-5"><div><p className="meta-face text-[9px] text-zinc-600">NOTES</p><p className="mt-1 text-3xl font-black">{library?.metrics.noteCount ?? 0}</p></div><div><p className="meta-face text-[9px] text-zinc-600">WARNINGS</p><p className="mt-1 text-3xl font-black">{library?.metrics.warningCount ?? 0}</p></div></div></div></div>

    <div className="mt-8 grid gap-6 xl:grid-cols-[235px_minmax(0,1fr)_340px]">
      <aside className="border border-zinc-700 bg-zinc-950/85 p-5"><div className="flex items-center justify-between"><div><p className="meta-face text-[10px] text-zinc-500">COLLECTIONS</p><p className="mt-2 text-sm font-extrabold">연구 주제 묶음</p></div><FolderPlus className="h-4 w-4 text-zinc-500" /></div><div className="mt-5 space-y-1">{library?.collections.map(collection => <button key={collection.id} onClick={() => setSelectedCollectionId(collection.id)} className={cn("w-full border p-3 text-left transition-colors", selectedCollectionId === collection.id ? "border-zinc-200 bg-zinc-800" : "border-transparent hover:border-zinc-700 hover:bg-zinc-900")}><p className="truncate text-xs font-bold text-zinc-200">{collection.name}</p><p className="mt-1 text-[10px] leading-4 text-zinc-500">{collection.description ?? "Private collection"}</p></button>)}</div><div className="mt-6 border-t border-zinc-800 pt-5"><Label htmlFor="collection-name" className="meta-face text-[9px] text-zinc-500">NEW COLLECTION</Label><Input id="collection-name" value={collectionName} onChange={event => setCollectionName(event.target.value)} placeholder="예: LLM calibration" className="mt-2 h-9 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100 placeholder:text-zinc-700" /><Input aria-label="Collection 설명" value={collectionDescription} onChange={event => setCollectionDescription(event.target.value)} placeholder="짧은 설명 (선택)" className="mt-2 h-9 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100 placeholder:text-zinc-700" /><Button disabled={!collectionName.trim() || createCollection.isPending} onClick={() => createCollection.mutate({ name: collectionName, description: collectionDescription || undefined })} className="mt-2 h-9 w-full rounded-none bg-zinc-700 text-[10px] font-black text-zinc-100 hover:bg-zinc-600"><Plus className="mr-1.5 h-3 w-3" />{createCollection.isPending ? "생성 중" : "Collection 생성"}</Button></div></aside>

      <div className="min-w-0 space-y-6"><section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/15 pb-4"><div><p className="meta-face text-[10px] text-zinc-500">INGEST / READ-ONLY SOURCE</p><h2 className="mt-2 text-xl font-extrabold text-white">Markdown 가져오기</h2></div><Button variant="outline" onClick={() => inputRef.current?.click()} disabled={ingest.isPending} className="h-9 rounded-none border-zinc-600 bg-transparent text-xs text-zinc-200 hover:bg-zinc-800"><Upload className="mr-2 h-3.5 w-3.5" />{ingest.isPending ? "파싱 중" : "파일 선택"}</Button><input ref={inputRef} type="file" accept=".md,text/markdown" multiple className="hidden" onChange={event => void readFiles(event.target.files)} /></div><p className="mt-4 text-xs leading-5 text-zinc-500">현재 대상: <strong className="text-zinc-300">{selectedCollection?.name ?? "Inbox"}</strong>. 원본 파일은 수정하지 않고, 업로드된 파일의 hash와 version을 저장합니다. 파일당 700KB, batch당 20개·4MB까지입니다.</p><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><div className="border border-zinc-800 bg-zinc-900 p-3"><p className="meta-face text-[9px] text-zinc-500">NOTES</p><p className="mt-1 text-2xl font-black">{library?.metrics.noteCount ?? 0}</p></div><div className="border border-zinc-800 bg-zinc-900 p-3"><p className="meta-face text-[9px] text-zinc-500">VERSIONS</p><p className="mt-1 text-2xl font-black">{library?.metrics.versionCount ?? 0}</p></div><div className="border border-zinc-800 bg-zinc-900 p-3"><p className="meta-face text-[9px] text-zinc-500">WARNINGS</p><p className="mt-1 text-2xl font-black">{library?.metrics.warningCount ?? 0}</p></div><div className="border border-zinc-800 bg-zinc-900 p-3"><p className="meta-face text-[9px] text-zinc-500">SYNC</p><p className="mt-1 text-xs font-black text-zinc-300">{libraryQuery.isFetching ? "UPDATING" : "CURRENT"}</p></div></div></section>

        <section className="border border-zinc-700 bg-zinc-950/85 p-5 md:p-7"><div className="flex items-center justify-between border-b border-white/15 pb-4"><div><p className="meta-face text-[10px] text-zinc-500">DOCUMENT INDEX / {selectedCollection?.name ?? "ALL"}</p><h2 className="mt-2 text-xl font-extrabold text-white">논문 Markdown</h2></div><FileText className="h-5 w-5 text-zinc-500" /></div>{!library?.notes.length ? <div className="border-b border-zinc-800 py-12 text-center"><FileText className="mx-auto h-6 w-6 text-zinc-600" /><p className="mt-3 text-sm font-bold text-zinc-400">아직 업로드한 문서가 없습니다.</p><p className="mt-1 text-xs text-zinc-600">Obsidian에서 기존 `.md` 파일을 선택해 시작하세요.</p></div> : <div className="divide-y divide-zinc-800">{library.notes.map(note => <button key={note.id} onClick={() => setSelectedNoteId(note.id)} className={cn("grid w-full gap-3 p-4 text-left transition-colors md:grid-cols-[minmax(0,1fr)_110px]", selectedNoteId === note.id ? "bg-zinc-800" : "hover:bg-zinc-900")}><div className="min-w-0"><div className="flex items-center gap-2"><FileText className="h-4 w-4 shrink-0 text-zinc-500" /><p className="truncate text-sm font-extrabold text-zinc-100">{note.title}</p>{note.warnings.length > 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}</div><p className="mt-1 truncate pl-6 font-mono text-[10px] text-zinc-600">{note.sourcePath} · {note.contentHash?.slice(0, 12) ?? "NO VERSION"}</p><div className="mt-3 flex flex-wrap gap-1 pl-6">{SECTION_ORDER.map(type => <SectionChip key={type} type={type} present={note.warnings.every(warning => !warning.includes(`section_missing:${type}`))} />)}</div></div><div className="text-right"><p className="meta-face text-[9px] text-zinc-500">VERSIONS</p><p className="mt-1 text-lg font-black text-zinc-200">{note.versionCount}</p><p className="mt-2 truncate text-[10px] text-zinc-500">{note.externalId ?? "ID 없음"}</p></div></button>)}</div>}</section></div>

      <aside className="space-y-6"><section className="border border-zinc-700 bg-zinc-950/85 p-5"><div className="flex items-center justify-between border-b border-white/15 pb-4"><div><p className="meta-face text-[10px] text-zinc-500">SOURCE INSPECTOR</p><p className="mt-2 text-sm font-extrabold">원문 구조 확인</p></div><Button variant="ghost" onClick={() => selectedNoteId && void utils.notes.get.invalidate({ noteId: selectedNoteId })} className="h-8 w-8 rounded-none p-0 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"><RefreshCw className="h-3.5 w-3.5" /></Button></div>{!selectedNote ? <p className="py-8 text-xs leading-5 text-zinc-600">왼쪽 문서를 선택하면 파싱된 원문 section과 warning을 확인할 수 있습니다.</p> : <div className="mt-5"><p className="text-lg font-extrabold leading-6 text-zinc-100">{selectedNote.title}</p><p className="mt-2 break-all font-mono text-[10px] text-zinc-600">{selectedNote.sourcePath}</p><div className="mt-5 flex flex-wrap gap-1.5">{SECTION_ORDER.map(type => <SectionChip key={type} type={type} present={Boolean(sectionByType.get(type))} explicitEmpty={sectionByType.get(type)?.explicitEmpty} />)}</div>{selectedWarnings.length > 0 && <div className="mt-5 border-l-2 border-zinc-500 bg-zinc-900 p-3"><p className="meta-face text-[9px] text-zinc-500">PARSE WARNINGS / {selectedWarnings.length}</p><div className="mt-2 space-y-1">{selectedWarnings.map(warning => <p key={warning} className="break-words text-[10px] leading-4 text-zinc-400">{warning}</p>)}</div></div>}<div className="mt-6 space-y-3">{noteSections.map(section => <article key={section.id} className="border-t border-zinc-800 pt-3"><p className="meta-face text-[9px] text-zinc-500">{sectionLabels[section.sectionType] ?? section.rawHeading} <span className="ml-2 text-zinc-700">/ {section.rawHeading}</span></p><p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-zinc-400">{section.body || "(empty)"}</p></article>)}</div>{noteLinks.length > 0 && <div className="mt-6 border-t border-zinc-800 pt-4"><div className="flex items-center gap-2"><Link2 className="h-3.5 w-3.5 text-zinc-500" /><p className="meta-face text-[9px] text-zinc-500">INDEXED LINKS / {noteLinks.length}</p></div><div className="mt-3 space-y-2">{noteLinks.map(link => <div key={link.id} className="border border-zinc-800 bg-zinc-900 p-2"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-zinc-400">{link.linkType}</span><span className="font-mono text-[9px] text-zinc-600">{link.sourceLocator}</span></div><p className="mt-1 break-all text-[10px] leading-4 text-zinc-500">{link.label ? `${link.label}: ` : ""}{link.target}</p></div>)}</div></div>}{source && <details className="mt-6 border-t border-zinc-800 pt-3"><summary className="cursor-pointer list-none"><p className="meta-face text-[9px] text-zinc-500">RAW MARKDOWN / READ ONLY</p><p className="mt-1 text-[10px] text-zinc-600">원문 파일을 펼쳐 확인</p></summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words bg-zinc-900 p-3 text-[10px] leading-4 text-zinc-500">{source.content}</pre></details>}</div>}</section><section className="border border-zinc-700 bg-zinc-950/85 p-5"><div className="flex items-center gap-3 border-b border-white/15 pb-4"><BrainCircuit className="h-4 w-4 text-zinc-300" /><div><p className="meta-face text-[10px] text-zinc-500">EVIDENCE-FIRST / MANUAL RUN</p><p className="mt-2 text-sm font-extrabold text-zinc-100">선택 노트로 추론</p></div></div><p className="mt-4 text-xs leading-5 text-zinc-500">원문 section을 먼저 고정합니다. `저자 명시`와 `리뷰어 지적`은 분리하고, 인용을 검증할 수 없는 문장은 저장하지 않습니다.</p><div className="mt-4 space-y-2">{(library?.notes ?? []).map(note => <label key={note.id} className="flex cursor-pointer items-center gap-2 border border-zinc-800 bg-zinc-900 p-2"><input type="checkbox" checked={selectedInferenceNoteIds.includes(note.id)} onChange={event => setSelectedInferenceNoteIds(previous => event.target.checked ? Array.from(new Set(previous.concat(note.id))) : previous.filter(id => id !== note.id))} className="h-3.5 w-3.5 accent-zinc-200" /><span className="truncate text-[11px] text-zinc-300">{note.title}</span></label>)}</div><Input value={inferenceQuestion} onChange={event => setInferenceQuestion(event.target.value)} className="mt-4 h-10 rounded-none border-zinc-700 bg-zinc-900 text-xs text-zinc-100" /><Button disabled={!selectedInferenceNoteIds.length || inferenceQuestion.trim().length < 10 || inference.isPending} onClick={() => inference.mutate({ noteIds: selectedInferenceNoteIds, question: inferenceQuestion })} className="mt-3 h-10 w-full rounded-none bg-zinc-100 text-xs font-black text-zinc-950 hover:bg-zinc-300"><BrainCircuit className="mr-2 h-3.5 w-3.5" />{inference.isPending ? "근거 검색·추론 중" : "근거 기반 추론 실행"}</Button>{inferenceResult && <div className="mt-5 border-t border-zinc-800 pt-4"><div className="flex items-center justify-between"><p className="meta-face text-[9px] text-zinc-500">RUN / {inferenceResult.status}</p><span className="text-[10px] text-zinc-600">{inferenceResult.result.claims.length} claims · {inferenceResult.result.missing.length} missing</span></div><div className="mt-3 space-y-3">{inferenceResult.result.claims.map((claim, index) => <article key={`${claim.noteId}-${index}`} className="border border-zinc-800 bg-zinc-900 p-3"><p className="text-[10px] font-bold text-zinc-200">{claim.sectionType} · {claim.supportStatus}</p><p className="mt-2 text-xs leading-5 text-zinc-400">{claim.answer}</p>{claim.evidence.map(evidence => <blockquote key={evidence.evidenceId} className="mt-2 border-l border-zinc-500 pl-2 text-[10px] leading-4 text-zinc-500">“{evidence.quote}”<br /><span className="font-mono text-zinc-600">{evidence.rawHeading} · {evidence.versionId.slice(0, 8)}</span></blockquote>)}</article>)}{inferenceResult.result.missing.map((missing, index) => <p key={`${missing.noteId}-${index}`} className="border border-dashed border-zinc-700 p-2 text-[10px] leading-4 text-zinc-500"><span className="font-mono text-zinc-600">{missing.noteId.slice(0, 8)} / {sectionLabels[missing.sectionType] ?? missing.sectionType}</span><br />{missingLabel(missing.reason)}</p>)}</div></div>}</section><section className="border border-zinc-700 bg-zinc-900/70 p-5"><p className="meta-face text-[10px] text-zinc-500">NEXT LOCK</p><div className="mt-4 flex gap-3"><ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" /><p className="text-xs leading-5 text-zinc-400"><strong className="text-zinc-200">Citation graph / OpenReview / T1–T2</strong><br />현재 단계에서는 실행하지 않습니다. source-backed note library와 inference 기록을 기반으로 다음 모듈에서 활성화합니다.</p></div></section></aside>
    </div>
  </section>;
}
