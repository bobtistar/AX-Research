/**
 * `pnpm eval` — runs the frozen gold set through the current prompt policy, prints the
 * score, and appends one row to `eval/results.tsv`.
 *
 * The loop this serves: edit `server/inferencePrompt.ts` → `pnpm eval` → keep the change if
 * the score improved by more than the measured noise, otherwise revert.
 *
 * Flags:
 *   --repeat N   run the whole set N times and report mean ± stdev (do this first)
 *   --limit N    score only the first N cases
 *   --label TXT  free-text note stored with the row
 *   --dry-run    build prompts and count cells without calling the model
 *   --gold DIR   score a different gold directory (default eval/gold; use for a hold-out)
 *
 * The budget here is calls, not wall clock: one call per gold case per repeat. There is no
 * temperature control on the gateway, so repeated runs of an unchanged prompt will differ —
 * which is exactly why --repeat exists.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { invokeLLM } from "./_core/llm";
import {
  buildInferenceMessages,
  INFERENCE_PROMPT_VERSION,
  inferenceResponseSchema,
  MAX_INFERENCE_TOKENS,
  resolveTargetSections,
  selectEvidence,
} from "./inferencePrompt";
import {
  resolveInferenceModel,
  validateInferenceClaims,
} from "./inferenceService";
import {
  aggregate,
  claimsWithQuotes,
  goldCaseSections,
  loadGoldCases,
  mean,
  scoreGoldCase,
  stdev,
  type CaseScore,
  type EvalMetrics,
} from "./inferenceEval";

const RESULTS_PATH = resolve(process.cwd(), "eval/results.tsv");

const HEADER = [
  "timestamp",
  "commit",
  "promptVersion",
  "model",
  "goldSetVersion",
  "cases",
  "cells",
  "scoredCells",
  "score",
  "scoreStdev",
  "repeats",
  "fabrication",
  "confusion",
  "miss",
  "missingAccuracy",
  "matched",
  "correctAbsent",
  "trivialAbsent",
  "fabricated",
  "confused",
  "misquoted",
  "missed",
  "uncovered",
  "failedCases",
  "label",
].join("\t");

const GOLD_DIR = () => resolve(process.cwd(), flag("gold") || "eval/gold");

function flag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? "") : undefined;
}

function commitHash() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "nogit";
  }
}

type ModelResult = Parameters<typeof validateInferenceClaims>[0];

async function runOnce(
  model: string,
  dryRun: boolean,
  limit?: number
): Promise<CaseScore[]> {
  const goldCases = loadGoldCases(GOLD_DIR()).slice(0, limit ?? undefined);
  if (!goldCases.length)
    throw new Error(
      "gold set이 비어 있습니다. 먼저 홈페이지에서 추론 결과를 검토하고 `pnpm eval:export`를 실행하세요."
    );

  const scores: CaseScore[] = [];
  for (const goldCase of goldCases) {
    const evidence = selectEvidence(goldCaseSections(goldCase));
    // Scope is re-derived from the live policy, not read from the case, so a change to the
    // scoping rules is itself under test.
    const targetSections = resolveTargetSections(goldCase.question);
    const noteIds = goldCase.notes.map(note => note.noteId);
    const missingSections = noteIds.flatMap(noteId =>
      targetSections
        .filter(
          type =>
            !evidence.some(
              item => item.noteId === noteId && item.sectionType === type
            )
        )
        .map(sectionType => ({ noteId, sectionType }))
    );
    const messages = buildInferenceMessages({
      question: goldCase.question,
      targetSections,
      evidence,
      missingSections,
    });

    if (dryRun) {
      console.log(
        `  ${goldCase.id} — evidence ${evidence.length}, scope ${targetSections.join(",")}, prompt ${JSON.stringify(messages).length}자`
      );
      continue;
    }

    try {
      const response = await invokeLLM({
        model,
        messages,
        maxTokens: MAX_INFERENCE_TOKENS,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "evidence_inference",
            strict: true,
            schema: inferenceResponseSchema(),
          },
        },
      });
      const content = response.choices?.[0]?.message?.content;
      const parsed = JSON.parse(
        typeof content === "string" ? content : "{}"
      ) as ModelResult;
      // The same referee the product uses, so eval cannot score claims the app would reject.
      const valid = validateInferenceClaims(
        { claims: parsed.claims ?? [], missing: parsed.missing ?? [] },
        noteIds,
        evidence
      );
      scores.push(
        scoreGoldCase({
          goldCase,
          claims: claimsWithQuotes(valid, evidence),
          resolvedSections: targetSections,
          evidenceCells: new Set(
            evidence.map(item => `${item.noteId}:${item.sectionType}`)
          ),
        })
      );
    } catch (error) {
      // A failed case is recorded, never silently dropped: dropping it would quietly raise
      // the score of a prompt that makes the model fail more often.
      scores.push({
        caseId: goldCase.id,
        resolvedSections: targetSections,
        cells: [],
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return scores;
}

function report(metrics: EvalMetrics, label: string) {
  const { tally } = metrics;
  console.log(`\n${label}`);
  console.log(`  score            ${metrics.score.toFixed(4)}`);
  console.log(`  환각률           ${metrics.fabricationRate.toFixed(4)}`);
  console.log(`  section 혼동률   ${metrics.confusionRate.toFixed(4)}`);
  console.log(`  과보수율         ${metrics.missRate.toFixed(4)}`);
  console.log(`  missing 정확도   ${metrics.missingAccuracy.toFixed(4)}`);
  console.log(
    `  scored ${tally.scored}/${tally.total} cells = matched ${tally.MATCHED} · absent ${tally.CORRECT_ABSENT} · fabricated ${tally.FABRICATED} · confused ${tally.CONFUSED} · misquoted ${tally.MISQUOTED} · missed ${tally.MISSED} · uncovered ${tally.UNCOVERED}`
  );
  if (tally.TRIVIAL_ABSENT)
    console.log(
      `  제외 ${tally.TRIVIAL_ABSENT} — 근거 section 자체가 없어 계약상 답변이 불가능한 cell (점수에서 제외)`
    );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const repeats = Math.max(1, Number(flag("repeat") ?? 1) || 1);
  const limitRaw = Number(flag("limit") ?? 0);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  const label = flag("label") ?? "";

  const model = dryRun ? "(dry-run)" : await resolveInferenceModel();
  const goldSetVersion =
    loadGoldCases(GOLD_DIR())[0]?.goldSetVersion ?? "unknown";

  console.log(
    `gold set ${GOLD_DIR()}\nprompt ${INFERENCE_PROMPT_VERSION} · model ${model} · repeats ${repeats}${limit ? ` · limit ${limit}` : ""}`
  );

  const perRepeat: EvalMetrics[] = [];
  let failedCases = 0;
  for (let index = 0; index < repeats; index += 1) {
    const scores = await runOnce(model, dryRun, limit);
    if (dryRun) return;
    failedCases += scores.filter(item => item.error).length;
    for (const item of scores) {
      if (item.error) console.warn(`  ! ${item.caseId} 실패 — ${item.error}`);
    }
    const metrics = aggregate(scores);
    perRepeat.push(metrics);
    if (repeats > 1) report(metrics, `repeat ${index + 1}/${repeats}`);
  }

  const scores = perRepeat.map(metrics => metrics.score);
  const spread = stdev(scores);
  const last = perRepeat[perRepeat.length - 1];
  const averaged: EvalMetrics = {
    ...last,
    score: mean(scores),
    fabricationRate: mean(perRepeat.map(m => m.fabricationRate)),
    confusionRate: mean(perRepeat.map(m => m.confusionRate)),
    missRate: mean(perRepeat.map(m => m.missRate)),
    missingAccuracy: mean(perRepeat.map(m => m.missingAccuracy)),
  };
  report(averaged, repeats > 1 ? `평균 (n=${repeats})` : "결과");
  if (repeats > 1) {
    console.log(`  표준편차         ${spread.toFixed(4)}`);
    console.log(
      `\n다음 실험에서 점수가 ${(2 * spread).toFixed(4)} 이상 움직이지 않으면 노이즈와 구분할 수 없습니다.`
    );
  }

  mkdirSync(resolve(process.cwd(), "eval"), { recursive: true });
  if (!existsSync(RESULTS_PATH))
    writeFileSync(RESULTS_PATH, `${HEADER}\n`, "utf-8");
  const row = [
    new Date().toISOString(),
    commitHash(),
    INFERENCE_PROMPT_VERSION,
    model,
    goldSetVersion,
    loadGoldCases(GOLD_DIR()).slice(0, limit ?? undefined).length,
    averaged.tally.total,
    averaged.tally.scored,
    averaged.score.toFixed(4),
    spread.toFixed(4),
    repeats,
    averaged.fabricationRate.toFixed(4),
    averaged.confusionRate.toFixed(4),
    averaged.missRate.toFixed(4),
    averaged.missingAccuracy.toFixed(4),
    last.tally.MATCHED,
    last.tally.CORRECT_ABSENT,
    last.tally.TRIVIAL_ABSENT,
    last.tally.FABRICATED,
    last.tally.CONFUSED,
    last.tally.MISQUOTED,
    last.tally.MISSED,
    last.tally.UNCOVERED,
    failedCases,
    label.replace(/\s+/g, " "),
  ].join("\t");
  appendFileSync(RESULTS_PATH, `${row}\n`, "utf-8");
  console.log(`\n${RESULTS_PATH}에 기록했습니다.`);
}

main().catch(error => {
  console.error("평가 실패:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
