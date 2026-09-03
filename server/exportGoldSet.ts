/**
 * `pnpm eval:export` — freezes reviewed inference runs into `eval/gold/*.json`.
 *
 * Rerunning is safe: each run writes to its own file and overwrites the previous export, so
 * new verdicts on an already-exported run widen its case instead of duplicating it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectGoldCases } from "./goldSet";

const GOLD_DIR = resolve(process.cwd(), "eval/gold");

collectGoldCases()
  .then(({ cases, skipped, reviewedRuns }) => {
    if (reviewedRuns === 0) {
      console.log(
        "검토된 추론 실행이 없습니다. 홈페이지에서 claim·missing을 승인하거나 거부한 뒤 다시 실행하세요."
      );
      return;
    }
    mkdirSync(GOLD_DIR, { recursive: true });

    let supported = 0;
    let absent = 0;
    for (const goldCase of cases) {
      writeFileSync(
        resolve(GOLD_DIR, `${goldCase.id}.json`),
        `${JSON.stringify(goldCase, null, 2)}\n`,
        "utf-8"
      );
      for (const cell of goldCase.cells) {
        if (cell.label === "SUPPORTED") supported += 1;
        else absent += 1;
      }
      console.log(
        `  ${goldCase.id}.json — cells ${goldCase.cells.length}, notes ${goldCase.notes.length}, prompt ${goldCase.provenance.promptVersion}`
      );
    }

    console.log(
      `\n검토된 실행 ${reviewedRuns}건 중 ${cases.length}건을 ${GOLD_DIR}에 저장했습니다.`
    );
    console.log(`  SUPPORTED ${supported} · ABSENT ${absent}`);

    if (skipped.length) {
      console.log(`\n라벨로 변환하지 못한 검토 ${skipped.length}건:`);
      for (const item of skipped) {
        console.log(
          `  run=${item.runId} ${item.targetKind}/${item.noteId}/${item.sectionType} — ${item.reason}`
        );
      }
    }

    if (supported + absent < 20) {
      console.log(
        "\n주의: 라벨이 20개 미만입니다. 이 크기에서는 점수 변화가 대부분 노이즈입니다. 먼저 `pnpm eval --repeat 3`으로 분산을 측정하세요."
      );
    }
    if (absent === 0 || supported === 0) {
      console.log(
        "주의: SUPPORTED 또는 ABSENT 한쪽이 비어 있습니다. 환각률과 과보수율 중 하나는 측정되지 않습니다."
      );
    }
  })
  .catch(error => {
    console.error(
      "gold set 내보내기 실패:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  });
