/**
 * `pnpm storage:orphans` — prints object-storage keys whose note was deleted but whose raw
 * Markdown copy is still in S3, because the Forge storage helpers expose no delete path.
 */
import { listUnpurgedStorageObjects } from "./noteDb";

listUnpurgedStorageObjects()
  .then(rows => {
    if (!rows.length) {
      console.log("정리 대기 중인 storage key가 없습니다.");
      return;
    }
    console.log(`정리 대기 ${rows.length}건:\n`);
    for (const row of rows) {
      console.log(`  ${row.storageKey}`);
      console.log(
        `    note=${row.noteId} workspace=${row.workspaceId} deleted=${row.createdAt.toISOString()}`
      );
    }
    console.log(
      "\nForge에 delete 경로가 생기면 markStorageObjectsPurged()로 처리 표시하세요."
    );
  })
  .catch(error => {
    console.error("조회 실패:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
